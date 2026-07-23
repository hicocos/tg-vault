import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadTelemetry, updateUploadTelemetry } from './uploadTelemetry.js';

test('upload telemetry reports smoothed speed and ETA from byte progress', () => {
    const start = createUploadTelemetry(1_000, 0);
    const first = updateUploadTelemetry(start, 250, 1_000);
    assert.equal(first.bytesPerSecond, 250);
    assert.equal(first.etaSeconds, 3);

    const second = updateUploadTelemetry(first, 500, 2_000);
    assert.equal(second.bytesPerSecond, 250);
    assert.equal(second.etaSeconds, 2);
});

test('upload telemetry remains safe for stalled, completed, or invalid samples', () => {
    const start = createUploadTelemetry(1_000, 100);
    const stalled = updateUploadTelemetry(start, 0, 100);
    assert.equal(stalled.bytesPerSecond, 0);
    assert.equal(stalled.etaSeconds, null);

    const completed = updateUploadTelemetry(stalled, 1_000, 1_100);
    assert.equal(completed.etaSeconds, 0);
    assert.equal(Number.isFinite(completed.bytesPerSecond), true);
});
