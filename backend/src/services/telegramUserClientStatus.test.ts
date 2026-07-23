import assert from 'node:assert/strict';
import test from 'node:test';
import { getTelegramUserClientStatus, recordTelegramUserClientFailure, recordTelegramUserClientReady } from './telegramUserClientStatus.js';

test('Telegram user client readiness exposes actionable non-secret status', () => {
    recordTelegramUserClientReady({ userId: '123456', username: 'archive_bot', checkedAt: '2026-07-22T00:00:00.000Z' });
    assert.deepEqual(getTelegramUserClientStatus(), {
        status: 'ready',
        userId: '123456',
        username: 'archive_bot',
        checkedAt: '2026-07-22T00:00:00.000Z',
        lastError: null,
        action: null,
    });
});

test('expired and access errors have distinct recovery actions', () => {
    recordTelegramUserClientFailure('expired', 'session 已失效');
    assert.equal(getTelegramUserClientStatus().action, '重新生成 session 并重启后端');
    recordTelegramUserClientFailure('permission_denied', '当前账号未加入目标频道');
    assert.equal(getTelegramUserClientStatus().action, '先用该账号加入目标频道并重新测试');
});
