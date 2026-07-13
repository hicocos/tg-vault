import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
    ChunkUploadSessionStore,
    PostgresChunkUploadSessionRepository,
    writeChunkAtomically,
    type ChunkRecordResult,
    type ChunkUploadChunk,
    type ChunkUploadCompletionClaim,
    type ChunkUploadSession,
    type ChunkUploadSessionRepository,
} from './chunkUploadSessions.js';

function session(overrides: Partial<ChunkUploadSession> = {}): ChunkUploadSession {
    return {
        uploadId: '11111111-1111-4111-8111-111111111111',
        ownerId: 'owner-a',
        filename: 'large.bin',
        mimeType: 'application/octet-stream',
        folder: null,
        totalSize: 12,
        totalChunks: 2,
        receivedBytes: 0,
        status: 'open',
        targetProvider: 'local',
        targetAccountId: null,
        expiresAt: new Date(Date.now() + 60_000),
        completionToken: null,
        completedFileId: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

class MemoryRepository implements ChunkUploadSessionRepository {
    readonly sessions = new Map<string, ChunkUploadSession>();
    readonly chunks = new Map<string, ChunkUploadChunk>();

    async createSession(value: ChunkUploadSession): Promise<void> {
        this.sessions.set(value.uploadId, structuredClone(value));
    }

    async reserveSession(value: ChunkUploadSession, globalBudgetBytes: number): Promise<boolean> {
        const reserved = [...this.sessions.values()]
            .filter(item => ['open', 'completing', 'failed'].includes(item.status))
            .reduce((sum, item) => sum + item.totalSize, 0);
        if (reserved + value.totalSize > globalBudgetBytes) return false;
        this.sessions.set(value.uploadId, structuredClone(value));
        return true;
    }

    async getReservedBytes(): Promise<number> {
        return [...this.sessions.values()]
            .filter(item => ['open', 'completing', 'failed'].includes(item.status))
            .reduce((sum, item) => sum + item.totalSize, 0);
    }

    async getSession(uploadId: string, ownerId: string): Promise<ChunkUploadSession | null> {
        const value = this.sessions.get(uploadId);
        return value?.ownerId === ownerId ? structuredClone(value) : null;
    }

    async getChunk(uploadId: string, ownerId: string, index: number): Promise<ChunkUploadChunk | null> {
        const value = this.sessions.get(uploadId);
        if (!value || value.ownerId !== ownerId) return null;
        const chunk = this.chunks.get(`${uploadId}:${index}`);
        return chunk ? structuredClone(chunk) : null;
    }

    async listChunks(uploadId: string, ownerId: string): Promise<ChunkUploadChunk[]> {
        const value = this.sessions.get(uploadId);
        if (!value || value.ownerId !== ownerId) return [];
        return [...this.chunks.entries()]
            .filter(([key]) => key.startsWith(`${uploadId}:`))
            .map(([, chunk]) => structuredClone(chunk))
            .sort((a, b) => a.index - b.index);
    }

    async recordChunk(uploadId: string, ownerId: string, chunk: ChunkUploadChunk): Promise<ChunkRecordResult> {
        const value = this.sessions.get(uploadId);
        if (!value || value.ownerId !== ownerId || value.status !== 'open') return { status: 'rejected' };
        const key = `${uploadId}:${chunk.index}`;
        const current = this.chunks.get(key);
        if (current) {
            return current.size === chunk.size && current.sha256 === chunk.sha256
                ? { status: 'duplicate', chunk: structuredClone(current) }
                : { status: 'conflict', chunk: structuredClone(current) };
        }
        this.chunks.set(key, structuredClone(chunk));
        value.receivedBytes += chunk.size;
        this.sessions.set(uploadId, value);
        return { status: 'recorded', chunk: structuredClone(chunk) };
    }

    async claimCompletion(uploadId: string, ownerId: string, token: string): Promise<ChunkUploadCompletionClaim | null> {
        const value = this.sessions.get(uploadId);
        if (!value || value.ownerId !== ownerId || value.status !== 'open') return null;
        if (this.chunks.size !== value.totalChunks || value.receivedBytes !== value.totalSize) return null;
        value.status = 'completing';
        value.completionToken = token;
        this.sessions.set(uploadId, value);
        return { session: structuredClone(value), chunks: [...this.chunks.values()].map(chunk => structuredClone(chunk)) };
    }

    async markCompletionFailed(uploadId: string, ownerId: string, token: string, error: string): Promise<boolean> {
        const value = this.sessions.get(uploadId);
        if (!value || value.ownerId !== ownerId || value.status !== 'completing' || value.completionToken !== token) return false;
        value.status = 'failed';
        value.lastError = error;
        value.completionToken = null;
        this.sessions.set(uploadId, value);
        return true;
    }

    async reopenFailed(uploadId: string, ownerId: string): Promise<boolean> {
        const value = this.sessions.get(uploadId);
        if (!value || value.ownerId !== ownerId || value.status !== 'failed') return false;
        value.status = 'open';
        value.lastError = null;
        this.sessions.set(uploadId, value);
        return true;
    }

    async markCompleted(uploadId: string, ownerId: string, token: string, fileId: string): Promise<boolean> {
        const value = this.sessions.get(uploadId);
        if (!value || value.ownerId !== ownerId || value.status !== 'completing' || value.completionToken !== token) return false;
        value.status = 'completed';
        value.completedFileId = fileId;
        this.sessions.set(uploadId, value);
        return true;
    }

    async cancel(uploadId: string, ownerId: string): Promise<'cancelled' | 'busy' | 'terminal' | 'not_found'> {
        const value = this.sessions.get(uploadId);
        if (!value || value.ownerId !== ownerId) return 'not_found';
        if (value.status === 'completing') return 'busy';
        if (value.status === 'completed' || value.status === 'cancelled') return 'terminal';
        value.status = 'cancelled';
        this.sessions.set(uploadId, value);
        return 'cancelled';
    }
}

test('session metadata survives a store restart and remains owner scoped', async () => {
    const repository = new MemoryRepository();
    const firstProcess = new ChunkUploadSessionStore(repository);
    await firstProcess.create(session());

    const restartedProcess = new ChunkUploadSessionStore(repository);
    assert.equal((await restartedProcess.status(session().uploadId, 'owner-a'))?.filename, 'large.bin');
    assert.equal(await restartedProcess.status(session().uploadId, 'owner-b'), null);
});

test('session reservation enforces per-file and global temporary byte budgets', async () => {
    const repository = new MemoryRepository();
    const store = new ChunkUploadSessionStore(repository, {
        maxTotalBytes: 12,
        globalBudgetBytes: 20,
        diskReserveBytes: 5,
        getDiskFreeBytes: async () => 100,
    });

    await store.reserve(session({ uploadId: '11111111-1111-4111-8111-111111111111', totalSize: 12 }));
    await assert.rejects(
        store.reserve(session({ uploadId: '22222222-2222-4222-8222-222222222222', totalSize: 9 })),
        (error: unknown) => error instanceof Error && error.name === 'ChunkBudgetError',
    );
    await assert.rejects(
        store.reserve(session({ uploadId: '33333333-3333-4333-8333-333333333333', totalSize: 13 })),
        (error: unknown) => error instanceof Error && error.name === 'ChunkTotalSizeError',
    );
    assert.equal(await repository.getReservedBytes(), 12);
});

test('session reservation rejects uploads that would cross the disk reserve', async () => {
    const repository = new MemoryRepository();
    const store = new ChunkUploadSessionStore(repository, {
        maxTotalBytes: 100,
        globalBudgetBytes: 100,
        diskReserveBytes: 10,
        getDiskFreeBytes: async () => 20,
    });

    await assert.rejects(
        store.reserve(session({ totalSize: 11 })),
        (error: unknown) => error instanceof Error && error.name === 'ChunkDiskReserveError',
    );
    assert.equal(await repository.getReservedBytes(), 0);
});

test('chunk metadata is recorded only after the atomic file write finishes', async () => {
    const repository = new MemoryRepository();
    const store = new ChunkUploadSessionStore(repository);
    await store.create(session({ totalSize: 6, totalChunks: 1 }));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-vault-chunk-'));
    const finalPath = path.join(directory, 'chunk_0');
    let recordedAfterRename = false;
    const originalRecord = repository.recordChunk.bind(repository);
    repository.recordChunk = async (...args) => {
        recordedAfterRename = await fs.access(finalPath).then(() => true, () => false);
        return originalRecord(...args);
    };

    const result = await store.writeChunk({
        uploadId: session().uploadId,
        ownerId: 'owner-a',
        index: 0,
        expectedSize: 6,
        expectedSha256: crypto.createHash('sha256').update('abcdef').digest('hex'),
        finalPath,
        input: Readable.from(['abc', 'def']),
        maxChunkBytes: 10,
    });

    assert.equal(result.status, 'recorded');
    assert.equal(recordedAfterRename, true);
    assert.equal(await fs.readFile(finalPath, 'utf8'), 'abcdef');
    await fs.rm(directory, { recursive: true, force: true });
});

test('truncated chunk is rejected without metadata or final file', async () => {
    const repository = new MemoryRepository();
    const store = new ChunkUploadSessionStore(repository);
    await store.create(session({ totalSize: 6, totalChunks: 1 }));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-vault-chunk-'));
    const finalPath = path.join(directory, 'chunk_0');

    await assert.rejects(store.writeChunk({
        uploadId: session().uploadId,
        ownerId: 'owner-a',
        index: 0,
        expectedSize: 6,
        expectedSha256: crypto.createHash('sha256').update('abcdef').digest('hex'),
        finalPath,
        input: Readable.from(['abc']),
        maxChunkBytes: 10,
    }), /分块大小不匹配/);

    assert.equal(repository.chunks.size, 0);
    await assert.rejects(fs.access(finalPath));
    await fs.rm(directory, { recursive: true, force: true });
});

test('duplicate chunks are idempotent only when size and hash match', async () => {
    const repository = new MemoryRepository();
    const store = new ChunkUploadSessionStore(repository);
    await store.create(session({ totalSize: 6, totalChunks: 1 }));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-vault-chunk-'));
    const finalPath = path.join(directory, 'chunk_0');
    const hash = crypto.createHash('sha256').update('abcdef').digest('hex');

    assert.equal((await store.writeChunk({ uploadId: session().uploadId, ownerId: 'owner-a', index: 0, expectedSize: 6, expectedSha256: hash, finalPath, input: Readable.from(['abcdef']), maxChunkBytes: 10 })).status, 'recorded');
    assert.equal((await store.writeChunk({ uploadId: session().uploadId, ownerId: 'owner-a', index: 0, expectedSize: 6, expectedSha256: hash, finalPath, input: Readable.from(['abcdef']), maxChunkBytes: 10 })).status, 'duplicate');
    await assert.rejects(
        store.writeChunk({ uploadId: session().uploadId, ownerId: 'owner-a', index: 0, expectedSize: 6, expectedSha256: crypto.createHash('sha256').update('ghijkl').digest('hex'), finalPath, input: Readable.from(['ghijkl']), maxChunkBytes: 10 }),
        (error: unknown) => error instanceof Error && error.name === 'ChunkConflictError',
    );
    assert.equal((await store.status(session().uploadId, 'owner-a'))?.receivedBytes, 6);
    assert.equal(await fs.readFile(finalPath, 'utf8'), 'abcdef');
    await fs.rm(directory, { recursive: true, force: true });
});

test('only one complete caller wins the open to completing CAS', async () => {
    const repository = new MemoryRepository();
    const store = new ChunkUploadSessionStore(repository);
    await store.create(session({ totalSize: 6, totalChunks: 1 }));
    await repository.recordChunk(session().uploadId, 'owner-a', { index: 0, size: 6, sha256: 'a'.repeat(64), path: '/tmp/chunk', createdAt: new Date() });

    const [first, second] = await Promise.all([
        store.claimCompletion(session().uploadId, 'owner-a', 'token-a'),
        store.claimCompletion(session().uploadId, 'owner-a', 'token-b'),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
    assert.equal((await store.status(session().uploadId, 'owner-a'))?.status, 'completing');
});

test('cancel loses while completion owns the CAS lease', async () => {
    const repository = new MemoryRepository();
    const store = new ChunkUploadSessionStore(repository);
    await store.create(session({ totalSize: 6, totalChunks: 1 }));
    await repository.recordChunk(session().uploadId, 'owner-a', { index: 0, size: 6, sha256: 'a'.repeat(64), path: '/tmp/chunk', createdAt: new Date() });
    const claim = await store.claimCompletion(session().uploadId, 'owner-a', 'token-a');
    assert.ok(claim);

    assert.equal(await store.cancel(session().uploadId, 'owner-a'), 'busy');
    assert.equal((await store.status(session().uploadId, 'owner-a'))?.status, 'completing');
});

test('failed completion preserves chunks and can be retried', async () => {
    const repository = new MemoryRepository();
    const store = new ChunkUploadSessionStore(repository);
    await store.create(session({ totalSize: 6, totalChunks: 1 }));
    await repository.recordChunk(session().uploadId, 'owner-a', { index: 0, size: 6, sha256: 'a'.repeat(64), path: '/tmp/chunk', createdAt: new Date() });
    assert.ok(await store.claimCompletion(session().uploadId, 'owner-a', 'token-a'));

    assert.equal(await store.failCompletion(session().uploadId, 'owner-a', 'token-a', 'provider unavailable'), true);
    assert.equal((await store.status(session().uploadId, 'owner-a'))?.status, 'failed');
    assert.equal(repository.chunks.size, 1);
    assert.equal(await store.retryFailed(session().uploadId, 'owner-a'), true);
    assert.ok(await store.claimCompletion(session().uploadId, 'owner-a', 'token-b'));
});

test('postgres repository uses row locks and affected-row CAS for budget, complete and cancel', async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client = {
        query: async (text: string, params?: unknown[]) => {
            calls.push({ text, params });
            if (text.includes('SUM(total_size)')) return { rows: [{ reserved_bytes: '0' }], rowCount: 1 };
            if (text.includes('INSERT INTO chunk_upload_sessions')) return { rows: [], rowCount: 1 };
            if (text.includes("SET status = 'completing'")) return { rows: [{ ...session(), status: 'completing', completion_token: 'token-a' }], rowCount: 1 };
            if (text.includes('FROM chunk_upload_chunks')) return { rows: [], rowCount: 0 };
            if (text.includes('SELECT status FROM chunk_upload_sessions')) return { rows: [{ status: 'completing' }], rowCount: 1 };
            if (text.includes("status = 'cancelled'")) return { rows: [], rowCount: 0 };
            return { rows: [], rowCount: 1 };
        },
        release: () => undefined,
    };
    const repository = new PostgresChunkUploadSessionRepository({
        connect: async () => client,
        query: client.query,
    } as never);

    assert.equal(await repository.reserveSession(session(), 20), true);
    await repository.claimCompletion(session().uploadId, 'owner-a', 'token-a');
    assert.equal(await repository.cancel(session().uploadId, 'owner-a'), 'busy');
    const sql = calls.map(call => call.text).join('\n');
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.match(sql, /status = 'open'/);
    assert.match(sql, /completion_token IS NULL/);
    assert.match(sql, /FOR UPDATE/);
});
