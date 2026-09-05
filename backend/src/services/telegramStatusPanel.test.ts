import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTelegramStatusPanel, sanitizeTelegramStatusText } from './telegramStatusPanel.js';

const input = {
    requestId: 'req-1234',
    bot: { status: 'ready', degraded: false, reconnectCount: 1, lastError: null, action: null },
    userClient: { status: 'expired', username: 'admin', action: '重新生成 session 并重启后端', lastError: '/root/data/session secret-token' },
    target: { provider: 's3', accountName: 'Archive', probeStatus: 'failed', cooldownUntil: '2026-08-24T12:00:00Z', probeError: 'AccessKey AKIA-SECRET denied at /root/data' },
    disk: { freeBytes: 1024, totalBytes: 4096 },
    queue: { active: 2, pending: 3, failed: 1, paused: false },
    subscriptions: { enabled: 4, lastScanAt: '2026-08-24T10:00:00Z', lastError: 'channel denied token=abc' },
    reconciliation: { pending: 2, operatorRequired: 1 },
};

test('status panel presents every operational component and an operation id', () => {
    const text = buildTelegramStatusPanel(input as any);
    for (const expected of ['req-1234', 'Bot：正常', '账号下载器：登录已过期', '当前存储：s3 · Archive', '连接检查：异常', '临时磁盘：可用 1 KB / 4 KB', '队列', '订阅', '待对账：2', '需人工：1']) {
        assert.match(text, new RegExp(expected));
    }
});

test('status panel redacts absolute paths credentials tokens and raw provider errors', () => {
    const text = buildTelegramStatusPanel(input as any);
    assert.doesNotMatch(text, /\/root\/data/);
    assert.doesNotMatch(text, /AKIA-SECRET/);
    assert.doesNotMatch(text, /secret-token|token=abc/);
    assert.match(text, /已脱敏/);
    assert.equal(sanitizeTelegramStatusText('Bearer abc /home/user/x password=hunter2'), '[已脱敏]');
});

test('status panel localizes labels, dates, and byte formatting', () => {
    const text = buildTelegramStatusPanel(input as any, 'en');
    assert.match(text, /Bot: Healthy/);
    assert.match(text, /Temporary disk: 1 KB free \/ 4 KB/);
    assert.doesNotMatch(text, /2026-08-24T12:00:00Z/);
    assert.doesNotMatch(text, /当前存储|队列/);
});
