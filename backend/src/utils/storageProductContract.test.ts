import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStorageCapabilities, buildStorageStatsPayload, type StorageCapabilities } from './storageProductContract.js';

test('provider capability contract exposes share field support before opening the UI', () => {
    assert.deepEqual(buildStorageCapabilities('onedrive'), {
        share: true,
        sharePassword: true,
        shareExpiration: true,
        quota: true,
    } satisfies StorageCapabilities);
    assert.deepEqual(buildStorageCapabilities('google_drive'), {
        share: true,
        sharePassword: false,
        shareExpiration: false,
        quota: true,
    });
    assert.equal(buildStorageCapabilities('webdav').share, false);
});

test('storage stats never divide indexed bytes by temporary disk capacity', () => {
    const payload = buildStorageStatsPayload({
        disk: { totalBytes: 1_000, freeBytes: 250 },
        indexed: { usedBytes: 9_000, fileCount: 12 },
        remoteQuota: null,
        health: { probeStatus: 'available', lastProbedAt: '2026-07-22T00:00:00.000Z', cooldownUntil: null, cooldownReason: null },
    });
    assert.equal(payload.temporary.usedPercent, 75);
    assert.deepEqual(payload.indexed, { usedBytes: 9_000, fileCount: 12 });
    assert.equal(payload.remoteQuota, null);
});

test('remote quota percentage is derived only from provider quota', () => {
    const payload = buildStorageStatsPayload({
        disk: { totalBytes: 10_000, freeBytes: 7_000 },
        indexed: { usedBytes: 5_000, fileCount: 2 },
        remoteQuota: { totalBytes: 20_000, usedBytes: 5_000 },
        health: { probeStatus: null, lastProbedAt: null, cooldownUntil: '2026-07-23T00:00:00.000Z', cooldownReason: 'daily_upload_limit' },
    });
    assert.equal(payload.remoteQuota?.usedPercent, 25);
    assert.equal(payload.health.cooldownReason, 'daily_upload_limit');
});
