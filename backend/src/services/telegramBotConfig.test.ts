import assert from 'node:assert/strict';
import test from 'node:test';
import { testTelegramBotCredentials } from './telegramBotConfig.js';

const credentials = {
    botToken: '123456789:abcdefghijklmnopqrstuvwxyz_ABCDE',
    apiId: 12345,
    apiHash: '0123456789abcdef0123456789abcdef',
};

test('Bot credential probe performs one no-store HTTPS getMe request', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({
            ok: true,
            result: { id: 42, is_bot: true, username: 'vault_test_bot', first_name: 'Vault' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
        const result = await testTelegramBotCredentials(credentials);
        assert.deepEqual(result, { username: 'vault_test_bot', displayName: 'Vault' });
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /^https:\/\/api\.telegram\.org\/bot/);
        assert.equal(calls[0].init?.cache, 'no-store');
        assert.equal(calls[0].init?.redirect, 'error');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Bot credential probe fails closed on invalid Bot API identity', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })) as typeof fetch;
    try {
        await assert.rejects(() => testTelegramBotCredentials(credentials), /无法验证 Telegram Bot/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});