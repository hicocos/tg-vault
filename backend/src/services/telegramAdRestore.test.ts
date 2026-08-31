import assert from 'node:assert/strict';
import test from 'node:test';
import { claimTelegramAdRestore } from './telegramAdRestore.js';

function clientWithRow(row: Record<string, unknown> | undefined) {
    const calls: string[] = [];
    return {
        calls,
        client: {
            async query(text: string) {
                calls.push(text);
                if (/SELECT d\.id/.test(text)) return { rows: row ? [row] : [] };
                return { rows: [], rowCount: 1 };
            },
        },
    };
}

const row = {
    id: 'decision-1', subscription_id: 'subscription-1', source_peer: '@channel', message_ids: [11],
    decision: 'blocked', restored_job_id: null, restore_status: 'not_requested', restore_attempted_at: null, user_id: 1, chat_id: 1, folder_override: null,
};

test('missing decision fails closed without claiming a restore', async () => {
    const fixture = clientWithRow(undefined);
    assert.deepEqual(await claimTelegramAdRestore(fixture.client as any, 'missing', true), { kind: 'missing' });
    assert.equal(fixture.calls.length, 1);
});

test('advertisement labels do not mutate restore state', async () => {
    const fixture = clientWithRow(row);
    const result = await claimTelegramAdRestore(fixture.client as any, 'decision-1', false);
    assert.equal(result.kind, 'claimed');
    assert.equal(fixture.calls.length, 1);
});

test('normal correction claims restoration and clears stale errors', async () => {
    const fixture = clientWithRow(row);
    const result = await claimTelegramAdRestore(fixture.client as any, 'decision-1', true);
    assert.equal(result.kind, 'claimed');
    assert.equal(fixture.calls.length, 2);
    assert.match(fixture.calls[1], /restore_status = 'restoring'/);
    assert.match(fixture.calls[1], /restore_error = NULL/);
});

test('existing restoration is idempotently reused', async () => {
    const fixture = clientWithRow({ ...row, restored_job_id: 'job-1', restore_status: 'restored' });
    const result = await claimTelegramAdRestore(fixture.client as any, 'decision-1', true);
    assert.equal(result.kind, 'existing');
    assert.equal(result.restoredJobId, 'job-1');
    assert.equal(fixture.calls.length, 1);
});

test('a fresh in-progress restoration rejects duplicate work', async () => {
    const fixture = clientWithRow({ ...row, restore_status: 'restoring', restore_attempted_at: new Date() });
    const result = await claimTelegramAdRestore(fixture.client as any, 'decision-1', true);
    assert.equal(result.kind, 'in_progress');
    assert.equal(fixture.calls.length, 1);
});
