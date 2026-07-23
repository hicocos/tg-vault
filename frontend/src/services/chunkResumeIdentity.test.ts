import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, verifyResumeFileIdentity } from './chunkResumeIdentity.js';

test('resume rejects a same-name same-size file whose uploaded chunk content differs', async () => {
    const originalChunk = new Blob(['AAAA']);
    const replacement = new Blob(['BBBBCCCC']);
    await assert.rejects(
        verifyResumeFileIdentity(replacement, {
            totalSize: 8,
            maxChunkBytes: 4,
            uploadedChunks: [0],
            uploadedChunkHashes: { 0: await sha256Hex(originalChunk) },
        }),
        /内容与原上传任务不一致/,
    );
});

test('resume accepts a file when every previously uploaded chunk hash matches', async () => {
    const file = new Blob(['AAAABBBB']);
    await verifyResumeFileIdentity(file, {
        totalSize: 8,
        maxChunkBytes: 4,
        uploadedChunks: [0, 1],
        uploadedChunkHashes: {
            0: await sha256Hex(file.slice(0, 4)),
            1: await sha256Hex(file.slice(4, 8)),
        },
    });
});