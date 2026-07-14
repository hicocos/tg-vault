import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireStorageAccountLease, releaseStorageAccountLease } from './storageAccountLease.js';

class ScriptedClient {
    readonly calls: Array<{ text: string; params: unknown[] }> = [];
    constructor(private readonly replies: Array<{ rows?: any[]; rowCount?: number; error?: Error }>) {}
    async query(text: string, params: unknown[] = []) {
        this.calls.push({ text, params });
        const reply = this.replies.shift();
        if (!reply) throw new Error(`Unexpected query: ${text}`);
        if (reply.error) throw reply.error;
        return { rows: reply.rows || [], rowCount: reply.rowCount ?? reply.rows?.length ?? 0 };
    }
}

test('acquire atomically persists a TTL lease only when the account exists', async () => {
    const client = new ScriptedClient([
        { rows: [{ id: 'lease-id' }] },
    ]);
    const leaseId = await acquireStorageAccountLease(client as any, 'account', 'web_upload');
    assert.equal(leaseId, 'lease-id');
    assert.match(client.calls[0].text, /INSERT INTO storage_account_leases/);
    assert.match(client.calls[0].text, /SELECT \$1, id/);
    assert.match(client.calls[0].text, /FROM storage_accounts/);
    assert.deepEqual(client.calls[0].params.slice(1, 3), ['account', 'web_upload']);
});

test('release only releases the exact lease', async () => {
    const client = new ScriptedClient([{ rowCount: 1 }]);
    await releaseStorageAccountLease(client as any, 'lease-id');
    assert.match(client.calls[0].text, /WHERE id = \$1 AND released_at IS NULL/);
});
