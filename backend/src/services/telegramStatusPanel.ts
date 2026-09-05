import { DEFAULT_LOCALE, formatBytes, formatDate, type TelegramLocale, t } from '../i18n/telegram.js';

export interface TelegramStatusPanelInput {
    requestId: string;
    bot: { status: string; degraded?: boolean; reconnectCount?: number; lastError?: string | null; action?: string | null };
    userClient: { status: string; username?: string | null; action?: string | null; lastError?: string | null };
    target: { provider: string; accountName: string; probeStatus?: string | null; cooldownUntil?: string | null; probeError?: string | null };
    disk: { freeBytes: number; totalBytes: number };
    queue: { active: number; pending: number; failed: number; paused: boolean };
    subscriptions: { enabled: number; lastScanAt?: string | null; lastError?: string | null };
    reconciliation: { pending: number; operatorRequired: number };
}

export function sanitizeTelegramStatusText(value: unknown, locale: TelegramLocale = DEFAULT_LOCALE): string {
    if (!value) return t(locale, 'status.none');
    const text = String(value);
    if (/(?:^|\s)(?:\/[^\s]+|[A-Za-z]:\\[^\s]+)/.test(text)
        || /(?:bearer|token|secret|password|api[_-]?key|access[_-]?key|refresh[_-]?token)[=: ]/i.test(text)
        || /AKIA[0-9A-Z-]+/i.test(text)) return t(locale, 'status.redacted');
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function percent(used: number, total: number): number {
    return total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;
}

function formatStatusDate(value: string, locale: TelegramLocale): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? sanitizeTelegramStatusText(value, locale) : formatDate(parsed, locale);
}

const STATUS_KEYS: Record<string, string> = {
    ready: 'status.state.healthy', running: 'status.state.running', connected: 'status.state.connected', disabled: 'status.state.disabled', expired: 'status.state.expired',
    failed: 'status.state.failed', error: 'status.state.failed', unknown: 'status.state.unknown', available: 'status.state.healthy', healthy: 'status.state.healthy', cooldown: 'status.state.cooldown',
};

function statusLabel(value: string | null | undefined, locale: TelegramLocale): string {
    const key = STATUS_KEYS[String(value || 'unknown').toLowerCase()];
    return key ? t(locale, key) : sanitizeTelegramStatusText(value || t(locale, 'status.state.unknown'), locale);
}

export function buildTelegramStatusPanel(input: TelegramStatusPanelInput, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const used = Math.max(0, input.disk.totalBytes - input.disk.freeBytes);
    const clean = (value: unknown) => sanitizeTelegramStatusText(value, locale);
    return [
        t(locale, 'status.title'),
        t(locale, 'status.requestId', { requestId: clean(input.requestId) }),
        '',
        t(locale, 'status.bot', { status: statusLabel(input.bot.status, locale), degraded: input.bot.degraded ? t(locale, 'status.degraded') : '', reconnectCount: input.bot.reconnectCount || 0 }),
        t(locale, 'status.userClient', { status: statusLabel(input.userClient.status, locale), username: input.userClient.username ? ` · @${clean(input.userClient.username)}` : '' }),
        input.userClient.action ? t(locale, 'status.accountRecovery', { action: clean(input.userClient.action) }) : null,
        '',
        t(locale, 'status.storage', { provider: input.target.provider, accountName: clean(input.target.accountName) }),
        t(locale, 'status.probe', { status: statusLabel(input.target.probeStatus, locale) }),
        input.target.cooldownUntil ? t(locale, 'status.recoveryTime', { time: formatStatusDate(input.target.cooldownUntil, locale) }) : null,
        input.target.probeError ? t(locale, 'status.storageError', { error: clean(input.target.probeError) }) : null,
        '',
        t(locale, 'status.disk', { free: formatBytes(input.disk.freeBytes, locale), total: formatBytes(input.disk.totalBytes, locale), usedPercent: percent(used, input.disk.totalBytes) }),
        t(locale, 'status.queue', { active: input.queue.active, pending: input.queue.pending, failed: input.queue.failed, paused: input.queue.paused ? t(locale, 'status.queuePaused') : '' }),
        t(locale, 'status.subscriptions', { enabled: input.subscriptions.enabled, lastScan: input.subscriptions.lastScanAt ? formatStatusDate(input.subscriptions.lastScanAt, locale) : t(locale, 'status.none') }),
        input.subscriptions.lastError ? t(locale, 'status.subscriptionError', { error: clean(input.subscriptions.lastError) }) : null,
        t(locale, 'status.reconciliation', { pending: input.reconciliation.pending, operatorRequired: input.reconciliation.operatorRequired }),
        '',
        input.bot.action ? t(locale, 'status.advice', { action: clean(input.bot.action) }) : t(locale, 'status.defaultAdvice'),
    ].filter(Boolean).join('\n');
}
