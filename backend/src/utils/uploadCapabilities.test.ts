import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUploadCapabilities } from './uploadCapabilities.js';

test('upload capabilities expose the server contract in bytes without secrets', () => {
    assert.deepEqual(buildUploadCapabilities({
        MAX_UPLOAD_CHUNK_MB: '32',
        MAX_CHUNK_UPLOAD_GB: '20',
        CHUNK_GLOBAL_BUDGET_GB: '40',
        CHUNK_SESSION_TTL_MS: '86400000',
        MAX_TOTAL_CHUNKS: '50000',
    }), {
        acceptsAnyFile: true,
        simpleUploadThresholdBytes: 40 * 1024 * 1024,
        simpleUploadMaxBytes: 2 * 1024 * 1024 * 1024,
        chunkBytes: 32 * 1024 * 1024,
        maxChunkUploadBytes: 20 * 1024 * 1024 * 1024,
        globalSessionBudgetBytes: 40 * 1024 * 1024 * 1024,
        maxChunks: 50000,
        sessionTtlMs: 86400000,
    });
});
