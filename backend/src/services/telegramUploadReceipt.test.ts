import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUploadSuccess, buildTaskControlButtons } from '../utils/telegramMessages.js';

import { buildUploadReceipt } from './telegramUploadReceipt.js';

test('successful receipt exposes actual target folder file id and duplicate outcome', () => {
    const receipt = buildUploadReceipt({
        taskId: 'task-1', fileName: 'photo.jpg', provider: 's3', accountName: 'Archive', folder: 'photos/2026',
        fileId: '12345678-1234-4000-8000-123456789abc', duplicateOutcome: 'copied', status: 'success',
    });
    assert.match(receipt.text, /s3 \/ Archive/);
    assert.match(receipt.text, /photos\/2026/);
    assert.match(receipt.text, /12345678-1234/);
    assert.match(receipt.text, /已生成副本/);
    assert.deepEqual(receipt.actions.map(action => action.action), ['find_folder', 'copy_id', 'delete_file']);
});

test('production single-upload receipt includes the actual indexed file id and follow-up actions', () => {
    const text = buildUploadSuccess('photo.jpg', 123, 'image', 's3', 'photos', '12345678-1234-4000-8000-123456789abc', 'copied');
    assert.match(text, /12345678-1234/);
    assert.match(text, /已生成副本/);
    assert.match(text, /可在“搜索和操作文件”中继续管理/);
});

test('upload receipt builders honor the recipient locale', () => {
    const text = buildUploadSuccess('photo.jpg', 1536, 'image', 's3', 'photos', '12345678-1234-4000-8000-123456789abc', 'copied', 'en');
    assert.match(text, /Upload complete/);
    assert.match(text, /1\.5 KB/);
    assert.match(text, /copy created/);
    assert.doesNotMatch(text, /上传成功|已生成副本/);
});

test('batch receipt remains one card and exposes retry-failed and failure details', () => {
    const receipt = buildUploadReceipt({
        taskId: 'batch-1', fileName: '相册', provider: 'local', accountName: '本地', folder: null,
        status: 'partial', total: 20, successful: 17, failed: 3,
    });
    assert.match(receipt.text, /成功 17/);
    assert.match(receipt.text, /失败 3/);
    assert.deepEqual(receipt.actions.map(action => action.action), ['retry_failed', 'failure_details']);
});

test('failed task card exposes actionable retry and failure-detail callbacks', () => {
    const rows = buildTaskControlButtons('task-1', false, undefined, false, false, 3)?.rows || [];
    const data = rows.flatMap(row => row.buttons.map(button => Buffer.from((button as any).data || []).toString('utf8')));
    assert.ok(data.includes('receipt_retry_task-1'));
    assert.ok(data.includes('receipt_failures_task-1'));
});

test('9+ item receipts stay in silent single-card mode', () => {
    const receipt = buildUploadReceipt({ taskId: 'batch-2', fileName: '批量文件', provider: 'local', accountName: '本地', status: 'running', total: 9 });
    assert.equal(receipt.silentSingleCard, true);
});

test('English upload receipts do not fall back to Chinese UI copy', () => {
    const receipt = buildUploadReceipt({ taskId: 'task-en', fileName: 'photo.jpg', provider: 'local', accountName: 'Archive', status: 'partial', total: 2, successful: 1, failed: 1, locale: 'en' });
    assert.doesNotMatch(receipt.text, /[\u3400-\u9fff]/);
    assert.deepEqual(receipt.actions.map(action => action.label), ['🔄 Retry failures (1)', 'Failure details']);
});
