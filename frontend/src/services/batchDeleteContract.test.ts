import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyBatchDeleteResponse } from './batchDeleteContract.js';

function response(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

test('207 response remains a typed partial result with deleted IDs and failed files', async () => {
    const result = await classifyBatchDeleteResponse(response(207, {
        status: 'partial',
        deletedIds: ['deleted-id'],
        failedFiles: [{ id: 'failed-id', name: 'failed.txt', error: 'provider timeout' }],
        message: '部分删除完成',
    }));

    assert.deepEqual(result, {
        status: 'partial',
        deletedIds: ['deleted-id'],
        failedFiles: [{ id: 'failed-id', name: 'failed.txt', error: 'provider timeout' }],
        message: '部分删除完成',
    });
});

test('complete response is a typed complete result', async () => {
    const result = await classifyBatchDeleteResponse(response(200, {
        status: 'complete',
        deletedIds: ['deleted-id'],
        failedFiles: [],
        message: '删除完成',
    }));
    assert.equal(result.status, 'complete');
});

test('failed response throws a typed error message', async () => {
    await assert.rejects(
        classifyBatchDeleteResponse(response(409, { code: 'CONFIRMATION_REPLAYED', error: '确认令牌已使用' })),
        /确认令牌已使用/,
    );
});
