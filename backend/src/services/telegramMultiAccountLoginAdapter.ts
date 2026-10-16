import type { TelegramAuthorizedAccountAdapter } from './telegramMultiAccountLogin.js';
import { TelegramUserLoginFlowError } from './telegramMultiAccountLoginFlows.js';

export interface TelegramLoginAccountRepository {
    upsertAccount(input: {
        telegramUserId: string;
        username?: string | null;
        displayName?: string | null;
        session: string;
        enabled?: boolean;
    }): Promise<{ id: string; enabled: boolean }>;
    reauthenticateAccount(input: {
        accountId: string;
        telegramUserId: string;
        username: string | null;
        displayName: string | null;
        session: string;
    }): Promise<{ id: string; enabled: boolean } | null>;
}

export interface TelegramLoginAccountPool {
    activateAccount(accountId: string, reason: 'login_complete', credentials: { apiId: number; apiHash: string }): Promise<void>;
}

export interface TelegramLoginAccountAccessSweep {
    trigger(input: { accountIds: string[]; reason: 'account_created' | 'account_reauthenticated' }): Promise<unknown>;
}

/**
 * Production seam between ephemeral authentication and persistent account
 * runtime state. The repository owns encryption and userId upsert semantics;
 * the pool is reloaded only after the database write succeeds.
 */
export function createTelegramMultiAccountAuthorizedAdapter(deps: {
    repository: TelegramLoginAccountRepository;
    pool: TelegramLoginAccountPool;
    accessSweep?: TelegramLoginAccountAccessSweep;
}): TelegramAuthorizedAccountAdapter {
    return {
        async upsertByTelegramUserId({ session, credentials, account, target }): Promise<void> {
            if (target && target.telegramUserId !== account.userId) {
                throw new TelegramUserLoginFlowError('ACCOUNT_MISMATCH', '当前登录账号与待恢复账号不一致，请使用原账号重新登录');
            }
            const persisted = target
                ? await deps.repository.reauthenticateAccount({
                    accountId: target.accountId,
                    telegramUserId: target.telegramUserId,
                    username: account.username,
                    displayName: account.displayName,
                    session,
                })
                : await deps.repository.upsertAccount({
                    telegramUserId: account.userId,
                    username: account.username,
                    displayName: account.displayName,
                    session,
                    enabled: true,
                });
            if (target && !persisted) throw new TelegramUserLoginFlowError('ACCOUNT_NOT_FOUND', '待重新登录的账号不存在或已删除');
            const accountId = persisted?.id;
            if (accountId) await deps.pool.activateAccount(accountId, 'login_complete', credentials);
            if (accountId && deps.accessSweep && persisted?.enabled) {
                await deps.accessSweep.trigger({ accountIds: [accountId], reason: target ? 'account_reauthenticated' : 'account_created' });
            }
        },
    };
}
