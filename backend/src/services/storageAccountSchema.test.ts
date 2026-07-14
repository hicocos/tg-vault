import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

test('lease history cascades when its storage account is deleted', () => {
    assert.match(schema, /storage_account_id UUID NOT NULL REFERENCES storage_accounts\(id\) ON DELETE CASCADE/);
    assert.match(schema, /storage_account_leases_storage_account_id_fkey[\s\S]*ON DELETE CASCADE/);
});

test('terminal chunk upload sessions release their account foreign key on delete', () => {
    assert.match(schema, /target_account_id UUID REFERENCES storage_accounts\(id\) ON DELETE SET NULL/);
    assert.match(schema, /chunk_upload_sessions_target_account_id_fkey[\s\S]*ON DELETE SET NULL/);
});
