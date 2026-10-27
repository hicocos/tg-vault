import assert from 'node:assert/strict';
import test from 'node:test';
import { qbDownloadProgress, QbTransferProgress, type QbTransferSample } from '../src/services/qbittorrentProgress.js';

test('BT downloaded bytes count only selected contents with byte weighting', () => {
    const result = qbDownloadProgress([
        { index: 0, name: 'small', size: 10, progress: 1, priority: 1 },
        { index: 1, name: 'large', size: 90, progress: 0.5, priority: 1 },
        { index: 2, name: 'excluded', size: 1000, progress: 1, priority: 0 },
    ]);
    assert.deepEqual(result, { totalBytes: 100, downloadedBytes: 55, downloadProgress: 55 });
});

test('BT upload progress uses committed bytes plus current attempt and reserves completion for indexing', async () => {
    let now = 0;
    const samples: QbTransferSample[] = [];
    const progress = new QbTransferProgress({ committedBytes: 100, fileBytes: 900, totalBytes: 1000,
        now: () => now, persist: async sample => { samples.push(sample); } });
    now = 1000;
    progress.report(450);
    await progress.flush();
    assert.deepEqual(samples.at(-1), { transferredBytes: 550, progress: 55, uploadSpeed: 450 });
    now = 2000;
    progress.report(0);
    await progress.flush();
    assert.equal(samples.at(-1)!.transferredBytes, 100);
    assert.equal(samples.at(-1)!.uploadSpeed, 0);
    now = 3000;
    progress.report(9000);
    await progress.flush();
    assert.equal(samples.at(-1)!.transferredBytes, 1000);
    assert.equal(samples.at(-1)!.progress, 99);
    await progress.close();
    progress.report(50);
    assert.equal(samples.at(-1)!.transferredBytes, 1000);
});

test('BT progress joins in-flight persistence before final indexing and retains newer samples', async () => {
    let now = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const samples: QbTransferSample[] = [];
    const progress = new QbTransferProgress({ committedBytes: 0, fileBytes: 100, totalBytes: 100, now: () => now,
        persist: async sample => { samples.push(sample); if (samples.length === 1) await gate; } });
    now = 1000;
    progress.report(25);
    const firstFlush = progress.flush();
    await Promise.resolve();
    now = 1200;
    progress.report(75);
    const flush = progress.flush();
    release();
    await flush;
    await firstFlush;
    assert.deepEqual(samples.map(sample => sample.transferredBytes), [25, 75]);
    await progress.close();
});

test('BT empty-file progress stays finite and waits for indexing to become complete', async () => {
    const samples: QbTransferSample[] = [];
    const progress = new QbTransferProgress({ committedBytes: 0, fileBytes: 0, totalBytes: 0,
        persist: async sample => { samples.push(sample); } });
    try {
        progress.report(0);
        await progress.flush();
        assert.deepEqual(samples, [{ transferredBytes: 0, progress: 0, uploadSpeed: 0 }]);
    } finally { await progress.close(); }
});

test('BT progress persistence failures block final success instead of silently dropping the sample', async () => {
    const failure = new Error('database unavailable');
    const progress = new QbTransferProgress({ committedBytes: 0, fileBytes: 100, totalBytes: 100,
        persist: async () => { throw failure; } });
    try {
        progress.report(50);
        await assert.rejects(progress.flush(), error => error === failure);
    } finally { await progress.close(); }
});

test('BT upload speed clears when no new bytes arrive while awaiting storage confirmation', async () => {
    let now = 0;
    const samples: QbTransferSample[] = [];
    const progress = new QbTransferProgress({ committedBytes: 0, fileBytes: 100, totalBytes: 100, now: () => now,
        persist: async sample => { samples.push(sample); } });
    try {
        now = 1000;
        progress.report(50);
        await progress.flush();
        assert.equal(samples.at(-1)!.uploadSpeed, 50);
        now = 2000;
        await progress.flush();
        assert.equal(samples.at(-1)!.transferredBytes, 50);
        assert.equal(samples.at(-1)!.uploadSpeed, 0);
    } finally { await progress.close(); }
});
