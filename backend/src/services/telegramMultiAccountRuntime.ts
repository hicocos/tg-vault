import type { TelegramClient } from 'telegram';
import { telegramAccountRepository } from './telegramAccountRepository.js';
import {
    initializeTelegramUserClientPool,
    telegramUserClientPool,
    type SelectedTelegramDownloadAccount,
    type TelegramAccountSelectionOptions,
    isTelegramSessionExpiredError,
} from './telegramUserClientPool.js';
import { registerTelegramMultiAccountAuthorizedAdapter } from './telegramMultiAccountLogin.js';
import { createTelegramMultiAccountAuthorizedAdapter } from './telegramMultiAccountLoginAdapter.js';
import { triggerTelegramAccountAccessSweep } from './telegramAccountAccessSweep.js';
import { installTelegramAccountAccessSweep } from './telegramAccountAccessSweepAdapter.js';

let installed = false;
let initializationPromise: Promise<void> | null = null;

export async function installTelegramMultiAccountRuntimeAdapters(): Promise<void> {
    if (installed) return;
    installTelegramAccountAccessSweep({ clientPool: telegramUserClientPool });
    registerTelegramMultiAccountAuthorizedAdapter(createTelegramMultiAccountAuthorizedAdapter({
        repository: telegramAccountRepository,
        pool: {
            activateAccount: (accountId, reason, credentials) => telegramUserClientPool.activateAccount(accountId, reason, credentials),
        },
        accessSweep: { trigger: options => triggerTelegramAccountAccessSweep(options) },
    }));
    installed = true;
}

export async function initializeTelegramMultiAccountRuntime(credentials: { apiId: number; apiHash: string }): Promise<void> {
    if (initializationPromise) return initializationPromise;
    const run = (async () => {
        await installTelegramMultiAccountRuntimeAdapters();
        await initializeTelegramUserClientPool(credentials);
    })();
    initializationPromise = run;
    try {
        await run;
    } finally {
        if (initializationPromise === run) initializationPromise = null;
    }
}

export async function selectTelegramDownloadAccount(
    sourceKey: string,
    options: TelegramAccountSelectionOptions | Iterable<string> = {},
): Promise<SelectedTelegramDownloadAccount<TelegramClient> | null> {
    const normalized = typeof (options as Iterable<string>)?.[Symbol.iterator] === 'function'
        ? { excludeAccountIds: options as Iterable<string> }
        : options as TelegramAccountSelectionOptions;
    return telegramUserClientPool.select(sourceKey, { ...normalized, scope: normalized.scope || 'download' });
}

export async function markTelegramAccountCooldown(accountId: string, seconds: number, error: string | null = null): Promise<void> {
    await telegramAccountRepository.markCooldown(accountId, seconds, error);
    const safeSeconds = Number.isFinite(seconds) ? Math.max(1, seconds) : 60;
    telegramUserClientPool.updateCooldown(accountId, new Date(Date.now() + safeSeconds * 1000), error);
}

export async function markTelegramAccountSourceAccess(
    accountId: string,
    sourceKey: string,
    scope: 'download' | 'scan' | 'metadata',
    state: 'unknown' | 'allowed' | 'denied',
    error: string | null = null,
): Promise<void> {
    await telegramAccountRepository.markSourceAccess(accountId, sourceKey, scope, state, error);
    telegramUserClientPool.updateSourceAccess(accountId, sourceKey, scope, state);
}

export async function markTelegramAccountSessionExpired(accountId: string, error: string | null = null): Promise<void> {
    await telegramAccountRepository.markSessionExpired(accountId, error);
    await telegramUserClientPool.expireAccount(accountId);
}

export function classifyTelegramDownloadAccountError(error: unknown): 'session_expired' | 'permission_denied' | 'flood_wait' | 'retryable' {
    const value = error as { errorMessage?: unknown; message?: unknown; seconds?: unknown; value?: unknown } | null;
    const text = `${value?.errorMessage || ''} ${value?.message || ''}`;
    if (isTelegramSessionExpiredError(error)) return 'session_expired';
    if (/CHANNEL_PRIVATE|USER_NOT_PARTICIPANT|CHAT_FORBIDDEN|CHAT_ADMIN_REQUIRED|Could not find the input entity|Cannot find any entity|forbidden|privacy/i.test(text)) return 'permission_denied';
    if (Number(value?.seconds || value?.value || text.match(/FLOOD_WAIT_?(\d+)/i)?.[1] || 0) > 0 || /FLOOD|Too many requests/i.test(text)) return 'flood_wait';
    return 'retryable';
}

export function telegramFloodWaitSeconds(error: unknown): number {
    const value = error as { errorMessage?: unknown; message?: unknown; seconds?: unknown; value?: unknown } | null;
    const text = `${value?.errorMessage || ''} ${value?.message || ''}`;
    return Math.max(30, Number(value?.seconds || value?.value || text.match(/FLOOD_WAIT_?(\d+)/i)?.[1] || 60));
}

export {
    deleteTelegramUserAccount,
    finishTelegramDownloadAttempt,
    getTelegramAccountSourceAccess,
    getTelegramUserClientPoolState,
    listTelegramAccountSourceAccess,
    listTelegramUserAccounts,
    probeTelegramAccountSourceAccess,
    reloadTelegramUserClientPool,
    setTelegramUserAccountEnabled,
    startTelegramDownloadAttempt,
    upsertTelegramUserAccount,
} from './telegramUserClientPool.js';

export { telegramUserClientPool };
