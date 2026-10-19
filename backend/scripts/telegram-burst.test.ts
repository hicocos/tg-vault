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

test('slow storage applies count backpressure to a 50-file burst and cancellation releases all work', async () => {
    let sequence = 0;
    let downloads = 0;
    let reached!: () => void;
    const backpressured = new Promise<void>(resolve => { reached = resolve; });
    const queue = new DownloadTaskQueue({ maxConcurrent: 2, uploadConcurrency: 1, maxInFlight: 2, idFactory: () => String(++sequence) });
    queue.ensureGroup({ id: 'burst', kind: 'album', title: 'burst', chatId: '1', expectedTotal: 50 });
    const jobs = Array.from({ length: 50 }, (_, index) => queue.add('burst', String(index), async (signal, id) => {
        await Promise.resolve();
        const upload = queue.beginUpload(id!);
        if (++downloads === 2) reached();
        await upload;
        await delay(10000, undefined, { signal });
    }, 1024));
    await backpressured;
    const group = queue.getGroupSnapshot('burst')!;
    assert.equal(group.active, 2);
    assert.equal(group.uploading, 1);
    assert.equal(group.waitingUpload, 1);
    assert.equal(group.pending, 48);
    queue.cancelGroup('burst', {});
    await Promise.all(jobs);
    assert.equal(queue.getStats().total, 0);
});

test('byte budget serializes oversized files and resumes when staged work settles', async () => {
    let seq = 0;
    const queue = new DownloadTaskQueue({ maxConcurrent: 4, maxInFlight: 4, maxStagedBytes: 100 * 1024 ** 2, idFactory: () => String(++seq) });
    queue.ensureGroup({ id: 'bytes', kind: 'album', title: 'bytes', chatId: '1', expectedTotal: 2 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let starts = 0;
    const first = queue.add('bytes', 'large', async () => { starts++; await gate; }, 200 * 1024 ** 2);
    const second = queue.add('bytes', 'next', async () => { starts++; }, 70 * 1024 ** 2);
    assert.equal(starts, 1);
    assert.equal(queue.getStats().pending, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(starts, 2);
    assert.equal(queue.getStats().reservedBytes, 0);
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
