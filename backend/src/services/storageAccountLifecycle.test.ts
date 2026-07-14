import assert from 'node:assert/strict';
import test from 'node:test';
import {
    deleteStorageAccountWithClient,
    lockStorageAccountForUse,
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

test('delete locks account, rechecks active jobs and upload leases, then atomically deletes indexes/account', async () => {
    const client = new ScriptedClient([
        { rows: [{ id: 'account', name: 'A', type: 's3', is_active: false }] },
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
    assert.match(client.calls[2].text, /storage_account_leases/);
    assert.match(client.calls[3].text, /chunk_upload_sessions/);
    assert.match(client.calls[3].text, /status IN \('open', 'completing'\)/);
    assert.match(client.calls[4].text, /DELETE FROM files/);
    assert.match(client.calls[5].text, /DELETE FROM storage_accounts/);
});

test('delete refuses an account referenced by an upload lease before deleting files', async () => {
    const client = new ScriptedClient([
        { rows: [{ id: 'account', name: 'A', type: 's3', is_active: false }] },
        { rows: [] },
        { rows: [{ id: 'lease' }] },
    ]);
    await assert.rejects(
        deleteStorageAccountWithClient(client as any, 'account'),
        (error: unknown) => error instanceof StorageAccountConflictError && error.kind === 'upload',
    );
    assert.equal(client.calls.some(call => /DELETE FROM files/.test(call.text)), false);
});

test('delete refuses an account referenced by an open or completing chunk session', async () => {
    for (const status of ['open', 'completing']) {
        const client = new ScriptedClient([
            { rows: [{ id: 'account', name: 'A', type: 's3', is_active: false }] },
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

test('delete failure after file delete is surfaced so caller transaction can roll back', async () => {
    const client = new ScriptedClient([
        { rows: [{ id: 'account', name: 'A', type: 'webdav', is_active: false }] },
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
