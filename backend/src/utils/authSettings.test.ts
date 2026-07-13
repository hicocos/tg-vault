import assert from 'node:assert/strict';
import { createInitialAdminCredentialsWithClient } from './authSettings.js';

const calls: Array<{ text: string; params?: unknown[] }> = [];
const fakeClient = {
    async query(text: string, params?: unknown[]) {
        calls.push({ text, params });
        if (/SELECT value/.test(text)) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
    },
};

await createInitialAdminCredentialsWithClient(fakeClient as any, 'password-123', '1234');
assert.match(calls[0].text, /pg_advisory_xact_lock/);
assert.equal(calls.filter(call => /INSERT INTO system_settings/.test(call.text)).length, 2);
assert.ok(calls.every(call => !/COMMIT|ROLLBACK|BEGIN/.test(call.text)), 'transaction ownership belongs to the caller');

const initializedClient = {
    async query(text: string) {
        if (/SELECT value/.test(text)) return { rows: [{ value: 'already' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
    },
};
await assert.rejects(
    () => createInitialAdminCredentialsWithClient(initializedClient as any, 'password-456', '5678'),
    /管理员密码已创建/,
);

console.log('atomic admin setup ok');
