export const TELEGRAM_USER_CANCELLED_SUBSCRIPTION_REASON = '用户手动取消订阅';

type TelegramSubscriptionVisibilityRow = {
    enabled: boolean;
    disabled_reason?: string | null;
};

export function isTelegramSubscriptionVisibleInManagement(row: TelegramSubscriptionVisibilityRow): boolean {
    return row.enabled || row.disabled_reason !== TELEGRAM_USER_CANCELLED_SUBSCRIPTION_REASON;
}
