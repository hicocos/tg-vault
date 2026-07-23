import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
    beginYtDlpWrite,
    claimYtDlpExecution,
    reconcileCommittedYtDlpWrites,
    settleYtDlpExecution,
    updateYtDlpExecutionProgress,
} from './ytDlpExecution.js';

class ScriptedDb {
    calls: Array<{ text: string; params: unknown[] }> = [];
    constructor(private readonly replies: Array<{ rows?: any[]; rowCount?: number }>) {}
    async query(text: string, params: unknown[] = []) {
        this.calls.push({ text, params });
        const reply = this.replies.shift();
        if (!reply) throw new Error(`Unexpected query: ${text}`);
        return { rows: reply.rows || [], rowCount: reply.rowCount ?? reply.rows?.length ?? 0 };
    }
}

test('claim is atomic and increments execution generation while excluding unresolved writes', async () => {
    const claimed = new ScriptedDb([{ rows: [{ execution_generation: 4, lease_token: 'lease-a' }], rowCount: 1 }]);
    assert.deepEqual(await claimYtDlpExecution(claimed, 'task-1', 'lease-a'), { generation: 4, leaseToken: 'lease-a' });
    assert.match(claimed.calls[0].text, /status IN \('pending', 'failed', 'interrupted', 'retry_required'\)/);
    assert.match(claimed.calls[0].text, /execution_generation = execution_generation \+ 1/);
    assert.match(claimed.calls[0].text, /NOT EXISTS[\s\S]*ytdlp_write_reconciliations/);

    const loser = new ScriptedDb([{ rows: [], rowCount: 0 }]);
    assert.equal(await claimYtDlpExecution(loser, 'task-1', 'lease-b'), null);
});

test('progress and terminal settlement are generation and lease scoped', async () => {
    const progressDb = new ScriptedDb([{ rowCount: 0 }]);
    assert.equal(await updateYtDlpExecutionProgress(progressDb, 'task-1', 3, 'old-lease', { stage: 'uploading', progress: 92 }), false);
    assert.match(progressDb.calls[0].text, /execution_generation = \$3/);
    assert.match(progressDb.calls[0].text, /lease_token = \$4::uuid/);
    assert.match(progressDb.calls[0].text, /cancel_requested = false/);

    const settleDb = new ScriptedDb([{ rowCount: 0 }]);
    assert.equal(await settleYtDlpExecution(settleDb, {
        id: 'task-1', generation: 3, leaseToken: 'old-lease', status: 'completed', stage: 'completed',
    }), false);
    assert.match(settleDb.calls[0].text, /status = 'running'/);
    assert.match(settleDb.calls[0].text, /execution_generation = \$3/);
    assert.match(settleDb.calls[0].text, /lease_token = \$4::uuid/);
});

test('write-ahead journal can only begin for the currently claimed execution', async () => {
    const db = new ScriptedDb([{ rows: [{ operation_id: 'op-1' }], rowCount: 1 }]);
    assert.equal(await beginYtDlpWrite(db, {
        operationId: 'op-1', taskId: 'task-1', generation: 2, leaseToken: 'lease-a', provider: 's3', accountId: 'account-a',
    }), 'op-1');
    assert.match(db.calls[0].text, /INSERT INTO ytdlp_write_reconciliations/);
    assert.match(db.calls[0].text, /status = 'running'/);
    assert.match(db.calls[0].text, /execution_generation = \$3/);
    assert.match(db.calls[0].text, /lease_token = \$4::uuid/);
});

test('restart reconciliation completes only an exact object and index match', async () => {
    const db = new ScriptedDb([{ rows: [{ count: '1' }], rowCount: 1 }]);
    assert.equal(await reconcileCommittedYtDlpWrites(db), 1);
    const sql = db.calls[0].text;
    assert.match(sql, /f\.id = r\.file_id/);
    assert.match(sql, /f\.path = r\.stored_path/);
    assert.match(sql, /f\.source = r\.provider/);
    assert.match(sql, /f\.storage_account_id IS NOT DISTINCT FROM r\.account_id/);
    assert.match(sql, /t\.execution_generation = c\.execution_generation/);
    assert.match(sql, /UPDATE ytdlp_write_reconciliations/);
    assert.match(sql, /resolution = 'committed'/);
});

test('production yt-dlp admission locks its account before task persistence', () => {
    const source = fs.readFileSync(new URL('./ytDlpDownload.ts', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('export async function handleYtDlpCommand'));
    assert.match(block, /lockStorageAccountForUse/);
    assert.match(block, /ytdlp_admission/);
    assert.ok(block.indexOf('lockStorageAccountForUse') < block.indexOf('createTransferTask'));
});