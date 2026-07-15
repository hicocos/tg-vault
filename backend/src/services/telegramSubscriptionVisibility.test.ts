import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isTelegramSubscriptionVisibleInManagement } from './telegramSubscriptionVisibility.js';

assert.equal(isTelegramSubscriptionVisibleInManagement({
    enabled: true,
    disabled_reason: null,
}), true, 'active subscriptions remain visible');

assert.equal(isTelegramSubscriptionVisibleInManagement({
    enabled: false,
    disabled_reason: '订阅已暂停：当前 Telegram 用户账号无法访问该频道/群',
}), true, 'automatically paused subscriptions remain visible for recovery reminders');

assert.equal(isTelegramSubscriptionVisibleInManagement({
    enabled: false,
    disabled_reason: '用户手动取消订阅',
}), false, 'user-cancelled subscriptions disappear from management views');

const botSource = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
const manageCalls = botSource.match(/listManageableTelegramSubscriptions\(/g) || [];
assert.ok(manageCalls.length >= 6, 'all subscription management/list refresh paths use the filtered view');

const jobsSource = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const unsubscribe = jobsSource.slice(
    jobsSource.indexOf('export async function unsubscribeTelegramChannel'),
    jobsSource.indexOf('async function pauseTelegramSubscriptionForError'),
);
assert.doesNotMatch(
    unsubscribe,
    /disabled_reason\s*=\s*COALESCE/,
    'explicit user cancellation must overwrite an earlier automatic-pause reason',
);
assert.match(unsubscribe, /disabled_reason\s*=\s*'用户手动取消订阅'/);

console.log('telegram subscription management hides user-cancelled entries ok');
