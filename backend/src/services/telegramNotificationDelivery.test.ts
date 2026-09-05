import assert from 'node:assert/strict';
import test from 'node:test';
import {
    enqueueTelegramNotification,
    flushTelegramNotificationDigest,
} from './telegramNotificationDelivery.js';

const preferences = {
    failureImmediate: true,
    successMode: 'digest' as const,
    security: true as const,
    subscriptionDigest: true,
    timezone: 'UTC', quietStart: null, quietEnd: null,
};

test('delivery sends security immediately and queues digest events durably', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const sent: string[] = [];
    const deps = {
        getPreferences: async () => preferences,
        runQuery: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows: [] } as any; },
        send: async (_chatId: string, text: string) => { sent.push(text); },
        now: () => new Date('2026-08-24T12:00:00Z'),
    };
    await enqueueTelegramNotification({ userId: 1, chatId: '1', kind: 'security', message: '安全告警' }, deps);
    await enqueueTelegramNotification({ userId: 1, chatId: '1', kind: 'success', message: '成功' }, deps);
    assert.deepEqual(sent, ['安全告警']);
    assert.ok(calls.some(call => /INSERT INTO telegram_notification_digest/.test(call.sql)));
});

test('failed digest send releases the claim without marking it delivered', async () => {
    const calls: string[] = [];
    const rows = [{ id: 'a', kind: 'success', payload: { message: 'A' } }];
    await assert.rejects(() => flushTelegramNotificationDigest(1, '1', {
        runQuery: async (sql: string) => { calls.push(sql); return { rows: /RETURNING d\./.test(sql) ? rows : [] } as any; },
        send: async () => { throw new Error('send failed'); },
        getLocale: async () => 'zh-CN',
    }), /send failed/);
    assert.ok(calls.some(sql => /claimed_at = NULL/.test(sql)));
    assert.ok(calls.every(sql => !/delivered_at = NOW/.test(sql)));
});

test('digest flush claims pending events and marks them delivered after one summary', async () => {
    const sent: string[] = [];
    const calls: string[] = [];
    const rows = [{ id: 'a', kind: 'success', payload: { message: '完成 A' } }, { id: 'b', kind: 'subscription', payload: { message: '同步 B' } }];
    const result = await flushTelegramNotificationDigest(1, '1', {
        runQuery: async (sql: string) => { calls.push(sql); return { rows: /RETURNING d\./.test(sql) ? rows : [] } as any; },
        send: async (_chat, text) => { sent.push(text); },
        getLocale: async () => 'zh-CN',
    });
    assert.equal(result, 2);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /完成 A/);
    assert.ok(calls.some(sql => /delivered_at = NOW/.test(sql)));
});

test('digest semantic events render using recipient locale at flush time', async () => {
    const sent: string[] = [];
    const rows = [{ id: 'a', kind: 'subscription', payload: { message: '旧中文', messageKey: 'channels.subscriptionComplete', messageParams: { source: '@news', successful: 1, failed: 0 } } }];
    await flushTelegramNotificationDigest(1, '1', {
        runQuery: async sql => ({ rows: /RETURNING d\./.test(sql) ? rows : [] } as any),
        send: async (_chat, text) => { sent.push(text); },
        getLocale: async () => 'en',
    });
    assert.match(sent[0], /Notification digest/);
    assert.doesNotMatch(sent[0], /旧中文/);
});
