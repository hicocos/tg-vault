import type { Api, TelegramClient } from 'telegram';
import { withTelegramAccount } from './telegramMultiAccountRuntime.js';
import { verifyTelegramScanVisibility, getTelegramMessagesWithAccess, type TelegramScanVisibility } from './telegramScanAccount.js';
import type { TelegramAccountFloodWait } from './telegramUserClientPool.js';

export interface TelegramScanReaderOptions {
    source: string;
    signal?: AbortSignal;
    preferredAccountId?: string;
    onAccount?: (accountId: string, visibility: TelegramScanVisibility) => Promise<void>;
    onFloodWait?: (event: TelegramAccountFloodWait) => Promise<void> | void;
    withAccount?: typeof withTelegramAccount;
}

export interface TelegramScanReaderStats {
    rpcRequests: number;
    rpcByMethod: Record<string, number>;
    readAttempts: number;
    floodWaits: number;
    floodWaitSeconds: number;
    readableAccounts: number;
    singleAccountRequests: number;
}

export interface TelegramScanReader {
    accountId?: string;
    stats: TelegramScanReaderStats;
    read(request: Parameters<TelegramClient['getMessages']>[1], checkpointId?: number): Promise<Api.Message[]>;
}

/** Retry only the failed read. Search results and album state stay in the caller. */
export function createTelegramScanReader(options: TelegramScanReaderOptions): TelegramScanReader {
    const withAccount = options.withAccount || withTelegramAccount;
    let visibility: TelegramScanVisibility | undefined;
    const stats: TelegramScanReaderStats = { rpcRequests: 0, rpcByMethod: {}, readAttempts: 0,
        floodWaits: 0, floodWaitSeconds: 0, readableAccounts: 0, singleAccountRequests: 0 };
    const reader: TelegramScanReader = {
        accountId: options.preferredAccountId,
        stats,
        async read(request, checkpointId = 0) {
            return withAccount(options.source, 'scan', async (client, accountId) => {
                stats.readAttempts++;
                if (!visibility || reader.accountId !== accountId) {
                    const verified = await verifyTelegramScanVisibility(client, options.source, checkpointId);
                    await options.onAccount?.(accountId, verified);
                    visibility = verified;
                    reader.accountId = accountId;
                }
                return getTelegramMessagesWithAccess(client, options.source, request, visibility);
            }, { signal: options.signal, preferredAccountId: reader.accountId,
                onScanRequest: ({ method, readableAccounts }) => {
                    stats.rpcRequests++;
                    stats.rpcByMethod[method] = (stats.rpcByMethod[method] || 0) + 1;
                    stats.readableAccounts = readableAccounts;
                    if (readableAccounts <= 1) stats.singleAccountRequests++;
                },
                onFloodWait: async event => {
                    stats.floodWaits++;
                    stats.floodWaitSeconds += event.seconds;
                    await options.onFloodWait?.(event);
                },
            });
        },
    };
    return reader;
}
