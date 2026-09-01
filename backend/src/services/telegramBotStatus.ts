export type TelegramBotState =
    | 'not_configured'
    | 'starting'
    | 'ready'
    | 'reconnecting'
    | 'auth_failed'
    | 'error'
    | 'stopped';

export interface TelegramBotStatus {
    status: TelegramBotState;
    configured: boolean;
    required: boolean;
    degraded: boolean;
    checkedAt: string;
    lastConnectedAt: string | null;
    lastRecoveredAt: string | null;
    lastError: string | null;
    action: string | null;
    reconnectCount: number;
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
    lastError: null,
    action: '配置 TELEGRAM_BOT_TOKEN、TELEGRAM_API_ID 和 TELEGRAM_API_HASH',
    reconnectCount: 0,
};

export function resetTelegramBotStatus(configured: boolean, checkedAt = new Date().toISOString()): void {
    current = {
        status: configured ? 'stopped' : 'not_configured',
        configured,
        required: requiredFromEnv(),
        degraded: false,
        checkedAt,
        lastConnectedAt: null,
        lastRecoveredAt: null,
        lastError: null,
        action: configured ? '启动 Telegram Bot' : '配置 TELEGRAM_BOT_TOKEN、TELEGRAM_API_ID 和 TELEGRAM_API_HASH',
        reconnectCount: 0,
    };
}

export function getTelegramBotStatus(): TelegramBotStatus {
    return { ...current, required: requiredFromEnv() };
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
        action: '等待 Telegram 连接建立',
    };
}

export function markTelegramBotReady(checkedAt = new Date().toISOString()): void {
    const recovered = current.status === 'reconnecting' || current.status === 'auth_failed' || current.status === 'error';
    current = {
        ...current,
        configured: true,
        required: requiredFromEnv(),
        status: 'ready',
        degraded: false,
        checkedAt,
        lastConnectedAt: checkedAt,
        lastRecoveredAt: recovered ? checkedAt : current.lastRecoveredAt,
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
    current = {
        ...current,
        configured: true,
        required: requiredFromEnv(),
        status,
        degraded: status !== 'stopped',
        checkedAt,
        lastError: message,
        action,
        reconnectCount: status === 'reconnecting' ? current.reconnectCount + 1 : current.reconnectCount,
    };
}

export function classifyTelegramBotStartupError(error: unknown): Extract<TelegramBotState, 'auth_failed' | 'error'> {
    const message = error instanceof Error ? error.message : String(error);
    return /token|auth|unauthorized|forbidden|401|403|access_token_(?:expired|invalid)/i.test(message) ? 'auth_failed' : 'error';
}

export function telegramBotBlocksReadiness(status: TelegramBotStatus, required = requiredFromEnv()): boolean {
    if (!required) return false;
    return status.status !== 'ready';
}
