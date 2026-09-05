import type {
    TelegramNotificationPreferences,
    TelegramSuccessNotificationMode,
} from './telegramNotificationPreferences.js';
import { DEFAULT_LOCALE, t, type TelegramLocale } from '../i18n/telegram.js';

export interface NotificationSettingsButton {
    text: string;
    data: string;
}

const modeLabelKeys: Record<TelegramSuccessNotificationMode, string> = {
    immediate: 'notifications.modeImmediate',
    digest: 'notifications.modeDigestCombined',
    off: 'notifications.modeOff',
};

function selected(active: boolean, label: string): string {
    return `${active ? '✅' : '▫️'} ${label}`;
}

export function buildNotificationSettingsButtonRows(
    preferences: TelegramNotificationPreferences,
    locale: TelegramLocale = DEFAULT_LOCALE,
): NotificationSettingsButton[][] {
    const quietEnabled = Boolean(preferences.quietStart && preferences.quietEnd);
    return [
        [
            { text: selected(preferences.successMode === 'immediate', t(locale, 'notifications.successImmediate')), data: 'nt_success_immediate' },
            { text: selected(preferences.successMode === 'digest', t(locale, 'notifications.successDigest')), data: 'nt_success_digest' },
            { text: selected(preferences.successMode === 'off', t(locale, 'notifications.successOff')), data: 'nt_success_off' },
        ],
        [
            { text: selected(preferences.failureImmediate, t(locale, 'notifications.failureImmediate')), data: 'nt_failure_immediate' },
            { text: selected(!preferences.failureImmediate, t(locale, 'notifications.failureDigest')), data: 'nt_failure_digest' },
        ],
        [
            { text: selected(!preferences.subscriptionDigest, t(locale, 'notifications.subscriptionImmediate')), data: 'nt_subscription_immediate' },
            { text: selected(preferences.subscriptionDigest, t(locale, 'notifications.subscriptionDigest')), data: 'nt_subscription_digest' },
        ],
        [
            { text: selected(quietEnabled && preferences.quietStart === '22:00' && preferences.quietEnd === '07:00', t(locale, 'notifications.quietPreset')), data: 'nt_quiet_22_07' },
            { text: selected(!quietEnabled, t(locale, 'notifications.quietOff')), data: 'nt_quiet_off' },
        ],
        [
            { text: selected(preferences.timezone === 'Asia/Shanghai', t(locale, 'notifications.timezoneShanghai')), data: 'nt_timezone_asia_shanghai' },
            { text: selected(preferences.timezone === 'UTC', t(locale, 'notifications.timezoneUtc')), data: 'nt_timezone_utc' },
        ],
    ];
}

export function buildNotificationSettingsText(preferences: TelegramNotificationPreferences, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const quiet = preferences.quietStart && preferences.quietEnd
        ? `${preferences.quietStart}–${preferences.quietEnd}`
        : t(locale, 'notifications.quietDisabled');
    return [
        t(locale, 'notifications.title'),
        '',
        t(locale, 'notifications.settingsModes', {
            failure: t(locale, preferences.failureImmediate ? 'notifications.modeImmediate' : 'notifications.modeDigest'),
            success: t(locale, modeLabelKeys[preferences.successMode]),
        }),
        t(locale, 'notifications.settingsSchedule', {
            subscription: t(locale, preferences.subscriptionDigest ? 'notifications.modeDigest' : 'notifications.modeImmediate'),
            quiet,
        }),
        t(locale, 'notifications.settingsTimezone', { timezone: preferences.timezone }),
        t(locale, 'notifications.securityAlways'),
        '',
        t(locale, 'notifications.clickToChange'),
    ].join('\n');
}

export function updateNotificationPreference(
    current: TelegramNotificationPreferences,
    args: string[],
    locale: TelegramLocale = DEFAULT_LOCALE,
): Record<string, unknown> {
    const [rawKey = '', rawValue = ''] = args;
    const key = rawKey.toLowerCase();
    const value = rawValue.trim();
    const update: Record<string, unknown> = { ...current };

    if (key === 'timezone') {
        if (!value) throw new Error(t(locale, 'notifications.error.timezoneRequired'));
        update.timezone = value;
    } else if (key === 'quiet') {
        if (['off', 'none', 'disable'].includes(value.toLowerCase())) {
            update.quietStart = null;
            update.quietEnd = null;
            return update;
        }
        const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/);
        if (!match) throw new Error(t(locale, 'notifications.error.quietFormat'));
        update.quietStart = `${match[1]}:${match[2]}`;
        update.quietEnd = `${match[3]}:${match[4]}`;
    } else if (key === 'success') {
        if (!['immediate', 'digest', 'off'].includes(value)) {
            throw new Error(t(locale, 'notifications.error.successMode'));
        }
        update.successMode = value;
    } else if (key === 'failure') {
        if (!['immediate', 'digest'].includes(value)) {
            throw new Error(t(locale, 'notifications.error.deliveryMode'));
        }
        update.failureImmediate = value === 'immediate';
    } else if (key === 'subscription') {
        if (!['immediate', 'digest'].includes(value)) {
            throw new Error(t(locale, 'notifications.error.deliveryMode'));
        }
        update.subscriptionDigest = value === 'digest';
    } else {
        throw new Error(t(locale, 'notifications.error.unknownSetting'));
    }
    return update;
}

export function notificationCallbackArgs(data: string): string[] | null {
    const fixed: Record<string, string[]> = {
        nt_failure_immediate: ['failure', 'immediate'],
        nt_failure_digest: ['failure', 'digest'],
        nt_subscription_immediate: ['subscription', 'immediate'],
        nt_subscription_digest: ['subscription', 'digest'],
        nt_quiet_22_07: ['quiet', '22:00-07:00'],
        nt_quiet_off: ['quiet', 'off'],
        nt_timezone_asia_shanghai: ['timezone', 'Asia/Shanghai'],
        nt_timezone_utc: ['timezone', 'UTC'],
    };
    if (fixed[data]) return fixed[data];
    const success = data.match(/^nt_success_(immediate|digest|off)$/);
    return success ? ['success', success[1]] : null;
}
