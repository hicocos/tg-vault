import type { TelegramClient } from 'telegram';
import { telegramAccountRepository } from './telegramAccountRepository.js';
import {
    initializeTelegramUserClientPool,
    telegramUserClientPool,
    type SelectedTelegramDownloadAccount,
    type TelegramAccountSelectionOptions,
} from './telegramUserClientPool.js';
import { registerTelegramMultiAccountAuthorizedAdapter } from './telegramMultiAccountLogin.js';
import { createTelegramMultiAccountAuthorizedAdapter } from './telegramMultiAccountLoginAdapter.js';
import { triggerTelegramAccountAccessSweep } from './telegramAccountAccessSweep.js';
import { installTelegramAccountAccessSweep } from './telegramAccountAccessSweepAdapter.js';
import { normalizeTelegramAccountSourceKey } from './telegramAccountScheduler.js';
import { waitForInitialTelegramRecovery } from './telegramInitialRecovery.js';

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
    await waitForInitialTelegramRecovery(normalized.signal);
    return telegramUserClientPool.select(sourceKey, { ...normalized, scope: normalized.scope || 'download' });
}

export async function markTelegramAccountCooldown(accountId: string, seconds: number, error: string | null = null): Promise<void> {
    const safeSeconds = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60;
    telegramUserClientPool.updateCooldown(accountId, new Date(Date.now() + safeSeconds * 1000), error);
    await telegramAccountRepository.markCooldown(accountId, safeSeconds, error);
}

export async function markTelegramAccountSourceAccess(
    accountId: string,
    sourceKey: string,
    scope: 'download' | 'scan' | 'metadata',
    state: 'unknown' | 'allowed' | 'denied',
    error: string | null = null,
): Promise<void> {
    const key = normalizeTelegramAccountSourceKey(sourceKey);
    await telegramAccountRepository.markSourceAccess(accountId, key, scope, state, error);
    telegramUserClientPool.updateSourceAccess(accountId, key, scope, state);
}

export async function markTelegramAccountSessionExpired(accountId: string, error: string | null = null): Promise<void> {
    await telegramAccountRepository.markSessionExpired(accountId, error);
    await telegramUserClientPool.expireAccount(accountId);
}

/** The callback owns cancellation of in-flight RPCs; the lease remains held until it settles. */
export async function withTelegramAccount<T>(
    sourceKey: string,
    scope: 'download' | 'scan' | 'metadata',
    operation: (client: TelegramClient, accountId: string) => Promise<T>,
    options: Pick<TelegramAccountSelectionOptions, 'signal' | 'preferredAccountId' | 'excludeAccountIds' | 'onFloodWait' | 'onScanRequest' | 'onDownloadRetry'> = {},
): Promise<T> {
    await waitForInitialTelegramRecovery(options.signal);
    return telegramUserClientPool.withAccount(sourceKey, scope, operation, options);
}


export {
    classifyTelegramDownloadAccountError,
    telegramFloodWaitSeconds,
    NoEligibleTelegramAccountError,
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
