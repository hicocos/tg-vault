import { DEFAULT_LOCALE, formatDate, t, type TelegramLocale } from '../../i18n/telegram.js';

export interface SubscriptionPresentationRow {
    enabled: boolean;
    source: string;
    source_original?: string | null;
    title?: string | null;
    target_mode?: 'fixed' | string;
    target_account_name?: string | null;
    target_provider?: string | null;
    last_message_id?: number | null;
    folder_override?: string | null;
    last_scan_at?: string | Date | null;
    next_scan_at?: string | Date | null;
    last_result?: { status?: string; found?: number; failed?: number } | null;
    last_error?: string | null;
    disabled_reason?: string | null;
}

export function buildSubscriptionDisplayLines(row: SubscriptionPresentationRow, index: number, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const status = row.enabled ? '✅' : '⏸️';
    const source = row.source_original && row.source_original !== row.source
        ? `${row.source_original} → ${row.source}`
        : row.source;
    // Keep source metadata unchanged; only UI labels are localized.
    const target = row.target_mode === 'fixed'
        ? `${row.target_account_name || row.target_provider || t(locale, 'commands.targetDefault')}`
        : t(locale, 'bot.subscription.followSystemDefault');
    const resultStatus: Record<string, string> = {
        success: t(locale, 'common.success'), completed: t(locale, 'bot.subscription.result.completed'), failed: t(locale, 'common.failed'), partial: t(locale, 'bot.subscription.result.partial'), running: t(locale, 'bot.subscription.result.running'), paused: t(locale, 'bot.subscription.result.paused'),
    };
    return [
        `${index + 1}. ${status} ${row.title || row.source_original || row.source}`,
        t(locale, 'bot.subscription.source', { source }),
        t(locale, 'bot.subscription.position', { messageId: row.last_message_id || 0 }),
        row.folder_override ? t(locale, 'bot.subscription.folder', { folder: row.folder_override }) : t(locale, 'bot.subscription.defaultFolder'),
        t(locale, 'bot.subscription.target', { target }),
        row.last_scan_at ? t(locale, 'bot.subscription.lastScan', { time: formatDate(row.last_scan_at, locale) }) : t(locale, 'bot.subscription.notScanned'),
        row.next_scan_at ? t(locale, 'bot.subscription.nextScan', { time: formatDate(row.next_scan_at, locale) }) : null,
        row.last_result ? t(locale, 'bot.subscription.lastResult', { status: resultStatus[row.last_result.status || ''] || t(locale, 'bot.subscription.result.recorded'), found: row.last_result.found !== undefined ? row.last_result.found : 0, failed: row.last_result.failed || 0 }) : null,
        row.last_error ? t(locale, 'bot.subscription.error', { error: row.last_error }) : null,
        !row.enabled && row.disabled_reason ? t(locale, 'bot.subscription.disabledReason', { reason: row.disabled_reason }) : null,
    ].filter(Boolean).join('\n');
}

export function buildSubscriptionManagePanel(rows: SubscriptionPresentationRow[], page: { page: number; totalPages: number; startIndex: number; visibleRows: SubscriptionPresentationRow[] }, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return [
        t(locale, 'bot.subscription.panelTitle'),
        ...(page.totalPages > 1 ? [t(locale, 'bot.subscription.page', { page: page.page + 1, totalPages: page.totalPages, count: rows.length })] : []),
        '',
        page.visibleRows.length > 0
            ? page.visibleRows.map((row, index) => buildSubscriptionDisplayLines(row, page.startIndex + index, locale)).join('\n\n')
            : t(locale, 'bot.subscription.empty'),
        '',
        t(locale, 'bot.subscription.manageHint'),
    ].join('\n');
}
