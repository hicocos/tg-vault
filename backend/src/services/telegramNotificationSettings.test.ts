import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TELEGRAM_NOTIFICATION_PREFERENCES } from './telegramNotificationPreferences.js';
import {
    buildNotificationSettingsButtonRows,
    buildNotificationSettingsText,
    updateNotificationPreference,
} from './telegramNotificationSettings.js';

const preferences = {
    ...DEFAULT_TELEGRAM_NOTIFICATION_PREFERENCES,
    timezone: 'Asia/Shanghai',
    quietStart: '22:00',
    quietEnd: '07:00',
    successMode: 'digest' as const,
};

test('notification settings panel is compact and delegates all changes to buttons', () => {
    const text = buildNotificationSettingsText(preferences);

    assert.match(text, /失败：立即 ｜ 成功：合并摘要/);
    assert.match(text, /订阅：摘要 ｜ 安静：22:00–07:00/);
    assert.match(text, /时区：Asia\/Shanghai/);
    assert.match(text, /安全告警始终立即通知/);
    assert.match(text, /点击按钮修改/);
    assert.doesNotMatch(text, /\/notifications/);
    assert.ok(text.length < 150);
});

test('notification settings expose direct action buttons with selected state', () => {
    const rows = buildNotificationSettingsButtonRows(preferences);
    assert.deepEqual(rows[0].map(button => button.data), [
        'nt_success_immediate',
        'nt_success_digest',
        'nt_success_off',
    ]);
    assert.match(rows[0][1].text, /^✅/);
    assert.match(rows[1][0].text, /^✅/);
    assert.match(rows[2][1].text, /^✅/);
    assert.equal(rows[3][0].data, 'nt_quiet_22_07');
    assert.equal(rows[4][0].data, 'nt_timezone_asia_shanghai');
});

test('notification settings localize presentation without changing callback ids', () => {
    const rows = buildNotificationSettingsButtonRows(preferences, 'en');
    assert.match(buildNotificationSettingsText(preferences, 'en'), /Failure: immediate \| Success: digest/);
    assert.match(rows[1][0].text, /Failure · immediate/);
    assert.deepEqual(rows.flat().map(button => button.data), buildNotificationSettingsButtonRows(preferences).flat().map(button => button.data));
    assert.throws(() => updateNotificationPreference(preferences, ['success', 'sometimes'], 'en'), /must be immediate, digest, or off/);
});

test('notification preference updates validate values and support disabling quiet hours', () => {
    assert.deepEqual(updateNotificationPreference(preferences, ['quiet', 'off']), {
        ...preferences,
        quietStart: null,
        quietEnd: null,
    });
    assert.equal(updateNotificationPreference(preferences, ['failure', 'digest']).failureImmediate, false);
    assert.throws(() => updateNotificationPreference(preferences, ['success', 'sometimes']), /成功通知可选值/);
    assert.throws(() => updateNotificationPreference(preferences, ['quiet', '29:00-07:00']), /安静时段格式/);
});
