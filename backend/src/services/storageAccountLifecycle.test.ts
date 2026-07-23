import assert from 'node:assert/strict';
import test from 'node:test';
import {
    deleteStorageAccountWithClient,
    lockStorageAccountForUse,
    lockStorageTargetForUse,
    switchStorageAccountWithClient,
    StorageAccountConflictError,
    StorageAccountNotFoundError,
} from './storageAccountLifecycle.js';

type Reply = { rows?: any[]; rowCount?: number; error?: Error };

class ScriptedClient {
    readonly calls: Array<{ text: string; params: unknown[] }> = [];
    constructor(private readonly replies: Reply[]) {}
    async query(text: string, params: unknown[] = []) {
        this.calls.push({ text, params });
        const reply = this.replies.shift();
        if (!reply) throw new Error(`Unexpected query: ${text}`);
        if (reply.error) throw reply.error;
        return { rows: reply.rows || [], rowCount: reply.rowCount ?? reply.rows?.length ?? 0 };
    }
}

test('delete locks account, rechecks every resumable task/upload reference, then atomically deletes indexes/account', async () => {
    const client = new ScriptedClient([
        { rows: [{ id: 'account', name: 'A', type: 's3', is_active: false }] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rowCount: 3 },
        { rows: [{ id: 'account' }], rowCount: 1 },
    ]);
    const result = await deleteStorageAccountWithClient(client as any, 'account');
    assert.deepEqual(result, { id: 'account', name: 'A', type: 's3', deletedFiles: 3 });
    assert.match(client.calls[0].text, /FOR UPDATE/);
    assert.match(client.calls[1].text, /telegram_background_jobs/);
    assert.match(client.calls[2].text, /transfer_tasks/);
    assert.match(client.calls[2].text, /retryable = true/);
    assert.match(client.calls[3].text, /storage_account_leases/);
    assert.match(client.calls[4].text, /telegram_write_reconciliations/);
    assert.match(client.calls[4].text, /chunk_upload_reconciliations/);
    assert.match(client.calls[4].text, /ytdlp_write_reconciliations/);
    assert.match(client.calls[5].text, /chunk_upload_sessions/);
    assert.match(client.calls[5].text, /status IN \('open', 'completing', 'failed'\)/);
    assert.match(client.calls[6].text, /target_account_id = NULL/);
    assert.match(client.calls[6].text, /status IN \('completed', 'cancelled'\)/);
    assert.match(client.calls[7].text, /DELETE FROM files/);
    assert.match(client.calls[8].text, /DELETE FROM storage_accounts/);
});

test('delete refuses an account referenced by an upload lease before deleting files', async () => {
    const client = new ScriptedClient([
        { rows: [{ id: 'account', name: 'A', type: 's3', is_active: false }] },
        { rows: [] },
        { rows: [] },
        { rows: [{ id: 'lease' }] },
    ]);
    await assert.rejects(
        deleteStorageAccountWithClient(client as any, 'account'),
        (error: unknown) => error instanceof StorageAccountConflictError && error.kind === 'upload',
    );
    assert.equal(client.calls.some(call => /DELETE FROM files/.test(call.text)), false);
});

test('delete refuses an account referenced by an open, completing, or failed resumable chunk session', async () => {
    for (const status of ['open', 'completing', 'failed']) {
        const client = new ScriptedClient([
            { rows: [{ id: 'account', name: 'A', type: 's3', is_active: false }] },
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [{ upload_id: 'upload', status }] },
        ]);
        await assert.rejects(
            deleteStorageAccountWithClient(client as any, 'account'),
            (error: unknown) => error instanceof StorageAccountConflictError && error.kind === 'upload',
        );
        assert.equal(client.calls.some(call => /DELETE FROM files/.test(call.text)), false);
    }
});

test('delete refuses an account referenced by an unfinished or retryable transfer task', async () => {
    for (const task of [
        { id: 'pending', status: 'pending', retryable: false },
        { id: 'running', status: 'running', retryable: false },
        { id: 'failed', status: 'failed', retryable: true },
        { id: 'cancelled', status: 'cancelled', retryable: true },
    ]) {
        const client = new ScriptedClient([
            { rows: [{ id: 'account', name: 'A', type: 's3', is_active: false }] },
            { rows: [] },
            { rows: [task] },
        ]);
        await assert.rejects(
            deleteStorageAccountWithClient(client as any, 'account'),
            (error: unknown) => error instanceof StorageAccountConflictError && error.kind === 'job',
        );
        assert.equal(client.calls.some(call => /DELETE FROM files/.test(call.text)), false);
    }
});

test('delete failure after file delete is surfaced so caller transaction can roll back', async () => {
    const client = new ScriptedClient([
        { rows: [{ id: 'account', name: 'A', type: 'webdav', is_active: false }] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rowCount: 2 },
        { error: new Error('account delete failed') },
    ]);
    await assert.rejects(deleteStorageAccountWithClient(client as any, 'account'), /account delete failed/);
});

test('switch uses the same account row lock before changing active state', async () => {
    const client = new ScriptedClient([
        { rows: [{ id: 'account', type: 'google_drive' }] },
        { rowCount: 2 },
        { rowCount: 1 },
    ]);
    const type = await switchStorageAccountWithClient(client as any, 'account');
    assert.equal(type, 'google_drive');
    assert.match(client.calls[0].text, /FOR UPDATE/);
    assert.match(client.calls[1].text, /UPDATE storage_accounts SET is_active/);
    assert.match(client.calls[2].text, /active_storage_provider/);
});

test('job/upload user obtains FOR KEY SHARE so delete cannot pass concurrently', async () => {
    const client = new ScriptedClient([{ rows: [{ id: 'account', type: 'onedrive' }] }]);
    const row = await lockStorageAccountForUse(client as any, 'account');
    assert.equal(row.type, 'onedrive');
    assert.match(client.calls[0].text, /FOR KEY SHARE/);

    const missing = new ScriptedClient([{ rows: [] }]);
    await assert.rejects(lockStorageAccountForUse(missing as any, 'missing'), StorageAccountNotFoundError);
});

test('explicit upload target is account locked and provider bound', async () => {
    const cloud = new ScriptedClient([{ rows: [{ id: 'account-a', type: 's3' }] }]);
    assert.deepEqual(await lockStorageTargetForUse(cloud as any, 's3', 'account-a'), { provider: 's3', accountId: 'account-a' });
    assert.match(cloud.calls[0].text, /FOR KEY SHARE/);

    const mismatch = new ScriptedClient([{ rows: [{ id: 'account-a', type: 's3' }] }]);
    await assert.rejects(() => lockStorageTargetForUse(mismatch as any, 'google_drive', 'account-a'), /provider 不匹配/);
    await assert.rejects(() => lockStorageTargetForUse(new ScriptedClient([]) as any, 's3', null), /缺少账户/);
    assert.deepEqual(await lockStorageTargetForUse(new ScriptedClient([]) as any, 'local', null), { provider: 'local', accountId: null });
});
