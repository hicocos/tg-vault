import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';

export type ChunkUploadStatus = 'open' | 'completing' | 'completed' | 'cancelled' | 'failed';

export interface ChunkUploadSession {
    uploadId: string;
    ownerId: string;
    filename: string;
    mimeType: string;
    folder: string | null;
    totalSize: number;
    totalChunks: number;
    receivedBytes: number;
    status: ChunkUploadStatus;
    targetProvider: string;
    targetAccountId: string | null;
    expiresAt: Date;
    completionToken: string | null;
    completionExpiresAt: Date | null;
    completedFileId: string | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface ChunkUploadChunk {
    index: number;
    size: number;
    sha256: string;
    path: string;
    createdAt: Date;
}

export type ChunkRecordResult =
    | { status: 'recorded' | 'duplicate' | 'conflict'; chunk: ChunkUploadChunk }
    | { status: 'rejected' };

export interface ChunkUploadCompletionClaim {
    session: ChunkUploadSession;
    chunks: ChunkUploadChunk[];
}

export type ChunkCancelResult = 'cancelled' | 'busy' | 'terminal' | 'not_found';

export interface ChunkUploadSessionRepository {
    createSession(session: ChunkUploadSession): Promise<void>;
    reserveSession(session: ChunkUploadSession, globalBudgetBytes: number, diskFreeBytes?: number, diskReserveBytes?: number): Promise<boolean>;
    getReservedBytes(): Promise<number>;
    getSession(uploadId: string, ownerId: string): Promise<ChunkUploadSession | null>;
    listSessions?(ownerId: string): Promise<ChunkUploadSession[]>;
    getChunk(uploadId: string, ownerId: string, index: number): Promise<ChunkUploadChunk | null>;
    listChunks(uploadId: string, ownerId: string): Promise<ChunkUploadChunk[]>;
    recordChunk(uploadId: string, ownerId: string, chunk: ChunkUploadChunk): Promise<ChunkRecordResult>;
    claimCompletion(uploadId: string, ownerId: string, token: string, expiresAt: Date): Promise<ChunkUploadCompletionClaim | null>;
    renewCompletion(uploadId: string, ownerId: string, token: string, expiresAt: Date): Promise<boolean>;
    completeWithReconciliation(uploadId: string, ownerId: string, token: string, fileId: string, operationId: string): Promise<boolean>;
    markCompletionFailed(uploadId: string, ownerId: string, token: string, error: string): Promise<boolean>;
    reopenFailed(uploadId: string, ownerId: string): Promise<boolean>;
    markCompleted(uploadId: string, ownerId: string, token: string, fileId: string): Promise<boolean>;
    cancel(uploadId: string, ownerId: string): Promise<ChunkCancelResult>;
}

export interface ChunkUploadLimits {
    maxTotalBytes: number;
    globalBudgetBytes: number;
    diskReserveBytes: number;
    getDiskFreeBytes(): Promise<number>;
}

export class ChunkUploadProtocolError extends Error {
    constructor(name: string, message: string) {
        super(message);
        this.name = name;
    }
}

export async function writeChunkAtomically(input: {
    stream: Readable;
    finalPath: string;
    expectedSize: number;
    expectedSha256: string;
    maxChunkBytes: number;
}): Promise<ChunkUploadChunk> {
    await fsPromises.mkdir(path.dirname(input.finalPath), { recursive: true });
    const committedPath = `${input.finalPath}.${crypto.randomUUID()}.chunk`;
    const temporaryPath = `${committedPath}.part`;
    const lockPath = `${input.finalPath}.lock`;
    let lockHandle: fsPromises.FileHandle;
    try {
        lockHandle = await fsPromises.open(lockPath, 'wx');
    } catch (error: any) {
        if (error?.code === 'EEXIST') throw new ChunkUploadProtocolError('ChunkWriteBusyError', '同一分块正在写入，请稍后重试');
        throw error;
    }
    const hash = crypto.createHash('sha256');
    let size = 0;
    const counter = new (await import('node:stream')).Transform({
        transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > input.maxChunkBytes) return callback(new ChunkUploadProtocolError('ChunkTooLargeError', '单个分块过大'));
            hash.update(chunk);
            callback(null, chunk);
        },
    });
    try {
        await pipeline(input.stream, counter, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
        if (size !== input.expectedSize) throw new ChunkUploadProtocolError('ChunkSizeMismatchError', '分块大小不匹配');
        const sha256 = hash.digest('hex');
        if (sha256 !== input.expectedSha256.toLowerCase()) throw new ChunkUploadProtocolError('ChunkHashMismatchError', '分块哈希不匹配');
        await fsPromises.rename(temporaryPath, committedPath);
        return { index: -1, size, sha256, path: committedPath, createdAt: new Date() };
    } catch (error) {
        await fsPromises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    } finally {
        await lockHandle.close().catch(() => undefined);
        await fsPromises.rm(lockPath, { force: true }).catch(() => undefined);
    }
}

export async function verifyChunkIntegrity(chunk: ChunkUploadChunk, expectedDirectory: string, maxChunkBytes: number): Promise<string> {
    const chunkPath = path.resolve(chunk.path);
    const directory = path.resolve(expectedDirectory);
    if (path.dirname(chunkPath) !== directory) throw new ChunkUploadProtocolError('ChunkPathError', `分块 ${chunk.index} 路径无效`);
    const stat = await fsPromises.stat(chunkPath);
    if (stat.size !== chunk.size || stat.size < 1 || stat.size > maxChunkBytes) {
        throw new ChunkUploadProtocolError('ChunkSizeMismatchError', `分块 ${chunk.index} 大小无效`);
    }
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(chunkPath), new (await import('node:stream')).Writable({
        write(buffer: Buffer, _encoding, callback) {
            hash.update(buffer);
            callback();
        },
    }));
    if (hash.digest('hex') !== chunk.sha256) {
        throw new ChunkUploadProtocolError('ChunkHashMismatchError', `分块 ${chunk.index} 哈希无效`);
    }
    return chunkPath;
}

export class ChunkUploadSessionStore {
    private readonly chunkWriteLocks = new Map<string, Promise<void>>();

    constructor(
        private readonly repository: ChunkUploadSessionRepository,
        private readonly limits?: ChunkUploadLimits,
    ) {}

    create(session: ChunkUploadSession): Promise<void> {
        return this.repository.createSession(session);
    }

    async reserve(session: ChunkUploadSession): Promise<void> {
        if (!this.limits) return this.create(session);
        if (session.totalSize > this.limits.maxTotalBytes) {
            throw new ChunkUploadProtocolError('ChunkTotalSizeError', '文件超过分块上传总大小限制');
        }
        const diskFreeBytes = await this.limits.getDiskFreeBytes();
        if (diskFreeBytes - session.totalSize < this.limits.diskReserveBytes) {
            throw new ChunkUploadProtocolError('ChunkDiskReserveError', '临时磁盘预留空间不足');
        }
        const reserved = await this.repository.reserveSession(
            session,
            this.limits.globalBudgetBytes,
            diskFreeBytes,
            this.limits.diskReserveBytes,
        );
        if (!reserved) {
            throw new ChunkUploadProtocolError('ChunkBudgetError', '全局临时上传预算不足');
        }
    }

    async writeChunk(input: {
        uploadId: string;
        ownerId: string;
        index: number;
        expectedSize: number;
        expectedSha256: string;
        finalPath: string;
        input: Readable;
        maxChunkBytes: number;
    }): Promise<ChunkRecordResult> {
        const lockKey = `${input.uploadId}:${input.index}`;
        const previous = this.chunkWriteLocks.get(lockKey) || Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        this.chunkWriteLocks.set(lockKey, current);
        await previous;
        try {
            return await this.writeChunkUnlocked(input);
        } finally {
            release();
            if (this.chunkWriteLocks.get(lockKey) === current) this.chunkWriteLocks.delete(lockKey);
        }
    }

    private async writeChunkUnlocked(input: {
        uploadId: string;
        ownerId: string;
        index: number;
        expectedSize: number;
        expectedSha256: string;
        finalPath: string;
        input: Readable;
        maxChunkBytes: number;
    }): Promise<ChunkRecordResult> {
        const existing = await this.repository.getSession(input.uploadId, input.ownerId);
        if (!existing || existing.status !== 'open') throw new ChunkUploadProtocolError('ChunkSessionStateError', '上传会话不可写');
        const known = await this.repository.getChunk(input.uploadId, input.ownerId, input.index);
        if (known) {
            input.input.resume();
            if (known.size === input.expectedSize && known.sha256 === input.expectedSha256.toLowerCase()) {
                return { status: 'duplicate', chunk: known };
            }
            throw new ChunkUploadProtocolError('ChunkConflictError', '同一分块索引的大小或哈希冲突');
        }

        const candidate = await writeChunkAtomically({
            stream: input.input,
            finalPath: input.finalPath,
            expectedSize: input.expectedSize,
            expectedSha256: input.expectedSha256,
            maxChunkBytes: input.maxChunkBytes,
        });
        candidate.index = input.index;
        try {
            const result = await this.repository.recordChunk(input.uploadId, input.ownerId, candidate);
            if (result.status === 'recorded') return result;
            await fsPromises.rm(candidate.path, { force: true }).catch(() => undefined);
            if (result.status === 'duplicate') return result;
            if (result.status === 'conflict') throw new ChunkUploadProtocolError('ChunkConflictError', '同一分块索引的大小或哈希冲突');
            throw new ChunkUploadProtocolError('ChunkSessionStateError', '上传会话不可写');
        } catch (error) {
            await fsPromises.rm(candidate.path, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    status(uploadId: string, ownerId: string): Promise<ChunkUploadSession | null> {
        return this.repository.getSession(uploadId, ownerId);
    }

    list(ownerId: string): Promise<ChunkUploadSession[]> {
        return this.repository.listSessions?.(ownerId) || Promise.resolve([]);
    }

    chunks(uploadId: string, ownerId: string): Promise<ChunkUploadChunk[]> {
        return this.repository.listChunks(uploadId, ownerId);
    }

    claimCompletion(uploadId: string, ownerId: string, token: string, expiresAt: Date): Promise<ChunkUploadCompletionClaim | null> {
        return this.repository.claimCompletion(uploadId, ownerId, token, expiresAt);
    }

    renewCompletion(uploadId: string, ownerId: string, token: string, expiresAt: Date): Promise<boolean> {
        return this.repository.renewCompletion(uploadId, ownerId, token, expiresAt);
    }

    failCompletion(uploadId: string, ownerId: string, token: string, error: string): Promise<boolean> {
        return this.repository.markCompletionFailed(uploadId, ownerId, token, error);
    }

    retryFailed(uploadId: string, ownerId: string): Promise<boolean> {
        return this.repository.reopenFailed(uploadId, ownerId);
    }

    completeWithReconciliation(uploadId: string, ownerId: string, token: string, fileId: string, operationId: string): Promise<boolean> {
        return this.repository.completeWithReconciliation(uploadId, ownerId, token, fileId, operationId);
    }

    complete(uploadId: string, ownerId: string, token: string, fileId: string): Promise<boolean> {
        return this.repository.markCompleted(uploadId, ownerId, token, fileId);
    }

    cancel(uploadId: string, ownerId: string): Promise<ChunkCancelResult> {
        return this.repository.cancel(uploadId, ownerId);
    }
}

function mapSession(row: Record<string, unknown>): ChunkUploadSession {
    return {
        uploadId: String(row.upload_id ?? row.uploadId),
        ownerId: String(row.owner_id ?? row.ownerId),
        filename: String(row.filename),
        mimeType: String(row.mime_type ?? row.mimeType),
        folder: row.folder == null ? null : String(row.folder),
        totalSize: Number(row.total_size ?? row.totalSize),
        totalChunks: Number(row.total_chunks ?? row.totalChunks),
        receivedBytes: Number(row.received_bytes ?? row.receivedBytes),
        status: String(row.status) as ChunkUploadStatus,
        targetProvider: String(row.target_provider ?? row.targetProvider),
        targetAccountId: row.target_account_id == null && row.targetAccountId == null ? null : String(row.target_account_id ?? row.targetAccountId),
        expiresAt: new Date(String(row.expires_at ?? row.expiresAt)),
        completionToken: row.completion_token == null && row.completionToken == null ? null : String(row.completion_token ?? row.completionToken),
        completionExpiresAt: row.completion_expires_at == null && row.completionExpiresAt == null
            ? null : new Date(String(row.completion_expires_at ?? row.completionExpiresAt)),
        completedFileId: row.completed_file_id == null && row.completedFileId == null ? null : String(row.completed_file_id ?? row.completedFileId),
        lastError: row.last_error == null && row.lastError == null ? null : String(row.last_error ?? row.lastError),
        createdAt: new Date(String(row.created_at ?? row.createdAt)),
        updatedAt: new Date(String(row.updated_at ?? row.updatedAt)),
    };
}

function mapChunk(row: Record<string, unknown>): ChunkUploadChunk {
    return {
        index: Number(row.chunk_index ?? row.index),
        size: Number(row.size),
        sha256: String(row.sha256),
        path: String(row.path),
        createdAt: new Date(String(row.created_at ?? row.createdAt)),
    };
}

export class PostgresChunkUploadSessionRepository implements ChunkUploadSessionRepository {
    constructor(private readonly pool: Pool) {}

    private insertParams(value: ChunkUploadSession): unknown[] {
        return [value.uploadId, value.ownerId, value.filename, value.mimeType, value.folder, value.totalSize, value.totalChunks,
            value.receivedBytes, value.status, value.targetProvider, value.targetAccountId, value.expiresAt, value.completionToken,
            value.completionExpiresAt, value.completedFileId, value.lastError, value.createdAt, value.updatedAt];
    }

    async createSession(value: ChunkUploadSession): Promise<void> {
        await this.pool.query(
            `INSERT INTO chunk_upload_sessions
             (upload_id, owner_id, filename, mime_type, folder, total_size, total_chunks, received_bytes, status,
              target_provider, target_account_id, expires_at, completion_token, completion_expires_at, completed_file_id, last_error, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            this.insertParams(value),
        );
    }

    async reserveSession(
        value: ChunkUploadSession,
        globalBudgetBytes: number,
        diskFreeBytes?: number,
        diskReserveBytes = 0,
    ): Promise<boolean> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT pg_advisory_xact_lock(hashtext('chunk_upload_global_budget'))`);
            const budget = await client.query(
                `SELECT COALESCE(SUM(total_size), 0)::text AS reserved_bytes
                 FROM chunk_upload_sessions
                 WHERE status IN ('open','completing','failed') AND expires_at > NOW()`,
            );
            const reservedBytes = Number(budget.rows[0]?.reserved_bytes || 0);
            if (reservedBytes + value.totalSize > globalBudgetBytes) {
                await client.query('ROLLBACK');
                return false;
            }
            if (diskFreeBytes !== undefined && reservedBytes + value.totalSize + diskReserveBytes > diskFreeBytes) {
                await client.query('ROLLBACK');
                return false;
            }
            await client.query(
                `INSERT INTO chunk_upload_sessions
                 (upload_id, owner_id, filename, mime_type, folder, total_size, total_chunks, received_bytes, status,
                  target_provider, target_account_id, expires_at, completion_token, completion_expires_at, completed_file_id, last_error, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
                this.insertParams(value),
            );
            await client.query('COMMIT');
            return true;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    async getReservedBytes(): Promise<number> {
        const result = await this.pool.query(
            `SELECT COALESCE(SUM(total_size), 0)::text AS reserved_bytes FROM chunk_upload_sessions
             WHERE status IN ('open','completing','failed') AND expires_at > NOW()`,
        );
        return Number(result.rows[0]?.reserved_bytes || 0);
    }

    async getSession(uploadId: string, ownerId: string): Promise<ChunkUploadSession | null> {
        const result = await this.pool.query(
            `SELECT * FROM chunk_upload_sessions WHERE upload_id = $1 AND owner_id = $2`, [uploadId, ownerId],
        );
        return result.rows[0] ? mapSession(result.rows[0]) : null;
    }

    async listSessions(ownerId: string): Promise<ChunkUploadSession[]> {
        const result = await this.pool.query(
            `SELECT * FROM chunk_upload_sessions
             WHERE owner_id = $1 AND status IN ('open','completing','failed') AND expires_at > NOW()
             ORDER BY created_at DESC LIMIT 100`,
            [ownerId],
        );
        return result.rows.map(mapSession);
    }

    async getChunk(uploadId: string, ownerId: string, index: number): Promise<ChunkUploadChunk | null> {
        const result = await this.pool.query(
            `SELECT c.* FROM chunk_upload_chunks c
             JOIN chunk_upload_sessions s ON s.upload_id = c.upload_id
             WHERE c.upload_id = $1 AND s.owner_id = $2 AND c.chunk_index = $3`,
            [uploadId, ownerId, index],
        );
        return result.rows[0] ? mapChunk(result.rows[0]) : null;
    }

    async listChunks(uploadId: string, ownerId: string): Promise<ChunkUploadChunk[]> {
        const result = await this.pool.query(
            `SELECT c.* FROM chunk_upload_chunks c
             JOIN chunk_upload_sessions s ON s.upload_id = c.upload_id
             WHERE c.upload_id = $1 AND s.owner_id = $2 ORDER BY c.chunk_index`,
            [uploadId, ownerId],
        );
        return result.rows.map(mapChunk);
    }

    async recordChunk(uploadId: string, ownerId: string, chunk: ChunkUploadChunk): Promise<ChunkRecordResult> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const locked = await client.query(
                `SELECT total_size FROM chunk_upload_sessions
                 WHERE upload_id = $1 AND owner_id = $2 AND status = 'open' AND expires_at > NOW() FOR UPDATE`,
                [uploadId, ownerId],
            );
            if (!locked.rows[0]) {
                await client.query('ROLLBACK');
                return { status: 'rejected' };
            }
            const inserted = await client.query(
                `INSERT INTO chunk_upload_chunks (upload_id, chunk_index, size, sha256, path, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (upload_id, chunk_index) DO NOTHING RETURNING *`,
                [uploadId, chunk.index, chunk.size, chunk.sha256, chunk.path, chunk.createdAt],
            );
            if (!inserted.rows[0]) {
                const currentResult = await client.query(
                    `SELECT * FROM chunk_upload_chunks WHERE upload_id = $1 AND chunk_index = $2`, [uploadId, chunk.index],
                );
                await client.query('ROLLBACK');
                const current = mapChunk(currentResult.rows[0]);
                return current.size === chunk.size && current.sha256 === chunk.sha256
                    ? { status: 'duplicate', chunk: current }
                    : { status: 'conflict', chunk: current };
            }
            const updated = await client.query(
                `UPDATE chunk_upload_sessions SET received_bytes = received_bytes + $3, updated_at = NOW()
                 WHERE upload_id = $1 AND owner_id = $2 AND status = 'open' AND received_bytes + $3 <= total_size`,
                [uploadId, ownerId, chunk.size],
            );
            if (updated.rowCount !== 1) throw new ChunkUploadProtocolError('ChunkBudgetError', '分块累计大小超过声明总大小');
            await client.query('COMMIT');
            return { status: 'recorded', chunk };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    async claimCompletion(uploadId: string, ownerId: string, token: string, expiresAt: Date): Promise<ChunkUploadCompletionClaim | null> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const claimed = await client.query(
                `UPDATE chunk_upload_sessions s
                 SET status = 'completing', completion_token = $3, completion_expires_at = $4, last_error = NULL, updated_at = NOW()
                 WHERE upload_id = $1 AND owner_id = $2 AND status = 'open' AND completion_token IS NULL
                   AND received_bytes = total_size
                   AND (SELECT COUNT(*) FROM chunk_upload_chunks c WHERE c.upload_id = s.upload_id) = total_chunks
                 RETURNING s.*`,
                [uploadId, ownerId, token, expiresAt],
            );
            if (!claimed.rows[0]) {
                await client.query('ROLLBACK');
                return null;
            }
            const chunks = await client.query(
                `SELECT * FROM chunk_upload_chunks WHERE upload_id = $1 ORDER BY chunk_index FOR UPDATE`, [uploadId],
            );
            await client.query('COMMIT');
            return { session: mapSession(claimed.rows[0]), chunks: chunks.rows.map(mapChunk) };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    async renewCompletion(uploadId: string, ownerId: string, token: string, expiresAt: Date): Promise<boolean> {
        const result = await this.pool.query(
            `UPDATE chunk_upload_sessions
             SET completion_expires_at = $4, updated_at = NOW()
             WHERE upload_id = $1 AND owner_id = $2 AND status = 'completing' AND completion_token = $3
             RETURNING upload_id`,
            [uploadId, ownerId, token, expiresAt],
        );
        return result.rowCount === 1;
    }

    async markCompletionFailed(uploadId: string, ownerId: string, token: string, error: string): Promise<boolean> {
        const result = await this.pool.query(
            `UPDATE chunk_upload_sessions SET status = 'failed', completion_token = NULL, completion_expires_at = NULL, last_error = $4, updated_at = NOW()
             WHERE upload_id = $1 AND owner_id = $2 AND status = 'completing' AND completion_token = $3`,
            [uploadId, ownerId, token, error.slice(0, 2000)],
        );
        return result.rowCount === 1;
    }

    async reopenFailed(uploadId: string, ownerId: string): Promise<boolean> {
        const result = await this.pool.query(
            `UPDATE chunk_upload_sessions SET status = 'open', last_error = NULL, updated_at = NOW()
             WHERE upload_id = $1 AND owner_id = $2 AND status = 'failed' AND expires_at > NOW()
               AND NOT EXISTS (SELECT 1 FROM chunk_upload_reconciliations r WHERE r.upload_id = $1 AND r.status = 'pending')`,
            [uploadId, ownerId],
        );
        return result.rowCount === 1;
    }

    async completeWithReconciliation(uploadId: string, ownerId: string, token: string, fileId: string, operationId: string): Promise<boolean> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const completed = await client.query(
                `UPDATE chunk_upload_sessions SET status = 'completed', completed_file_id = $4, completion_expires_at = NULL, updated_at = NOW()
                 WHERE upload_id = $1 AND owner_id = $2 AND status = 'completing' AND completion_token = $3
                 RETURNING upload_id`, [uploadId, ownerId, token, fileId],
            );
            if (completed.rowCount !== 1) {
                await client.query('ROLLBACK');
                return false;
            }
            const resolved = await client.query(
                `UPDATE chunk_upload_reconciliations
                 SET status = 'resolved', reason = '分块完成已提交', resolved_at = NOW(), updated_at = NOW()
                 WHERE operation_id = $1 AND upload_id = $2 AND completion_token = $3 AND status = 'pending'
                 RETURNING operation_id`, [operationId, uploadId, token],
            );
            if (resolved.rowCount !== 1) throw new Error('分块完成 journal resolve 影响 0 行');
            await client.query('COMMIT');
            return true;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    async markCompleted(uploadId: string, ownerId: string, token: string, fileId: string): Promise<boolean> {
        const result = await this.pool.query(
            `UPDATE chunk_upload_sessions SET status = 'completed', completed_file_id = $4, completion_expires_at = NULL, updated_at = NOW()
             WHERE upload_id = $1 AND owner_id = $2 AND status = 'completing' AND completion_token = $3`,
            [uploadId, ownerId, token, fileId],
        );
        return result.rowCount === 1;
    }

    async deleteExpiredSessions(limit: number): Promise<string[]> {
        const result = await this.pool.query(
            `WITH expired AS (
                SELECT s.upload_id
                FROM chunk_upload_sessions s
                WHERE s.status IN ('open','failed','cancelled') AND s.expires_at <= NOW()
                  AND NOT EXISTS (
                      SELECT 1 FROM chunk_upload_reconciliations r
                      WHERE r.upload_id = s.upload_id AND r.status = 'pending'
                  )
                ORDER BY s.expires_at
                FOR UPDATE SKIP LOCKED
                LIMIT $1
             )
             DELETE FROM chunk_upload_sessions s
             USING expired
             WHERE s.upload_id = expired.upload_id
             RETURNING s.upload_id`,
            [Math.max(1, Math.min(limit, 1000))],
        );
        return result.rows.map(row => String(row.upload_id));
    }

    async recoverExpiredCompletions(limit: number): Promise<string[]> {
        const result = await this.pool.query(
            `WITH expired AS (
                SELECT s.upload_id
                FROM chunk_upload_sessions s
                WHERE s.status = 'completing' AND s.completion_expires_at <= NOW()
                  AND NOT EXISTS (
                      SELECT 1 FROM chunk_upload_reconciliations r
                      WHERE r.upload_id = s.upload_id AND r.status = 'pending'
                  )
                ORDER BY s.completion_expires_at
                FOR UPDATE SKIP LOCKED
                LIMIT $1
             )
             UPDATE chunk_upload_sessions s
             SET status = 'failed', completion_token = NULL, completion_expires_at = NULL,
                 last_error = '完成租约已过期，可安全重试', updated_at = NOW()
             FROM expired
             WHERE s.upload_id = expired.upload_id
             RETURNING s.upload_id`,
            [Math.max(1, Math.min(limit, 1000))],
        );
        return result.rows.map(row => String(row.upload_id));
    }

    async cancel(uploadId: string, ownerId: string): Promise<ChunkCancelResult> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const locked = await client.query(
                `SELECT status FROM chunk_upload_sessions WHERE upload_id = $1 AND owner_id = $2 FOR UPDATE`, [uploadId, ownerId],
            );
            if (!locked.rows[0]) {
                await client.query('ROLLBACK');
                return 'not_found';
            }
            const status = String(locked.rows[0].status) as ChunkUploadStatus;
            if (status === 'completing') {
                await client.query('ROLLBACK');
                return 'busy';
            }
            if (status === 'completed' || status === 'cancelled') {
                await client.query('ROLLBACK');
                return 'terminal';
            }
            const updated = await client.query(
                `UPDATE chunk_upload_sessions SET status = 'cancelled', completion_token = NULL, completion_expires_at = NULL, updated_at = NOW()
                 WHERE upload_id = $1 AND owner_id = $2 AND status IN ('open','failed')`, [uploadId, ownerId],
            );
            await client.query('COMMIT');
            return updated.rowCount === 1 ? 'cancelled' : 'busy';
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
}
