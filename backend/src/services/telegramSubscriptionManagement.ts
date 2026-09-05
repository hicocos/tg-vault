import type { StorageTargetSnapshot } from './storage.js';
import { DEFAULT_LOCALE, t, type TelegramLocale } from '../i18n/telegram.js';

export const TELEGRAM_SUBSCRIPTION_PAGE_SIZE = 5;

export type TelegramSubscriptionRow = {
    id: string;
    title?: string | null;
    source?: string | null;
};

export type TelegramSubscriptionPage<T extends TelegramSubscriptionRow> = {
    page: number;
    totalPages: number;
    startIndex: number;
    visibleRows: T[];
};

export function buildTelegramSubscriptionPage<T extends TelegramSubscriptionRow>(
    rows: T[],
    requestedPage = 0,
): TelegramSubscriptionPage<T> {
    const totalPages = Math.max(1, Math.ceil(rows.length / TELEGRAM_SUBSCRIPTION_PAGE_SIZE));
    const page = Math.min(Math.max(0, Math.floor(requestedPage || 0)), totalPages - 1);
    const startIndex = page * TELEGRAM_SUBSCRIPTION_PAGE_SIZE;
    return {
        page,
        totalPages,
        startIndex,
        visibleRows: rows.slice(startIndex, startIndex + TELEGRAM_SUBSCRIPTION_PAGE_SIZE),
    };
}

export type TelegramSubscriptionCallback =
    | { kind: 'page'; page: number }
    | { kind: 'action'; action: 'view' | 'folder' | 'clear' | 'cancel' | 'sync' | 'pause' | 'resume' | 'target' | 'from_now' | 'backfill' | 'result' | 'retry'; id: string; page: number }
    | { kind: 'confirm' | 'back'; token: string };

export type TelegramSubscriptionAction = Extract<TelegramSubscriptionCallback, { kind: 'action' }>['action'];

export function buildSubscriptionOperations(row: TelegramSubscriptionRow & { enabled?: boolean }, locale: TelegramLocale = DEFAULT_LOCALE): Array<{ action: TelegramSubscriptionAction; label: string }> {
    const operations: Array<{ action: TelegramSubscriptionAction; label: string }> = [
        { action: 'sync', label: t(locale, 'bot.subscription.action.sync') },
        { action: row.enabled ? 'pause' : 'resume', label: row.enabled ? t(locale, 'bot.subscription.action.pause') : t(locale, 'bot.subscription.action.resume') },
        { action: 'target', label: t(locale, 'bot.subscription.action.target') },
        { action: 'from_now', label: t(locale, 'bot.subscription.action.fromNow') },
        { action: 'backfill', label: t(locale, 'bot.subscription.action.backfill') },
        { action: 'result', label: t(locale, 'bot.subscription.action.result') },
        { action: 'retry', label: t(locale, 'bot.subscription.action.retry') },
    ];
    return operations;
}

export function resolveSubscriptionTarget(
    row: { target_mode?: string | null; target_provider?: string | null; target_account_id?: string | null },
    getActiveTarget: () => StorageTargetSnapshot,
    getTarget: (provider: string, accountId: string | null) => StorageTargetSnapshot,
): StorageTargetSnapshot {
    if (row.target_mode !== 'fixed') return getActiveTarget();
    if (!row.target_provider) throw new Error('固定订阅目标缺少 provider');
    return getTarget(row.target_provider, row.target_account_id || null);
}

export function parseTelegramSubscriptionCallback(data: string): TelegramSubscriptionCallback | null {
    let match = data.match(/^tsub_page_(\d{1,6})$/);
    if (match) return { kind: 'page', page: Number(match[1]) };

    match = data.match(/^tsub_(view|folder|clear|cancel|sync|pause|resume|target|from_now|backfill|result|retry)_([0-9a-f-]{36})(?:_(\d{1,6}))?$/i);
    if (match) {
        return {
            kind: 'action',
            action: match[1] as TelegramSubscriptionAction,
            id: match[2],
            page: Number(match[3] || 0),
        };
    }

    match = data.match(/^tsub_(confirm|back)_([A-Za-z0-9_-]{1,64})$/);
    if (match) return { kind: match[1] as 'confirm' | 'back', token: match[2] };
    return null;
}
