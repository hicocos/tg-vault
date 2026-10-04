export type TelegramBotState =
    | 'not_configured'
    | 'starting'
    | 'ready'
    | 'reconnecting'
    | 'auth_failed'
    | 'error'
    | 'stopped';

export interface TelegramBotRuntime {
    connected: boolean;
    busy: boolean;
    cleanupBlocked: boolean;
    attempt: number;
    nextRetryAt: string | null;
    retryAllowedAt: string | null;
}
let runtimeProbe: (() => TelegramBotRuntime) | null = null;
export function setTelegramBotRuntimeProbe(probe: () => TelegramBotRuntime): void { runtimeProbe = probe; }

export type TelegramBotActionCode = 'BOT_REVIEW_REQUIRED' | 'BOT_CHECK_CREDENTIALS' | 'BOT_RETRY_NETWORK' | 'BOT_WAIT_CONNECTION';
const reviewAction = 'Bot cleanup requires operator review; retry is blocked and user clients are unchanged';
let recoveryPending = false;

export interface TelegramBotStatus {
    status: TelegramBotState;
    configured: boolean;
    required: boolean;
    degraded: boolean;
    checkedAt: string;
    lastConnectedAt: string | null;
    lastRecoveredAt: string | null;
    lastFailureAt: string | null;
    startupError: string | null;
    cleanupError: string | null;
    actionCode: TelegramBotActionCode | null;
    lastError: string | null;
    action: string | null;
    reconnectCount: number;
    connected?: boolean;
    busy?: boolean;
    cleanupBlocked?: boolean;
    attempt?: number;
    nextRetryAt?: string | null;
    retryAllowedAt?: string | null;
}

let requiredOverride: boolean | null = null;

function requiredFromEnv(): boolean {
    if (requiredOverride !== null) return requiredOverride;
    return /^(1|true|yes|on)$/i.test(process.env.TELEGRAM_REQUIRED || 'false');
}

export function setTelegramBotRequired(required: boolean): void {
    requiredOverride = required;
    current = { ...current, required };
}

let current: TelegramBotStatus = {
    status: 'not_configured',
    configured: false,
    required: requiredFromEnv(),
    degraded: false,
    checkedAt: new Date().toISOString(),
    lastConnectedAt: null,
    lastRecoveredAt: null,
    lastFailureAt: null,
    startupError: null,
    cleanupError: null,
    actionCode: 'BOT_CHECK_CREDENTIALS',
    lastError: null,
    action: '配置 TELEGRAM_BOT_TOKEN、TELEGRAM_API_ID 和 TELEGRAM_API_HASH',
    reconnectCount: 0,
};

export function resetTelegramBotStatus(configured: boolean, checkedAt = new Date().toISOString()): void {
    recoveryPending = false;
    current = {
        status: configured ? 'stopped' : 'not_configured',
        configured,
        required: requiredFromEnv(),
        degraded: false,
        checkedAt,
        lastConnectedAt: null,
        lastRecoveredAt: null,
        lastFailureAt: null,
        startupError: null,
        cleanupError: null,
        actionCode: configured ? 'BOT_WAIT_CONNECTION' : 'BOT_CHECK_CREDENTIALS',
        lastError: null,
        action: configured ? '启动 Telegram Bot' : '配置 TELEGRAM_BOT_TOKEN、TELEGRAM_API_ID 和 TELEGRAM_API_HASH',
        reconnectCount: 0,
    };
}

export function getTelegramBotStatus(): TelegramBotStatus {
    const runtime = runtimeProbe?.();
    const status = runtime && ((current.status === 'ready' && !runtime.connected) || runtime.nextRetryAt)
        ? 'reconnecting' : current.status;
    const actionCode = runtime?.cleanupBlocked ? 'BOT_REVIEW_REQUIRED'
        : runtime?.busy || runtime?.nextRetryAt || status === 'reconnecting' ? 'BOT_WAIT_CONNECTION' : current.actionCode;
    return { ...current, ...runtime, actionCode, action: runtime?.cleanupBlocked ? reviewAction : current.action, status, degraded: current.degraded || status === 'reconnecting', checkedAt: new Date().toISOString(), required: requiredFromEnv() };
}

export function markTelegramBotStarting(checkedAt = new Date().toISOString()): void {
    current = {
        ...current,
        configured: true,
        required: requiredFromEnv(),
        status: 'starting',
        degraded: false,
        checkedAt,
        lastError: null,
        actionCode: 'BOT_WAIT_CONNECTION',
        action: '等待 Telegram 连接建立',
    };
}

export function markTelegramBotReady(checkedAt = new Date().toISOString()): void {
    const recovered = recoveryPending;
    recoveryPending = false;
    current = {
        ...current,
        configured: true,
        required: requiredFromEnv(),
        status: 'ready',
        degraded: false,
        checkedAt,
        lastConnectedAt: checkedAt,
        lastRecoveredAt: recovered ? checkedAt : current.lastRecoveredAt,
        actionCode: null,
        lastError: null,
        action: null,
    };
}

export function markTelegramBotError(
    status: Extract<TelegramBotState, 'reconnecting' | 'auth_failed' | 'error' | 'stopped'>,
    message: string,
    action: string,
    checkedAt = new Date().toISOString(),
): void {
    recoveryPending = status !== 'stopped';
    current = {
        ...current,
        configured: true,
        required: requiredFromEnv(),
        status,
        degraded: status !== 'stopped',
        checkedAt,
        lastFailureAt: checkedAt,
        startupError: message,
        cleanupError: null,
        actionCode: status === 'auth_failed' ? 'BOT_CHECK_CREDENTIALS' : 'BOT_RETRY_NETWORK',
        lastError: message,
        action,
        reconnectCount: status === 'reconnecting' ? current.reconnectCount + 1 : current.reconnectCount,
    };
}

/** Stop is a lifecycle transition, not a new process/history reset. */
export function markTelegramBotStopped(): void {
    current = { ...current, status: current.configured ? 'stopped' : 'not_configured',
        degraded: false, checkedAt: new Date().toISOString(), actionCode: null, action: null };
}

export function markTelegramBotCleanupError(error: unknown, checkedAt = new Date().toISOString()): void {
    recoveryPending = true;
    current = { ...current, status: 'error', degraded: true, checkedAt,
        lastFailureAt: current.lastFailureAt || checkedAt,
        cleanupError: error instanceof Error ? error.message : String(error),
        lastError: 'BOT_CLEANUP_UNCONFIRMED', actionCode: 'BOT_REVIEW_REQUIRED', action: reviewAction };
}

export function classifyTelegramBotStartupError(error: unknown): Extract<TelegramBotState, 'auth_failed' | 'error'> {
    const message = error instanceof Error ? error.message : String(error);
    return /token|auth|unauthorized|forbidden|401|403|access_token_(?:expired|invalid)/i.test(message) ? 'auth_failed' : 'error';
}

export function telegramBotBlocksReadiness(status: TelegramBotStatus, required = requiredFromEnv()): boolean {
    if (!required) return false;
    return status.status !== 'ready';
}
