import { query } from '../db/index.js';
import { DEFAULT_LOCALE, t, type TelegramLocale } from '../i18n/telegram.js';

export type TelegramSuccessNotificationMode = 'immediate' | 'digest' | 'off';
export interface TelegramNotificationPreferences {
    failureImmediate: boolean;
    successMode: TelegramSuccessNotificationMode;
    security: true;
    subscriptionDigest: boolean;
    timezone: string;
    quietStart: string | null;
    quietEnd: string | null;
}

export const DEFAULT_TELEGRAM_NOTIFICATION_PREFERENCES: TelegramNotificationPreferences = {
    failureImmediate: true,
    successMode: 'immediate',
    security: true,
    subscriptionDigest: true,
    timezone: 'UTC',
    quietStart: null,
    quietEnd: null,
};

function validTime(value: unknown): string | null {
    const text = typeof value === 'string' ? value.trim() : '';
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : null;
}

export function normalizeTelegramNotificationPreferences(
    input: Record<string, unknown>,
    locale: TelegramLocale = DEFAULT_LOCALE,
): TelegramNotificationPreferences {
    const successMode = ['immediate', 'digest', 'off'].includes(String(input.successMode))
        ? String(input.successMode) as TelegramSuccessNotificationMode
        : DEFAULT_TELEGRAM_NOTIFICATION_PREFERENCES.successMode;
    const timezone = typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); }
    catch { throw new Error(t(locale, 'notifications.invalidTimezone')); }
    return {
        failureImmediate: input.failureImmediate !== false,
        successMode,
        security: true,
        subscriptionDigest: input.subscriptionDigest !== false,
        timezone,
        quietStart: validTime(input.quietStart),
        quietEnd: validTime(input.quietEnd),
    };
}

export function isQuietHour(
    preferences: Pick<TelegramNotificationPreferences, 'timezone' | 'quietStart' | 'quietEnd'>,
    now = new Date(),
): boolean {
    if (!preferences.quietStart || !preferences.quietEnd || preferences.quietStart === preferences.quietEnd) return false;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: preferences.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
    const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
    const current = hour * 60 + minute;
    const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const start = toMinutes(preferences.quietStart);
    const end = toMinutes(preferences.quietEnd);
    return start < end ? current >= start && current < end : current >= start || current < end;
}

export function evaluateTelegramNotification(
    kind: 'security' | 'failure' | 'success' | 'subscription',
    preferences: TelegramNotificationPreferences,
    now = new Date(),
): { deliver: 'immediate' | 'digest' | 'skip'; reason: string } {
    if (kind === 'security') return { deliver: 'immediate', reason: 'security-bypass' };
    const quiet = isQuietHour(preferences, now);
    if (kind === 'failure') return preferences.failureImmediate && !quiet
        ? { deliver: 'immediate', reason: 'preference' }
        : { deliver: 'digest', reason: quiet ? 'quiet-hours' : 'preference' };
    if (kind === 'subscription') return preferences.subscriptionDigest || quiet
        ? { deliver: 'digest', reason: quiet ? 'quiet-hours' : 'preference' }
        : { deliver: 'immediate', reason: 'preference' };
    if (preferences.successMode === 'off') return { deliver: 'skip', reason: 'preference' };
    if (quiet || preferences.successMode === 'digest') return { deliver: 'digest', reason: quiet ? 'quiet-hours' : 'preference' };
    return { deliver: 'immediate', reason: 'preference' };
}

export async function getTelegramNotificationPreferences(userId: number, chatId: string, locale: TelegramLocale = DEFAULT_LOCALE): Promise<TelegramNotificationPreferences> {
    const result = await query('SELECT preferences FROM telegram_notification_preferences WHERE user_id = $1 AND chat_id = $2', [userId, chatId]);
    return normalizeTelegramNotificationPreferences(result.rows[0]?.preferences || {}, locale);
}

export async function setTelegramNotificationPreferences(userId: number, chatId: string, input: Record<string, unknown>, locale: TelegramLocale = DEFAULT_LOCALE): Promise<TelegramNotificationPreferences> {
    const preferences = normalizeTelegramNotificationPreferences(input, locale);
    await query(
        `INSERT INTO telegram_notification_preferences (user_id, chat_id, preferences)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (user_id, chat_id) DO UPDATE SET preferences = EXCLUDED.preferences, updated_at = NOW()`,
        [userId, chatId, JSON.stringify(preferences)],
    );
    return preferences;
}
