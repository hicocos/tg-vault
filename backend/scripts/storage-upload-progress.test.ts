import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { trackUploadProgress } from '../src/services/storage/uploadProgress.js';
import { OpenListStorageProvider } from '../src/services/openListStorage.js';
import { createServer } from 'node:http';
import { uploadOneDriveFile } from '../src/services/oneDriveUpload.js';
import { uploadGoogleDriveFile } from '../src/services/googleDriveUpload.js';
import { LocalStorageProvider } from '../src/services/storage/localStorageProvider.js';
import { saveAndIndexWithCompensation } from '../src/services/storageWrite.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

test('upload byte observation waits for a consumer and preserves backpressure and cancellation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'storage-progress-'));
    const total = 1024 * 1024;
    const file = path.join(root, 'source.bin');
    const controller = new AbortController();
    const release = deferred();
    try {
        await writeFile(file, Buffer.alloc(total, 7));
        const reports: number[] = [];
        const source = trackUploadProgress(fs.createReadStream(file, { highWaterMark: 16 * 1024, signal: controller.signal }), total, bytes => { reports.push(bytes); });
        await once(source, 'open');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(reports, [0]);
        assert.equal(source.readableFlowing, null);
        const started = deferred();
        let received = 0;
        const sink = new Writable({
            highWaterMark: 16 * 1024,
            write(chunk: Buffer, _encoding, done) {
                received += chunk.length;
                started.resolve();
                void release.promise.then(() => done());
            },
        });
        const completed = pipeline(source, sink);
        const rejected = assert.rejects(completed, /abort/i);
        await started.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(reports.at(-1), received);
        assert.ok(received > 0 && received < total);
        const beforeCancel = reports.at(-1);
        controller.abort();
        release.resolve();
        await rejected;
        assert.equal(reports.at(-1), beforeCancel);
        assert.equal(source.destroyed, true);
    } finally {
        release.resolve();
        await rm(root, { recursive: true, force: true });
    }
});

test('OpenList authentication retry starts current file bytes over without inflation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openlist-progress-'));
    const total = 512 * 1024;
    const file = path.join(root, 'source.bin');
    const reports: number[] = [];
    let attempts = 0;
    const requestFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const endpoint = String(url);
        if (endpoint.endsWith('/api/auth/login')) return Response.json({ code: 200, data: { token: 'token' } });
        if (endpoint.endsWith('/api/fs/get')) {
            const remotePath = JSON.parse(String(init?.body)).path;
            return Response.json({ code: 200, data: remotePath === '/' ? { is_dir: true } : { is_dir: false, size: total } });
        }
        assert.ok(endpoint.endsWith('/api/fs/put'));
        attempts++;
        const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
        let received = 0;
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                received += next.value.byteLength;
                await new Promise<void>(resolve => setImmediate(resolve));
                if (attempts === 1) return Response.json({ code: 401 }, { status: 401 });
            }
        } finally { await reader.cancel(); }
        assert.equal(received, total);
        return Response.json({ code: 200 });
    }) as typeof fetch;
    try {
        await writeFile(file, Buffer.alloc(total, 3));
        const provider = new OpenListStorageProvider('test', 'https://openlist.example', '/', 'user', 'password', 5000, 5000, 5000, requestFetch);
        const storedPath = await provider.saveFile(file, 'source.bin', 'application/octet-stream', null, {
            onProgress(bytes, size) { assert.equal(size, total); reports.push(bytes); },
        });
        assert.equal(storedPath, '/source.bin');
        assert.equal(attempts, 2);
        const reset = reports.indexOf(0, 1);
        assert.ok(reset > 1);
        assert.ok(reports[reset - 1] > 0 && reports[reset - 1] < total);
        assert.ok(reports.slice(reset + 1).some(bytes => bytes > 0 && bytes < total));
        assert.ok(reports.every(bytes => bytes >= 0 && bytes <= total));
        assert.equal(reports.at(-1), total);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('Google Drive checksum reconciliation does not count checksum reads as upload bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'drive-progress-'));
    const file = path.join(root, 'source.bin');
    const reports: number[] = [];
    try {
        await writeFile(file, 'abc');
        assert.equal(await uploadGoogleDriveFile({
            tempPath: file, fileId: 'file-id', fileName: 'source.bin', folderId: 'folder',
            async create(body) {
                for await (const _chunk of body) { /* Consume the actual upload stream. */ }
                throw { status: 409 };
            },
            async inspect() {
                assert.deepEqual(reports, [0, 3]);
                return { id: 'file-id', name: 'source.bin', size: '3', parents: ['folder'], md5Checksum: '900150983cd24fb0d6963f7d28e17f72' };
            },
            onProgress(bytes, total) { assert.equal(total, 3); reports.push(bytes); },
        }), 'file-id');
        assert.deepEqual(reports, [0, 3, 3]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('zero-byte observation is bounded and a failed upload never manufactures success', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'empty-progress-'));
    const file = path.join(root, 'source.bin');
    try {
        await writeFile(file, '');
        const reports: number[] = [];
        await assert.rejects(uploadGoogleDriveFile({
            tempPath: file, fileId: 'file-id', fileName: 'source.bin', folderId: 'folder',
            async create() { throw new Error('upload denied'); },
            async inspect() { throw new Error('must not inspect permanent error'); },
            onProgress(bytes, total) { assert.equal(total, 0); reports.push(bytes); },
        }), /upload denied/);
        assert.deepEqual(reports, [0]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('indexed prepared local writes forward confirmed progress before indexing, including empty files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'local-progress-'));
    try {
        const provider = new LocalStorageProvider(path.join(root, 'stored'));
        for (const contents of ['', 'abc']) {
            const file = path.join(root, 'source.bin');
            await writeFile(file, contents);
            const reports: number[] = [];
            await saveAndIndexWithCompensation(provider, file, 'target.bin', 'application/octet-stream', null, async storedPath => {
                assert.deepEqual(reports, [contents.length]);
                assert.equal(await fs.promises.readFile(storedPath, 'utf8'), contents);
            }, {
                onProgress(bytes, total) { assert.equal(total, contents.length); reports.push(bytes); },
            });
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('OneDrive fragment transmission reports offsets and resets an unconfirmed retry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'onedrive-progress-'));
    const file = path.join(root, 'source.bin');
    const total = 4 * 1024 * 1024 + 1;
    const fragment = 320 * 1024 * 10;
    const reports: number[] = [];
    let puts = 0;
    let baseUrl = '';
    const server = createServer(async (request, response) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET' && pathname === '/target') {
            response.writeHead(404).end('{}');
            return;
        }
        if (request.method === 'POST') {
            request.resume();
            response.end(JSON.stringify({ uploadUrl: `${baseUrl}/upload` }));
            return;
        }
        if (request.method === 'GET' && pathname === '/upload') {
            response.end(JSON.stringify({ nextExpectedRanges: ['0-'] }));
            return;
        }
        assert.equal(request.method, 'PUT');
        const attempt = ++puts;
        let received = 0;
        for await (const chunk of request) {
            received += chunk.length;
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (attempt === 1) {
            response.setHeader('Retry-After', '0');
            response.writeHead(503).end('{}');
        } else if (attempt === 2) {
            assert.equal(received, fragment);
            response.writeHead(202).end(JSON.stringify({ nextExpectedRanges: [`${fragment}-`] }));
        } else {
            assert.equal(received, total - fragment);
            response.writeHead(201).end(JSON.stringify({ id: 'file-id', name: 'source.bin', size: total, file: {} }));
        }
    });
    try {
        await writeFile(file, Buffer.alloc(total, 5));
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        baseUrl = `http://127.0.0.1:${address.port}`;
        assert.equal(await uploadOneDriveFile({
            tempPath: file, resourceUrl: `${baseUrl}/target`, fileName: 'source.bin', mimeType: 'application/octet-stream',
            async getAccessToken() { return 'token'; },
            onProgress(bytes, size) { assert.equal(size, total); reports.push(bytes); },
        }), 'file-id');
        assert.equal(puts, 3);
        const reset = reports.indexOf(0, 1);
        assert.ok(reset > 1);
        assert.ok(reports.slice(0, reset).some(bytes => bytes > 0 && bytes < fragment));
        assert.ok(reports.some(bytes => bytes > fragment && bytes < total));
        assert.ok(reports.every(bytes => bytes >= 0 && bytes <= total));
        assert.equal(reports.at(-1), total);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
        await rm(root, { recursive: true, force: true });
    }
});
