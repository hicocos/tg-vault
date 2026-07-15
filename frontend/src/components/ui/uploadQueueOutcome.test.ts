import assert from 'node:assert/strict';
import test from 'node:test';
import { getUploadQueueOutcome } from './uploadQueueOutcome.js';

const status = (value: 'pending' | 'uploading' | 'processing' | 'completed' | 'error' | 'cancelled') => ({ status: value });

test('upload queue distinguishes every terminal outcome', () => {
    assert.deepEqual(getUploadQueueOutcome([status('completed'), status('completed')]), {
        settled: true,
        kind: 'success',
        title: '上传完成',
    });
    assert.deepEqual(getUploadQueueOutcome([status('cancelled'), status('cancelled')]), {
        settled: true,
        kind: 'cancelled',
        title: '上传已取消',
    });
    assert.deepEqual(getUploadQueueOutcome([status('error'), status('error')]), {
        settled: true,
        kind: 'failed',
        title: '上传失败',
    });
    assert.deepEqual(getUploadQueueOutcome([status('completed'), status('error')]), {
        settled: true,
        kind: 'partial',
        title: '上传部分完成',
    });
});

test('upload queue remains in progress while any item is active', () => {
    assert.deepEqual(getUploadQueueOutcome([status('completed'), status('uploading')]), {
        settled: false,
        kind: 'uploading',
        title: '正在上传...',
    });
});
