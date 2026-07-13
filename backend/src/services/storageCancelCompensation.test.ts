import assert from 'node:assert/strict';
import test from 'node:test';
import { compensateIndexedWriteAfterCancel } from './storageWrite.js';

test('cancel after indexed save removes the exact index and object', async () => {
    const calls: string[] = [];
    const outcome = await compensateIndexedWriteAfterCancel({
        fileId: 'file-1',
        savedPath: 'remote/object',
        deleteIndex: async id => { calls.push(`index:${id}`); return true; },
        deleteObject: async path => { calls.push(`object:${path}`); },
    });
    assert.equal(outcome.status, 'compensated');
    assert.deepEqual(calls, ['object:remote/object', 'index:file-1']);
});

test('cancel compensation reports reconciliation when object cleanup fails', async () => {
    const outcome = await compensateIndexedWriteAfterCancel({
        fileId: 'file-1',
        savedPath: 'remote/object',
        deleteIndex: async () => true,
        deleteObject: async () => { throw new Error('provider timeout'); },
    });
    assert.equal(outcome.status, 'reconciliation-required');
    assert.match(outcome.error || '', /provider timeout/);
});
