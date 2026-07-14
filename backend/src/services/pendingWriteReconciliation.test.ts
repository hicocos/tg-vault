import assert from 'node:assert/strict';
import test from 'node:test';
import {
    claimChunkReconciliations,
    resolveClaimedChunkReconciliation,
} from './chunkUploadReconciliation.js';
import {
    beginTelegramWriteReconciliation,
    markTelegramWriteObjectPresent,
    markTelegramWriteIndexPresent,
    updateTelegramWriteAfterCompensation,
    resolveClaimedTelegramWrite,
} from './telegramWriteReconciliation.js';

test('chunk journal claim uses a transactional skip-locked lease', async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const db = { query: async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        return { rows: [{ operation_id: 'op-1', upload_id: 'up-1', completion_token: 'ct-1', provider: 's3', account_id: null, stored_path: null, file_id: null, object_state: 'unknown', index_state: 'unknown', session_status: 'failed', completed_file_id: null }], rowCount: 1 };
    } };
    const rows = await claimChunkReconciliations(db, 'lease-1', 10);
    assert.equal(rows.length, 1);
    assert.match(calls[0].text, /FOR UPDATE SKIP LOCKED/);
    assert.match(calls[0].text, /resolution IS DISTINCT FROM 'operator_required'/);
    assert.match(calls[0].text, /lease_token = \$1::uuid/);
    assert.match(calls[0].text, /lease_expires_at/);
});

test('chunk unknown object without an exact stored path becomes operator-required and is never retried blindly', async () => {
    const calls: string[] = [];
    let deletes = 0;
    const result = await resolveClaimedChunkReconciliation({
        db: { query: async (text: string) => { calls.push(text); return { rows: [], rowCount: 1 }; } },
        leaseToken: 'lease-1',
        row: { operationId: 'op-1', uploadId: 'up-1', completionToken: 'ct-1', provider: 's3', accountId: null, storedPath: null, fileId: null, objectState: 'unknown', indexState: 'unknown', sessionStatus: 'failed', completedFileId: null },
        deleteObject: async () => { deletes += 1; },
    });
    assert.equal(result, 'operator-required');
    assert.equal(deletes, 0);
    assert.match(calls.join('\n'), /resolution = 'operator_required'/);
    assert.doesNotMatch(calls.join('\n'), /status = 'resolved'/);
});

test('chunk journal resolves committed output when session and exact index are terminal', async () => {
    const calls: string[] = [];
    const result = await resolveClaimedChunkReconciliation({
        db: { query: async (text: string) => { calls.push(text); return { rows: [], rowCount: 1 }; } },
        leaseToken: 'lease-1',
        row: { operationId: 'op-1', uploadId: 'up-1', completionToken: 'ct-1', provider: 's3', accountId: null, storedPath: 'bucket/key', fileId: 'file-1', objectState: 'present', indexState: 'present', sessionStatus: 'completed', completedFileId: 'file-1' },
        deleteObject: async () => { throw new Error('must not compensate committed output'); },
    });
    assert.equal(result, 'resolved');
    assert.match(calls.join('\n'), /resolution = 'committed'/);
    assert.match(calls.join('\n'), /status = 'resolved'/);
});

test('telegram journal persists immutable child lease and exact storage evidence', async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const db = { query: async (text: string, params?: unknown[]) => { calls.push({ text, params }); return { rows: [], rowCount: 1 }; } };
    const operationId = await beginTelegramWriteReconciliation(db, {
        jobId: '11111111-1111-4111-8111-111111111111', itemId: '22222222-2222-4222-8222-222222222222',
        childLeaseToken: '33333333-3333-4333-8333-333333333333', provider: 's3', accountId: null,
    });
    await markTelegramWriteObjectPresent(db, operationId, 'bucket/key');
    await markTelegramWriteIndexPresent(db, operationId, '44444444-4444-4444-8444-444444444444');
    assert.match(calls[0].text, /telegram_write_reconciliations/);
    assert.deepEqual(calls[0].params?.slice(1), [
        '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333', 's3', null,
    ]);
    assert.match(calls[1].text, /object_state = 'present'/);
    assert.match(calls[2].text, /index_state = 'present'/);
});

test('telegram failed compensation keeps partial evidence pending for restart resolver', async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const db = { query: async (text: string, params?: unknown[]) => { calls.push({ text, params }); return { rows: [], rowCount: 1 }; } };
    await updateTelegramWriteAfterCompensation(db, 'op-1', { objectState: 'unknown', indexState: 'deleted', reason: 'provider timeout' });
    assert.match(calls[0].text, /status = CASE/);
    assert.deepEqual(calls[0].params?.slice(1), ['unknown', 'deleted', 'provider timeout', false]);
});

test('telegram resolver binds boolean and reason parameters in SQL order', async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const db = { query: async (text: string, params?: unknown[]) => { calls.push({ text, params }); return { rows: [], rowCount: 1 }; } };
    const result = await resolveClaimedTelegramWrite({
        db,
        leaseToken: '55555555-5555-4555-8555-555555555555',
        row: {
            operationId: 'op-1', jobId: 'job-1', itemId: 'item-1', childLeaseToken: 'child-1', provider: 's3', accountId: null,
            storedPath: 'bucket/key', fileId: '44444444-4444-4444-8444-444444444444', objectState: 'deleted', indexState: 'present', itemStatus: 'failed',
        },
        deleteObject: async () => undefined,
    });
    assert.equal(result, 'resolved');
    const update = calls.at(-1)!;
    assert.match(update.text, /status = CASE WHEN \$5::boolean/);
    assert.equal(update.params?.[4], true);
    assert.equal(update.params?.[5], '重启扫描补偿已确认');
});

test('chunk and telegram resolvers treat an already-missing file index as idempotently deleted', async () => {
    const chunkCalls: Array<{ text: string; params?: unknown[] }> = [];
    const chunkResult = await resolveClaimedChunkReconciliation({
        db: { query: async (text: string, params?: unknown[]) => { chunkCalls.push({ text, params }); return { rows: [], rowCount: /DELETE FROM files/.test(text) ? 0 : 1 }; } },
        leaseToken: '55555555-5555-4555-8555-555555555555',
        row: { operationId: 'op-1', uploadId: 'up-1', completionToken: 'ct-1', provider: 's3', accountId: null, storedPath: 'bucket/key', fileId: 'file-1', objectState: 'deleted', indexState: 'present', sessionStatus: 'failed', completedFileId: null },
        deleteObject: async () => undefined,
    });
    assert.equal(chunkResult, 'resolved');
    assert.equal(chunkCalls.at(-1)?.params?.[4], true);

    const telegramCalls: Array<{ text: string; params?: unknown[] }> = [];
    const telegramResult = await resolveClaimedTelegramWrite({
        db: { query: async (text: string, params?: unknown[]) => { telegramCalls.push({ text, params }); return { rows: [], rowCount: /DELETE FROM files/.test(text) ? 0 : 1 }; } },
        leaseToken: '55555555-5555-4555-8555-555555555555',
        row: { operationId: 'op-2', jobId: 'job-1', itemId: 'item-1', childLeaseToken: 'child-1', provider: 's3', accountId: null, storedPath: 'bucket/key', fileId: 'file-1', objectState: 'deleted', indexState: 'present', itemStatus: 'failed' },
        deleteObject: async () => undefined,
    });
    assert.equal(telegramResult, 'resolved');
    assert.equal(telegramCalls.at(-1)?.params?.[4], true);
});

