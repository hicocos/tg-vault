import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DownloadTaskQueue } from '../src/services/downloadTaskQueue.js';
import { TelegramIngressLimit } from '../src/services/telegramIngressLimit.js';
import { TelegramDiskReservations } from '../src/services/telegramDiskReservations.js';

const ingressOptions = { windowMs: 60000, messageMax: 30, fileMax: 120, controlMax: 60, heavyWindowMs: 600000, heavyMax: 5 };

test('50 forwarded files do not spend status or cancellation quota; exhausted buckets remain independent', () => {
    let now = 100000;
    const limit = new TelegramIngressLimit(ingressOptions, () => now);
    for (let i = 0; i < 120; i++) assert.equal(limit.consume(1, 'file').limited, false);
    assert.equal(limit.consume(1, 'file').limited, true);
    assert.equal(limit.consume(1, 'control').limited, false);
    assert.equal(limit.consume(1, 'message').limited, false);
    assert.equal(limit.consume(2, 'file').limited, false);
    now += 60000;
    assert.equal(limit.consume(1, 'file').limited, false);
});

for (const concurrency of [2, 7]) test(`slow storage does not consume the ${concurrency} configured download slots`, async () => {
    let sequence = 0;
    let downloads = 0;
    let reached!: () => void;
    const refilled = new Promise<void>(resolve => { reached = resolve; });
    const releases: Array<() => void> = [];
    const queue = new DownloadTaskQueue({ maxConcurrent: concurrency, idFactory: () => String(++sequence) });
    queue.ensureGroup({ id: 'burst', kind: 'album', title: 'burst', chatId: '1', expectedTotal: 50 });
    const jobs = Array.from({ length: 50 }, (_, index) => {
        const gate = new Promise<void>(resolve => { releases.push(resolve); });
        return queue.add('burst', String(index), async (signal, id) => {
            if (++downloads === concurrency + 3) reached();
            await gate;
            signal.throwIfAborted();
            await queue.beginUpload(id!);
            await delay(10000, undefined, { signal });
        }, 1024 ** 3);
    });
    try {
        assert.equal(queue.getGroupSnapshot('burst')!.downloading, concurrency);
        for (const release of releases.slice(0, 3)) release();
        await refilled;
        const group = queue.getGroupSnapshot('burst')!;
        assert.equal(group.downloading, concurrency);
        assert.equal(group.uploading, 3);
        assert.equal(group.waitingUpload, 0);
        assert.equal(group.pending, 50 - concurrency - 3);
    } finally {
        queue.cancelGroup('burst', {});
        for (const release of releases) release();
        await Promise.all(jobs);
    }
    assert.equal(queue.getStats().total, 0);
});

test('file concurrency increases open slots and decreases drain active files without interrupting them', async () => {
    const queue = new DownloadTaskQueue({ maxConcurrent: 2 });
    queue.ensureGroup({ id: 'concurrency', kind: 'album', title: 'concurrency', chatId: '1', expectedTotal: 9 });
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const jobs = Array.from({ length: 9 }, (_, index) => {
        const gate = new Promise<void>(resolve => { releases.push(resolve); });
        return queue.add('concurrency', String(index), async signal => {
            started.push(index);
            await gate;
            assert.equal(signal.aborted, false);
        }, 1024);
    });
    try {
        assert.deepEqual(started, [0, 1]);
        queue.setMaxConcurrent(7);
        assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
        assert.equal(queue.getStats().pending, 2);

        queue.setMaxConcurrent(1);
        assert.equal(queue.getStats().active, 7);
        for (const release of releases.slice(0, 6)) release();
        await Promise.all(jobs.slice(0, 6));
        assert.equal(queue.getStats().active, 1);
        assert.equal(queue.getStats().pending, 2);

        releases[6]();
        await jobs[6];
        assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7]);
        assert.equal(queue.getStats().active, 1);
        releases[7]();
        await jobs[7];
        assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
        releases[8]();
        await jobs[8];
        assert.equal(queue.getStats().total, 0);
    } finally {
        for (const release of releases) release();
        await Promise.all(jobs);
    }
});

test('large downloads fill configured concurrency regardless of combined file size', async () => {
    const queue = new DownloadTaskQueue({ maxConcurrent: 7 });
    queue.ensureGroup({ id: 'large', kind: 'channel', title: 'large', chatId: '1', expectedTotal: 10 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: number[] = [];
    const jobs = Array.from({ length: 10 }, (_, index) => queue.add('large', String(index), async () => {
        started.push(index);
        await gate;
    }, index === 0 ? 5 * 1024 ** 3 : 1024 ** 3));
    try {
        assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
        assert.equal(queue.getStats().pending, 3);
    } finally {
        release();
        await Promise.all(jobs);
    }
});

test('large uploads do not consume the single configured download slot', async () => {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    queue.ensureGroup({ id: 'staging', kind: 'channel', title: 'staging', chatId: '1', expectedTotal: 3 });
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
    const started: number[] = [];
    const first = queue.add('staging', 'oversized', async (_signal, id) => {
        started.push(0);
        await queue.beginUpload(id!);
        await uploadGate;
    }, 5 * 1024 ** 3);
    const second = queue.add('staging', 'next', async () => { started.push(1); }, 1024 ** 3);
    const third = queue.add('staging', 'last', async () => { started.push(2); }, 1024 ** 3);
    try {
        await Promise.all([second, third]);
        assert.deepEqual(started, [0, 1, 2]);
        assert.equal(queue.getGroupSnapshot('staging')!.uploading, 1);
        assert.equal(queue.getStats().pending, 0);
        releaseUpload();
        await Promise.all([first, second, third]);
        assert.deepEqual(started, [0, 1, 2]);
        assert.equal(queue.getStats().total, 0);
    } finally {
        releaseUpload();
        await Promise.all([first, second, third]);
    }
});

test('uploads share ten slots across groups, refill on completion, and discard cancelled waiters', async () => {
    let sequence = 0;
    const queue = new DownloadTaskQueue({ maxConcurrent: 7, idFactory: () => String(++sequence) });
    queue.ensureGroup({ id: 'first', kind: 'album', title: 'first', chatId: '1', expectedTotal: 7 });
    queue.ensureGroup({ id: 'second', kind: 'album', title: 'second', chatId: '1', expectedTotal: 7 });
    const releases: Array<() => void> = [];
    const entered: Array<() => void> = [];
    const started = Array.from({ length: 14 }, () => new Promise<void>(resolve => { entered.push(resolve); }));
    const acquired: number[] = [];
    const jobs = Array.from({ length: 14 }, (_, index) => {
        const gate = new Promise<void>(resolve => { releases.push(resolve); });
        return queue.add(index < 7 ? 'first' : 'second', String(index), async (_signal, id) => {
            await queue.beginUpload(id!);
            acquired.push(index);
            entered[index]();
            await gate;
        }, 1024 ** 3);
    });
    try {
        await Promise.all(started.slice(0, 10));
        const groups = queue.getSnapshot().groups;
        assert.equal(groups.reduce((sum, group) => sum + group.uploading, 0), 10);
        assert.equal(groups.reduce((sum, group) => sum + group.waitingUpload, 0), 4);
        assert.deepEqual(acquired, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

        queue.cancel('14');
        await jobs[13];
        releases[0]();
        await jobs[0];
        await started[10];
        assert.equal(queue.getGroupSnapshot('second')!.uploading, 4);
        assert.equal(queue.getGroupSnapshot('second')!.waitingUpload, 2);

        releases[1]();
        releases[2]();
        await Promise.all([jobs[1], jobs[2], started[11], started[12]]);
        assert.deepEqual(acquired, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        assert.equal(queue.getGroupSnapshot('second')!.waitingUpload, 0);
    } finally {
        for (const release of releases) release();
        await Promise.all(jobs);
    }
    assert.equal(queue.getStats().total, 0);
});

test('disk reservations reject concurrent overcommit and release committed capacity', async () => {
    const dir = await fs.mkdtemp(`${os.tmpdir()}/tg-reserve-`);
    try {
        const disk = await fs.statfs(dir);
        const available = disk.bavail * disk.bsize;
        const reserve = Math.max(0, available - 16 * 1024 ** 2);
        const reservations = new TelegramDiskReservations();
        const results = await Promise.all([reservations.reserve('a', dir, 12 * 1024 ** 2, reserve), reservations.reserve('b', dir, 12 * 1024 ** 2, reserve)]);
        assert.equal(results[0].ok, true);
        assert.equal(results[1].ok, false);
        reservations.commit('a', 12 * 1024 ** 2);
        assert.equal((await reservations.reserve('b', dir, 12 * 1024 ** 2, reserve)).ok, true);
        reservations.release('a');
        reservations.release('b');
    } finally { await fs.rm(dir, { recursive: true }); }
});
