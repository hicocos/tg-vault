export type TelegramUserClientState = 'not_configured' | 'missing_session' | 'ready' | 'expired' | 'permission_denied' | 'error';

export interface TelegramUserClientStatus {
    status: TelegramUserClientState;
    userId: string | null;
    username: string | null;
    checkedAt: string | null;
    lastError: string | null;
    action: string | null;
}

let current: TelegramUserClientStatus = {
    status: 'not_configured', userId: null, username: null, checkedAt: null, lastError: null, action: '配置 Telegram API 与用户 session',
};

export function getTelegramUserClientStatus(): TelegramUserClientStatus {
    return { ...current };
}

export function recordTelegramUserClientReady(input: { userId: string; username?: string | null; checkedAt?: string }): void {
    current = {
        status: 'ready', userId: input.userId, username: input.username || null,
        checkedAt: input.checkedAt || new Date().toISOString(), lastError: null, action: null,
    };
}

export function recordTelegramUserClientFailure(status: Exclude<TelegramUserClientState, 'ready'>, message: string): void {
    const actions: Record<Exclude<TelegramUserClientState, 'ready'>, string> = {
        not_configured: '配置 TELEGRAM_API_ID、TELEGRAM_API_HASH 和 session 文件',
        missing_session: '运行 Docker 登录命令生成 session 并重启后端',
        expired: '重新生成 session 并重启后端',
        permission_denied: '先用该账号加入目标频道并重新测试',
        error: '检查网络与后端日志后重新测试',
    };
    current = { ...current, status, checkedAt: new Date().toISOString(), lastError: message, action: actions[status] };
}
