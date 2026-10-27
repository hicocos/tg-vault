import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/index.js';
import { storageManager } from '../src/services/storage.js';
import { controlQbTask, qbTaskView, qbTaskFiles, startQbTasks, stopQbTasks, tickQbTasks } from '../src/services/qbittorrentTasks.js';
import type { QbTorrent, QbFile } from '../src/services/qbittorrentClient.js';
import type { IStorageProvider } from '../src/services/storage.js';
import type { TransferTaskRecord, TransferTaskStatus } from '../src/services/transferTasks.js';
import { mapTransferTask } from '../src/services/unifiedTaskMapper.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

// Only external boundaries are replaced: the task scheduler, advisory-lock lifecycle,
// persisted task mapper/patches, client HTTP encoding, and source filesystem checks all run.
async function fixture(t: TestContext, stage = 'downloading', status = 'running') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-cancel-'));
    const id = randomUUID();
    const source = path.join(root, id);
    const destination = path.join(root, 'destination.txt');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'partial.bin'), 'data');
    await fs.writeFile(destination, 'transferred destination');
    const indexedId = randomUUID();
    const payload = { hash: 'a'.repeat(40), connection: 'http://qb.test|test', savePath: source,
        downloadRoot: root, preserveLocalFiles: true, files: [{ index: 1, name: 'previous.bin', size: 4, storedName: 'destination.txt', fileId: indexedId }],
        downloadProgress: 50, downloadSpeed: 10, cleanupRequestedAt: 0, submissionPending: false };
    const row: Record<string, unknown> & { payload: typeof payload; status: string; stage: string; cancel_requested: boolean; finished_at: Date | null; error: string | null; retryable: boolean } = {
        source_type: 'qbittorrent', id, kind: 'torrent', title: 'test', status, stage, progress: 30,
        target_provider: 'test', target_account_id: null, target_folder: '/archive', total_items: 2, completed_items: 1,
        total_bytes: 8, transferred_bytes: 4, retryable: status === 'failed', cancel_requested: false,
        error: status === 'failed' ? 'previous transfer failed' : null, created_at: new Date(), updated_at: new Date(),
        finished_at: null, payload,
    };
    const indexed = new Map([[indexedId, destination]]);
    let torrent: QbTorrent | null = { hash: row.payload.hash, name: 'test', state: 'downloading', progress: 0.5, dlspeed: 10,
        size: 8, save_path: source, content_path: path.join(source, 'partial.bin') };
    let files: QbFile[] = [{ index: 0, name: 'partial.bin', size: 4, progress: 0.5, priority: 1 }];
    const requests: string[] = [];
    let deleteBehavior: () => Promise<void> = async () => {
        torrent = null;
        await fs.rm(source, { recursive: true, force: true });
    };
    const settings: Record<string, string> = {
        qbittorrent_enabled: 'true', qbittorrent_api_url: 'http://qb.test', qbittorrent_username: 'test',
        qbittorrent_password: 'password', qbittorrent_download_dir: root, qbittorrent_target_folder: '/',
        qbittorrent_target_account_id: 'local', qbittorrent_preserve_local_files: 'true',
    };
    const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith('SELECT value FROM system_settings')) return result([{ value: settings[String(params[0])] }]);
        if (sql.startsWith('SELECT * FROM transfer_tasks')) return result([structuredClone(row)]);
        if (sql.startsWith('SELECT id FROM transfer_tasks')) return result(['pending', 'running'].includes(row.status) ? [{ id }] : []);
        if (sql.startsWith('UPDATE transfer_tasks SET ')) {
            const assignments = sql.slice('UPDATE transfer_tasks SET '.length, sql.indexOf(', updated_at = NOW()'));
            for (const assignment of assignments.split(', ')) {
                const match = /^(\w+) = (?:payload \|\| )?\$(\d+)(?:::jsonb)?$/.exec(assignment);
                assert.ok(match, `Unexpected task patch: ${assignment}`);
                const value = params[Number(match[2]) - 1];
                Object.assign(row, { [match[1]]: match[1] === 'payload' ? { ...row.payload, ...JSON.parse(String(value)) } : value });
            }
            return result([structuredClone(row)]);
        }
        if (sql.startsWith('SELECT id FROM files')) {
            assert.ok(Array.isArray(params[0]));
            return result(params[0].filter((key: unknown): key is string => typeof key === 'string' && indexed.has(key)).map((id: string) => ({ id })));
        }
        throw new Error(`Unexpected database access: ${sql}`);
    });
    // Serialize independent pooled connections exactly like the production advisory lock.
    const locks = new Map<string, Promise<void>>();
    t.mock.method(pool, 'connect', async () => {
        let unlock: (() => void) | undefined;
        return { release() {}, async query(sql: string, params: string[]) {
            if (sql.includes('pg_advisory_unlock')) { unlock?.(); return result([]); }
            assert.ok(sql.includes('pg_advisory_lock'), `Unexpected connection query: ${sql}`);
            const previous = locks.get(params[0]) || Promise.resolve();
            const held = deferred();
            locks.set(params[0], previous.then(() => held.promise));
            await previous;
            unlock = held.resolve;
            return result([]);
        } };
    });
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        assert.equal(url.origin, 'http://qb.test');
        const endpoint = url.pathname.replace('/api/v2/', '');
        requests.push(endpoint);
        if (endpoint === 'auth/login') return new Response('Ok.', { headers: { 'set-cookie': 'SID=test;' } });
        if (endpoint === 'torrents/info') return Response.json(torrent ? [torrent] : []);
        if (endpoint === 'torrents/files') return Response.json(files);
        if (endpoint === 'app/version') return new Response('v5.1.0');
        if (endpoint === 'torrents/add') {
            assert.ok(init?.body instanceof FormData);
            assert.equal(init.body.has('tags'), false);
            assert.equal(init.body.get('savepath'), source);
            torrent = { hash: row.payload.hash, name: 'submitted task', state: 'downloading', progress: 0.5, dlspeed: 10,
                size: 8, save_path: source, content_path: path.join(source, 'partial.bin') };
            return new Response('Ok.');
        }
        if (endpoint === 'torrents/delete') {
            assert.equal(init?.method, 'POST');
            const body = init?.body as URLSearchParams;
            assert.equal(body.get('hashes'), row.payload.hash);
            assert.equal(body.get('deleteFiles'), 'true');
            await deleteBehavior();
            return new Response('');
        }
        if (['torrents/start', 'torrents/stop', 'torrents/filePrio'].includes(endpoint)) return new Response('');
        throw new Error(`Unexpected qBittorrent operation: ${endpoint}`);
    });
    t.after(async () => { await stopQbTasks(); t.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); });
    const poll = async () => { startQbTasks(); await tickQbTasks(); };
    const view = () => {
        const task: TransferTaskRecord = { sourceType: 'qbittorrent', id, kind: 'torrent', title: 'test', status: row.status as TransferTaskStatus,
            stage: row.stage, progress: Number(row.progress), ownerUserId: null, chatId: null, source: 'qBittorrent', targetProvider: 'test',
            targetAccountId: null, targetFolder: '/archive', totalItems: 2, completedItems: 1, failedItems: 0, totalBytes: 8, transferredBytes: 4,
            payload: row.payload, error: row.error, retryable: row.retryable, cancelRequested: row.cancel_requested,
            startedAt: null, finishedAt: row.finished_at, createdAt: new Date(), updatedAt: new Date() };
        return { ...qbTaskView(task), cancellable: mapTransferTask(task, new Map()).cancellable };
    };
    const retained = async () => {
        assert.equal(await fs.readFile(destination, 'utf8'), 'transferred destination');
        assert.deepEqual([...indexed.keys()], [indexedId]);
        assert.equal(row.payload.files[0].fileId, indexedId);
    };
    return { id, root, source, row, requests, indexed, destination, poll, view, retained,
        get torrent() { return torrent; }, set torrent(value) { torrent = value; },
        get files() { return files; }, set files(value) { files = value; },
        set deleteBehavior(value: () => Promise<void>) { deleteBehavior = value; },
    };
}

for (const [stage, status] of [['submitting', 'pending'], ['downloading', 'running'], ['downloading', 'paused'], ['uploading', 'failed']]) {
    test(`cancel ${status}/${stage} deletes the owned torrent and source, retaining indexed destination`, async t => {
        const f = await fixture(t, stage, status);
        await controlQbTask(f.id, 'cancel');
        assert.equal(f.view().status, 'running');
        assert.equal(f.view().stage, 'cancelling');
        assert.equal(f.view().cancelRequested, true);
        assert.equal(f.view().cancellable, false);
        assert.equal(f.view().finishedAt, null);
        await f.poll();
        assert.equal(f.view().status, 'running');
        assert.equal(f.requests.filter(item => item === 'torrents/delete').length, 1);
        await assert.rejects(fs.access(f.source), { code: 'ENOENT' });
        await f.poll();
        assert.equal(f.view().status, 'cancelled');
        assert.ok(f.view().finishedAt);
        assert.ok(!f.requests.includes('torrents/stop'));
        await f.retained();
    });
}
for (const input of ['magnet', 'torrent'] as const) {
    test(`${input} submission stays tag-free and remains controllable through source cleanup`, async t => {
        const f = await fixture(t, 'submitting', 'pending');
        f.torrent = null;
        Object.assign(f.row.payload, input === 'magnet'
            ? { magnet: `magnet:?xt=urn:btih:${f.row.payload.hash}` }
            : { torrent: Buffer.from('d4:infodee').toString('base64') });
        await f.poll();
        assert.equal(f.requests.filter(endpoint => endpoint === 'torrents/add').length, 1);
        await f.poll();
        assert.equal(f.view().stage, 'downloading');
        await controlQbTask(f.id, 'pause');
        assert.equal(f.view().status, 'paused');
        await controlQbTask(f.id, 'cancel');
        await f.poll();
        await f.poll();
        assert.equal(f.view().status, 'cancelled');
        await assert.rejects(fs.access(f.source), { code: 'ENOENT' });
        await f.retained();
    });
}

test('existing task payloads with a legacy tag remain manageable after the qBittorrent tag is removed', async t => {
    const f = await fixture(t);
    Object.assign(f.row.payload, { tag: `tg-vault-${f.id}` });
    await controlQbTask(f.id, 'pause');
    assert.equal(f.view().status, 'paused');
    await controlQbTask(f.id, 'cancel');
    await f.poll();
    await f.poll();
    assert.equal(f.view().status, 'cancelled');
    await f.retained();
});

test('unsubmitted task can cancel without adding a torrent; uncertain submission remains retryable', async t => {
    const f = await fixture(t, 'submitting', 'pending');
    f.torrent = null;
    await fs.rm(f.source, { recursive: true });
    await controlQbTask(f.id, 'cancel');
    await f.poll();
    assert.equal(f.view().status, 'cancelled');
    assert.ok(!f.requests.includes('torrents/delete'));
    f.row.status = 'pending'; f.row.stage = 'submitting'; f.row.cancel_requested = false;
    f.row.payload.submissionPending = true;
    await controlQbTask(f.id, 'cancel');
    await f.poll();
    assert.equal(f.view().status, 'failed');
    assert.match(f.view().error!, /提交结果尚未确认/);
    assert.equal(f.view().retryable, true);
    await f.retained();
});

for (const unsafe of ['hash', 'savePath', 'contentPath', 'uuidPath', 'traversal', 'symlink']) {
    test(`cancel refuses destructive deletion with unsafe ${unsafe}`, async t => {
        const f = await fixture(t);
        if (unsafe === 'hash') f.torrent!.hash = 'b'.repeat(40);
        if (unsafe === 'savePath') f.torrent!.save_path = f.root;
        if (unsafe === 'contentPath') f.torrent!.content_path = f.destination;
        if (unsafe === 'uuidPath') { f.row.payload.savePath = f.root; f.torrent!.save_path = f.root; }
        if (unsafe === 'traversal') f.files = [{ ...f.files[0], name: '../destination.txt' }];
        if (unsafe === 'symlink') await fs.symlink(f.destination, path.join(f.source, 'escape'));
        await controlQbTask(f.id, 'cancel');
        await f.poll();
        assert.equal(f.view().status, 'failed');
        assert.equal(f.view().stage, 'cancelling');
        assert.equal(f.view().retryable, true);
        assert.ok(f.view().error);
        assert.ok(!f.requests.includes('torrents/delete'));
        assert.equal(await fs.readFile(path.join(f.source, 'partial.bin'), 'utf8'), 'data');
        await assert.rejects(controlQbTask(f.id, 'resume'), /正在取消/);
        await f.retained();
    });
}

test('delayed deletion stays nonterminal, rejects resurrection, and restart confirms disappearance', async t => {
    const f = await fixture(t);
    f.deleteBehavior = async () => {};
    await controlQbTask(f.id, 'cancel');
    await f.poll();
    await f.poll();
    assert.equal(f.view().status, 'running');
    assert.equal(f.view().stage, 'cancelling');
    assert.equal(f.requests.filter(item => item === 'torrents/delete').length, 1);
    for (const action of ['resume', 'pause', 'cancel', 'retry']) await assert.rejects(controlQbTask(f.id, action));
    await assert.rejects(qbTaskFiles(f.id, [0]), /正在取消/);
    await stopQbTasks();
    f.torrent = null;
    await fs.rm(f.source, { recursive: true });
    await f.poll();
    assert.equal(f.view().status, 'cancelled');
    await f.retained();
});

test('delete errors and stalled remote deletion expose retry that only retries source cleanup', async t => {
    const f = await fixture(t);
    f.deleteBehavior = async () => { throw new Error('delete service unavailable'); };
    await controlQbTask(f.id, 'cancel');
    await f.poll();
    assert.equal(f.view().status, 'failed');
    assert.match(f.view().error!, /delete service unavailable/);
    assert.equal(f.view().retryable, true);
    assert.equal(f.view().cancellable, false);
    await stopQbTasks();
    f.deleteBehavior = async () => {};
    await controlQbTask(f.id, 'retry');
    await f.poll();
    f.row.payload.cleanupRequestedAt = Date.now() - 31_000;
    await f.poll();
    assert.equal(f.view().status, 'failed');
    assert.match(f.view().error!, /删除尚未完成/);
    await stopQbTasks();
    f.deleteBehavior = async () => { f.torrent = null; await fs.rm(f.source, { recursive: true }); };
    await controlQbTask(f.id, 'retry');
    await f.poll();
    await f.poll();
    assert.equal(f.view().status, 'cancelled');
    assert.equal(f.requests.filter(item => item === 'torrents/delete').length, 3);
    assert.ok(!f.requests.includes('torrents/start'));
    await f.retained();
});

test('torrent disappearance does not hide partial/unselected leftovers; retries inspect the whole tree', async t => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.source, 'unselected'));
    await fs.writeFile(path.join(f.source, 'unselected', 'part.!qB'), 'partial');
    f.deleteBehavior = async () => { f.torrent = null; await fs.rm(path.join(f.source, 'partial.bin')); };
    await controlQbTask(f.id, 'cancel');
    await f.poll();
    await f.poll();
    assert.equal(f.view().status, 'running');
    f.row.payload.cleanupRequestedAt = Date.now() - 31_000;
    await f.poll();
    assert.equal(f.view().status, 'failed');
    assert.match(f.view().error!, /源文件仍存在/);
    await stopQbTasks();
    await controlQbTask(f.id, 'retry');
    await f.poll();
    assert.equal(f.view().status, 'failed');
    await stopQbTasks();
    await fs.rm(f.source, { recursive: true });
    await controlQbTask(f.id, 'retry');
    await f.poll();
    assert.equal(f.view().status, 'cancelled');
    await f.retained();
});

test('missing torrent before cancellation never causes direct backend removal or false success', async t => {
    const f = await fixture(t);
    f.torrent = null;
    await controlQbTask(f.id, 'cancel');
    await f.poll();
    assert.equal(f.view().status, 'failed');
    assert.match(f.view().error!, /源文件仍存在/);
    assert.equal(await fs.readFile(path.join(f.source, 'partial.bin'), 'utf8'), 'data');
    assert.ok(!f.requests.includes('torrents/delete'));
    await f.retained();
});

test('cancel joins aborted upload before qBittorrent removes source and never touches committed destination', { timeout: 5_000 }, async t => {
    const f = await fixture(t, 'uploading');
    f.files = [{ ...f.files[0], progress: 1 }];
    f.torrent!.state = 'uploading';
    const entered = deferred(); const aborted = deferred(); const release = deferred();
    t.after(() => release.resolve());
    let joined = false;
    const provider: IStorageProvider = {
        name: 'test',
        async probe() {},
        async getFileStream() { throw new Error('Unexpected destination read'); },
        async getPreviewUrl() { throw new Error('Unexpected preview lookup'); },
        async deleteFile() { assert.fail('Committed destination must never be deleted'); },
        async saveFile(source, _name, _mime, _folder, options) {
            assert.ok(options?.signal);
            assert.equal(source, path.join(f.source, 'partial.bin'));
            entered.resolve();
            options.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
            await release.promise;
            assert.equal(await fs.readFile(source, 'utf8'), 'data');
            joined = true;
            options.signal.throwIfAborted();
            throw new Error('Expected upload abort');
        },
    };
    t.mock.method(storageManager, 'getTarget', () => ({ provider, accountId: null, providerKey: 'test' }));
    f.deleteBehavior = async () => {
        assert.equal(joined, true);
        f.torrent = null;
        await fs.rm(f.source, { recursive: true });
    };
    const polling = f.poll();
    await Promise.race([entered.promise, polling.then(() => { throw new Error(`Upload never started: ${f.row.status}/${f.row.stage}: ${f.row.error}`); })]);
    const cancelling = controlQbTask(f.id, 'cancel');
    await aborted.promise;
    assert.equal(f.requests.includes('torrents/delete'), false);
    assert.equal(f.view().cancelRequested, false);
    release.resolve();
    await cancelling;
    await polling;
    await f.poll();
    await f.poll();
    assert.equal(f.view().status, 'cancelled');
    assert.equal(joined, true);
    await f.retained();
});

test('pause/resume and normal completed cleanup keep their original lifecycle', async t => {
    const f = await fixture(t);
    await controlQbTask(f.id, 'pause');
    assert.equal(f.view().status, 'paused');
    await controlQbTask(f.id, 'resume');
    assert.equal(f.view().status, 'pending');
    assert.ok(f.requests.includes('torrents/stop'));
    assert.ok(f.requests.includes('torrents/start'));
    assert.ok(!f.requests.includes('torrents/delete'));
    f.row.stage = 'cleaning';
    await assert.rejects(controlQbTask(f.id, 'cancel'), /仅支持重试/);
    f.files = [{ index: 1, name: 'previous.bin', size: 4, progress: 1, priority: 1 }];
    await f.poll();
    await f.poll();
    assert.equal(f.view().status, 'completed');
    assert.equal(f.view().progress, 100);
    await f.retained();
});

test('restart recovers cancellation intent before the remote delete request', async t => {
    const f = await fixture(t);
    await controlQbTask(f.id, 'cancel');
    await stopQbTasks();
    assert.equal(f.requests.includes('torrents/delete'), false);
    await f.poll();
    await f.poll();
    assert.equal(f.view().status, 'cancelled');
    assert.equal(f.requests.filter(item => item === 'torrents/delete').length, 1);
    await f.retained();
});
