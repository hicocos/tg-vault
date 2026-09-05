import { query } from '../db/index.js';
import { DEFAULT_LOCALE, resolveLocale, type TelegramLocale } from '../i18n/telegram.js';

type RunQuery = typeof query;

export async function getTelegramUserLocale(userId: number, runQuery: RunQuery = query): Promise<TelegramLocale | null> {
    const result = await runQuery('SELECT locale FROM telegram_user_locales WHERE user_id = $1', [userId]);
    return result.rows[0]?.locale ? resolveLocale(String(result.rows[0].locale)) : null;
}

export async function setTelegramUserLocale(userId: number, locale: TelegramLocale | string, runQuery: RunQuery = query): Promise<TelegramLocale> {
    const resolved = resolveLocale(locale);
    await runQuery(
        `INSERT INTO telegram_user_locales (user_id, locale, explicit)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id) DO UPDATE SET locale = EXCLUDED.locale, explicit = TRUE, updated_at = NOW()`,
        [userId, resolved],
    );
    return resolved;
}

export async function getTelegramUserLocaleOrDefault(userId: number, runQuery: RunQuery = query): Promise<TelegramLocale> {
    return (await getTelegramUserLocale(userId, runQuery)) || DEFAULT_LOCALE;
}

/** Insert legacy users explicitly as Chinese without changing any authentication state. */
export async function backfillExistingTelegramUserLocales(runQuery: RunQuery = query): Promise<void> {
    await runQuery(
        `INSERT INTO telegram_user_locales (user_id, locale, explicit)
         SELECT user_id, 'zh-CN', TRUE FROM telegram_auth
         ON CONFLICT (user_id) DO NOTHING`,
    );
}
