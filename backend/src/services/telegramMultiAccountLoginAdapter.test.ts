import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramMultiAccountAuthorizedAdapter } from './telegramMultiAccountLoginAdapter.js';

test('authorized adapter upserts by Telegram user id then activates only that account with the explicit login credentials', async () => {
    const calls: string[] = [];
    const adapter = createTelegramMultiAccountAuthorizedAdapter({
        repository: {
            async upsertAccount(input) {
                calls.push(`upsert:${input.telegramUserId}:${input.enabled}:${input.session}`);
                return { id: 'account-42' };
            },
        },
        pool: { async activateAccount(accountId, reason, credentials) { calls.push(`activate:${accountId}:${reason}:${credentials.apiId}:${credentials.apiHash}`); } },
    });
    await adapter.upsertByTelegramUserId({
        session: 'secret-session',
        credentials: { apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef' },
        account: { userId: '42', username: 'owner', displayName: 'Vault Owner' },
    });
    assert.deepEqual(calls, ['upsert:42:true:secret-session', 'activate:account-42:login_complete:12345:0123456789abcdef0123456789abcdef']);
});