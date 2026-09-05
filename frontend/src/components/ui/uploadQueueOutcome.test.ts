import assert from 'node:assert/strict';
import test from 'node:test';
import { getUploadQueueOutcome } from './uploadQueueOutcome.js';
import zh from '../../locales/zh-CN/index';
import en from '../../locales/en/index';

const status = (value: 'pending' | 'uploading' | 'processing' | 'completed' | 'error' | 'cancelled') => ({ status: value });

test('upload queue distinguishes every terminal outcome', () => {
    assert.deepEqual(getUploadQueueOutcome([status('completed'), status('completed')]), {
        settled: true,
        kind: 'success',
        titleKey: 'outcomeSuccess',
    });
    assert.deepEqual(getUploadQueueOutcome([status('cancelled'), status('cancelled')]), {
        settled: true,
        kind: 'cancelled',
        titleKey: 'outcomeCancelled',
    });
    assert.deepEqual(getUploadQueueOutcome([status('error'), status('error')]), {
        settled: true,
        kind: 'failed',
        titleKey: 'outcomeFailed',
    });
    assert.deepEqual(getUploadQueueOutcome([status('completed'), status('error')]), {
        settled: true,
        kind: 'partial',
        titleKey: 'outcomePartial',
    });
    for (const key of ['outcomeSuccess', 'outcomeCancelled', 'outcomeFailed', 'outcomePartial'] as const) {
        assert.equal(typeof zh.files.ui.uploadQueue[key], 'string');
        assert.equal(typeof en.files.ui.uploadQueue[key], 'string');
        assert.notEqual(zh.files.ui.uploadQueue[key], en.files.ui.uploadQueue[key]);
    }
});

test('upload queue remains in progress while any item is active', () => {
    assert.deepEqual(getUploadQueueOutcome([status('completed'), status('uploading')]), {
        settled: false,
        kind: 'uploading',
        titleKey: 'outcomeUploading',
    });
    assert.equal(zh.files.ui.uploadQueue.outcomeUploading, '正在上传…');
    assert.equal(en.files.ui.uploadQueue.outcomeUploading, 'Uploading…');
});
