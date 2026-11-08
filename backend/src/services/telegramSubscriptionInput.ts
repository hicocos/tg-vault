import { query } from '../db/index.js';
import { getConfiguredTelegramAllowedUsers } from '../utils/authSettings.js';
import { sanitizeCustomStoragePath } from '../utils/telegramPathSettings.js';
import { parseTelegramSubscriptionFileFilter } from '../utils/telegramSubscriptionFileFilter.js';
import type { TelegramSubscriptionConfiguration } from './telegramChannelJobs.js';

export async function listSubscriptionRecipients(): Promise<Array<{ userId: string }>> {
    const allowedUsers = await getConfiguredTelegramAllowedUsers();
    const result = await query(`SELECT user_id FROM telegram_auth
        WHERE ($1::bigint[] IS NULL OR user_id=ANY($1::bigint[])) ORDER BY user_id`,
        [allowedUsers.length ? allowedUsers : null]);
    return result.rows.filter(row => Number.isSafeInteger(Number(row.user_id)) && Number(row.user_id) > 0)
        .map(row => ({ userId: String(row.user_id) }));
}

export function parseSubscriptionConfiguration(body: unknown): TelegramSubscriptionConfiguration {
    if (!body || typeof body !== 'object') throw new Error('请提交订阅配置');
    const input = body as Record<string, unknown>;
    if (input.folderOverride !== null && typeof input.folderOverride !== 'string') throw new Error('folderOverride 必须是路径字符串或 null');
    const folderOverride = typeof input.folderOverride === 'string' && input.folderOverride.trim()
        ? sanitizeCustomStoragePath(input.folderOverride) : null;
    if (input.targetMode !== 'follow_global' && input.targetMode !== 'fixed') throw new Error('targetMode 必须是 follow_global 或 fixed');
    if (input.adFilterMode !== 'off' && input.adFilterMode !== 'conservative' && input.adFilterMode !== 'aggressive') {
        throw new Error('adFilterMode 必须是 off、conservative 或 aggressive');
    }
    let targetProvider: string | null = null;
    let targetAccountId: string | null = null;
    if (input.targetMode === 'fixed') {
        if (typeof input.targetProvider !== 'string' || !input.targetProvider.trim()) throw new Error('固定订阅目标必须指定存储提供商');
        targetProvider = input.targetProvider.trim();
        if (input.targetAccountId !== null) {
            if (typeof input.targetAccountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.targetAccountId.trim())) {
                throw new Error('无效的存储账户 ID');
            }
            targetAccountId = input.targetAccountId.trim();
        }
        if (targetProvider === 'local' && targetAccountId) throw new Error('本地存储目标不能绑定云存储账户');
        if (targetProvider !== 'local' && !targetAccountId) throw new Error('固定云存储目标必须指定存储账户');
    }
    return { folderOverride, targetMode: input.targetMode, targetProvider, targetAccountId,
        adFilterMode: input.adFilterMode, ...parseTelegramSubscriptionFileFilter(input) };
}
