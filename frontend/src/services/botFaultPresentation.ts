import type { TelegramBotPublicConfig } from './apiTypes';

const errorKeys: Record<string, string> = {
    BOT_CLEANUP_UNCONFIRMED: 'cleanupUnconfirmed',
    BOT_STARTUP_TIMEOUT: 'startupTimeout',
    BOT_CONNECTION_LOST: 'connectionLost',
    CONNECTION_LOST: 'connectionLost',
    'Telegram Bot connection lost': 'connectionLost',
    BOT_CONNECTION_FAILED: 'connectionFailed',
    BOT_SDK_OWNERSHIP_UNSUPPORTED: 'sdkUnsupported',
    BOT_CANCELLED: 'cancelled',
    BOT_WORKER_STOP_TIMEOUT: 'workerStopTimeout',
    AUTH_KEY_UNREGISTERED: 'authFailed',
    AUTH_KEY_INVALID: 'authFailed',
    ACCESS_TOKEN_EXPIRED: 'authFailed',
    ACCESS_TOKEN_INVALID: 'authFailed',
    API_ID_INVALID: 'authFailed',
};

// Translate exact known diagnostics only; arbitrary operator diagnostics stay intact.
export function botErrorKey(error: string): string | undefined {
    return errorKeys[error];
}
export function isBotQuarantined(config: TelegramBotPublicConfig): boolean {
    return Boolean(config.cleanupBlocked || config.lastError === 'BOT_CLEANUP_UNCONFIRMED'
        || config.cleanupError === 'BOT_CLEANUP_UNCONFIRMED'
        || config.actionCode === 'BOT_CLEANUP_UNCONFIRMED'
        || config.actionCode === 'operator_review_required' || config.actionCode === 'BOT_REVIEW_REQUIRED');
}
export function botFaultPresentation(config: TelegramBotPublicConfig) {
    const quarantined = isBotQuarantined(config);
    const offline = quarantined || (config.configured && config.enabled
        && (config.status !== 'ready' || !config.runtimeReady || config.connected === false));
    const codedAction: Record<string, string> = { BOT_CHECK_CREDENTIALS: 'authAction', BOT_RETRY_NETWORK: 'retryAction', BOT_WAIT_CONNECTION: 'waitAction' };
    const action = quarantined ? 'cleanupBlocked'
        : !config.configured ? 'configureAction'
        : !config.enabled ? 'disabledAction'
        : config.actionCode && codedAction[config.actionCode] ? codedAction[config.actionCode]
        : config.status === 'auth_failed' ? 'authAction'
        : config.busy || config.nextRetryAt || config.status === 'starting' || config.status === 'reconnecting' ? 'waitAction'
        : offline ? 'retryAction' : null;
    return { quarantined, offline, action,
        startupError: config.startupError || (!quarantined ? config.lastError : null),
        cleanupError: config.cleanupError || (quarantined ? config.lastError : null),
    };
}

// Settings owns the fast polling lane; the shell consumes its results without another GET.
export const BOT_STATUS_EVENT = 'tgvault:bot-status';
export function publishBotStatus(config: TelegramBotPublicConfig) {
    window.dispatchEvent(new CustomEvent<TelegramBotPublicConfig>(BOT_STATUS_EVENT, { detail: config }));
}
