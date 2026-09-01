import assert from 'node:assert/strict';
import test from 'node:test';
import {
    classifyTelegramBotStartupError,
    getTelegramBotStatus,
    markTelegramBotError,
    markTelegramBotReady,
    markTelegramBotStarting,
    resetTelegramBotStatus,
    telegramBotBlocksReadiness,
} from './telegramBotStatus.js';

test('Bot status reports not configured, starting and ready without secrets', () => {
    resetTelegramBotStatus(false, '2026-08-24T00:00:00.000Z');
    assert.equal(getTelegramBotStatus().status, 'not_configured');
    markTelegramBotStarting('2026-08-24T00:01:00.000Z');
    assert.equal(getTelegramBotStatus().status, 'starting');
    markTelegramBotReady('2026-08-24T00:02:00.000Z');
    const status = getTelegramBotStatus();
    assert.equal(status.status, 'ready');
    assert.equal(status.lastConnectedAt, '2026-08-24T00:02:00.000Z');
    assert.equal(status.lastError, null);
    assert.equal(status.action, null);
    assert.doesNotMatch(JSON.stringify(status), /token|session/i);
});

test('required Bot errors block readiness while optional Bot errors are degraded', () => {
    resetTelegramBotStatus(true, '2026-08-24T00:00:00.000Z');
    markTelegramBotError('auth_failed', '认证失败', '检查 Telegram 凭证', '2026-08-24T00:03:00.000Z');
    assert.equal(telegramBotBlocksReadiness(getTelegramBotStatus(), true), true);
    assert.equal(telegramBotBlocksReadiness(getTelegramBotStatus(), false), false);
    assert.equal(getTelegramBotStatus().degraded, true);
});

test('Telegram ACCESS_TOKEN failures are classified as credential failures', () => {
    assert.equal(classifyTelegramBotStartupError(new Error('400: ACCESS_TOKEN_EXPIRED')), 'auth_failed');
    assert.equal(classifyTelegramBotStartupError(new Error('ACCESS_TOKEN_INVALID')), 'auth_failed');
});

test('a reconnect recovery returns status to ready and keeps counters', () => {
    resetTelegramBotStatus(true, '2026-08-24T00:00:00.000Z');
    markTelegramBotStarting('2026-08-24T00:01:00.000Z');
    markTelegramBotError('reconnecting', 'TIMEOUT', '等待自动重连', '2026-08-24T00:02:00.000Z');
    markTelegramBotReady('2026-08-24T00:03:00.000Z');
    const status = getTelegramBotStatus();
    assert.equal(status.status, 'ready');
    assert.equal(status.reconnectCount, 1);
    assert.equal(status.lastRecoveredAt, '2026-08-24T00:03:00.000Z');
});
