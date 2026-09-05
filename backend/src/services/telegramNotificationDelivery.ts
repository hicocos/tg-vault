import type { QueryResult } from 'pg';
import { query } from '../db/index.js';
import {
    evaluateTelegramNotification,
    getTelegramNotificationPreferences,
    type TelegramNotificationPreferences,
} from './telegramNotificationPreferences.js';
import { getTelegramUserLocaleOrDefault } from './telegramLocalePreferences.js';
import { t, type TelegramLocale } from '../i18n/telegram.js';

export type TelegramNotificationKind = 'security' | 'failure' | 'success' | 'subscription';

export function resolveNotificationOwnerUserId(ownerUserId: number | null | undefined, chatId: string): number {
    if (Number.isSafeInteger(ownerUserId) && Number(ownerUserId) > 0) return Number(ownerUserId);
    const parsed = Number(chatId);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    throw new Error('notification owner user id is required for group/channel delivery');
}
export interface TelegramNotificationEvent {
    userId: number;
    chatId: string;
    kind: TelegramNotificationKind;
    message: string;
    payload?: Record<string, unknown>;
    messageKey?: string;
    messageParams?: Record<string, string | number>;
}
type RunQuery = (sql: string, params?: unknown[]) => Promise<QueryResult<any>>;
export interface TelegramNotificationDeliveryDeps {
    getPreferences?: (userId: number, chatId: string) => Promise<TelegramNotificationPreferences>;
    runQuery?: RunQuery;
    send: (chatId: string, text: string) => Promise<void>;
    now?: () => Date;
    getLocale?: (userId: number) => Promise<TelegramLocale>;
}

async function localizeEvent(event: TelegramNotificationEvent, deps: TelegramNotificationDeliveryDeps): Promise<{ locale: TelegramLocale; message: string }> {
    const locale = deps.getLocale
        ? await deps.getLocale(event.userId)
        : event.messageKey
            ? await getTelegramUserLocaleOrDefault(event.userId)
            : 'zh-CN';
    return { locale, message: event.messageKey ? t(locale, event.messageKey, event.messageParams || {}, { strict: false }) : event.message };
}

export async function enqueueTelegramNotification(event: TelegramNotificationEvent, deps: TelegramNotificationDeliveryDeps): Promise<'immediate' | 'digest' | 'skip'> {
    const localized = await localizeEvent(event, deps);
    const preferences = await (deps.getPreferences || getTelegramNotificationPreferences)(event.userId, event.chatId);
    const decision = evaluateTelegramNotification(event.kind, preferences, (deps.now || (() => new Date()))());
    if (decision.deliver === 'immediate') {
        await deps.send(event.chatId, localized.message);
        return 'immediate';
    }
    if (decision.deliver === 'skip') return 'skip';
    await (deps.runQuery || query)(
        `INSERT INTO telegram_notification_digest (user_id, chat_id, kind, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [event.userId, event.chatId, event.kind, JSON.stringify({ message: localized.message, locale: localized.locale, messageKey: event.messageKey, messageParams: event.messageParams, ...(event.payload || {}) })],
    );
    return 'digest';
}

const digestFlushInProgress = new Set<string>();

export async function listTelegramNotificationDigestScopes(runQuery: RunQuery = query): Promise<Array<{ userId: number; chatId: string }>> {
    const result = await runQuery(
        `SELECT user_id, chat_id FROM telegram_notification_digest
         WHERE delivered_at IS NULL
         GROUP BY user_id, chat_id
         ORDER BY MIN(created_at) ASC`,
    );
    return result.rows.map(row => ({ userId: Number(row.user_id), chatId: String(row.chat_id) }));
}

export async function claimTelegramNotificationDigest(userId: number, chatId: string, runQuery: RunQuery): Promise<any[]> {
    const claimed = await runQuery(
        `WITH candidates AS (
             SELECT id FROM telegram_notification_digest
             WHERE user_id = $1 AND chat_id = $2 AND delivered_at IS NULL
               AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '10 minutes')
             ORDER BY created_at ASC LIMIT 100
             FOR UPDATE SKIP LOCKED
         )
         UPDATE telegram_notification_digest d SET claimed_at = NOW()
         FROM candidates c WHERE d.id = c.id
         RETURNING d.id, d.kind, d.payload`,
        [userId, chatId],
    );
    return claimed.rows;
}

export async function flushTelegramNotificationDigest(
    userId: number,
    chatId: string,
    deps: Pick<TelegramNotificationDeliveryDeps, 'runQuery' | 'send' | 'getLocale'>,
): Promise<number> {
    const scope = `${userId}:${chatId}`;
    if (digestFlushInProgress.has(scope)) return 0;
    digestFlushInProgress.add(scope);
    try {
        const runQuery = deps.runQuery || query;
        const selected = { rows: await claimTelegramNotificationDigest(userId, chatId, runQuery) } as QueryResult<any>;
    if (selected.rows.length === 0) return 0;
    const ids = selected.rows.map(row => row.id);
    const locale = await (deps.getLocale || getTelegramUserLocaleOrDefault)(userId);
    const lines = selected.rows.map(row => {
        const key = row.payload?.messageKey;
        return `• ${key ? t(locale, key, row.payload?.messageParams || {}, { strict: false }) : String(row.payload?.message || row.kind)}`;
    });
    try {
        await deps.send(chatId, [t(locale, 'notifications.digestTitle'), '', ...lines].join('\n'));
    } catch (error) {
        await runQuery(
            `UPDATE telegram_notification_digest SET claimed_at = NULL
             WHERE id = ANY($1::uuid[]) AND delivered_at IS NULL`,
            [ids],
        ).catch(() => undefined);
        throw error;
    }
    await runQuery(
        `UPDATE telegram_notification_digest SET delivered_at = NOW(), claimed_at = NULL
         WHERE id = ANY($1::uuid[]) AND delivered_at IS NULL`,
        [ids],
    );
    return selected.rows.length;
    } finally {
        digestFlushInProgress.delete(scope);
    }
}
