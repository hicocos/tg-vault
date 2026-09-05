import type { TransferTaskRecord } from './transferTasks.js';

export type UnifiedTaskSourceType = 'telegram_bot' | 'telegram_channel' | 'web_upload' | 'subscription' | 'telegram_target';

export interface UnifiedTask {
    id: string;
    sourceType: UnifiedTaskSourceType;
    kind: string;
    title: string;
    status: string;
    stage: string;
    progress: number;
    ownerUserId: number | null;
    chatId: string | null;
    source: string | null;
    target: {
        provider: string | null;
        accountId: string | null;
        accountName: string | null;
        folder: string | null;
    };
    counts: { total: number; completed: number; failed: number };
    bytes: { total: number; transferred: number };
    detail: Record<string, unknown>;
    error: string | null;
    retryable: boolean;
    cancellable: boolean;
    createdAt: Date | string;
    updatedAt: Date | string;
    finishedAt: Date | string | null;
}

export interface TelegramChannelTaskState {
    status: string;
    stage: string;
}

function safeNumber(value: unknown): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function parseTaskOptions(value: unknown): Record<string, any> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function channelStatus(status: string): string {
    if (status === 'queued') return 'pending';
    if (status === 'cooling') return 'waiting';
    if (status === 'completed_with_errors') return 'failed';
    return status;
}

export function telegramChannelJobTaskState(row: any): TelegramChannelTaskState {
    const status = channelStatus(String(row?.status || 'pending'));
    const scanStatus = String(row?.scan_status || 'pending');
    const stage = status === 'completed'
        ? 'completed'
        : status === 'failed'
            ? 'failed'
            : status === 'cancelled' || scanStatus === 'cancelled'
                ? 'cancelled'
                : scanStatus === 'scanning'
                    ? 'scanning'
                    : scanStatus === 'done'
                        ? 'downloading'
                        : 'waiting';
    return { status, stage };
}

export function mapTelegramChannelJob(row: any, accountNames: ReadonlyMap<string, string>): UnifiedTask {
    const params = parseTaskOptions(row?.params);
    const state = telegramChannelJobTaskState(row);
    const total = Math.max(safeNumber(row?.total_count), safeNumber(row?.item_count));
    const failed = safeNumber(row?.failed_items ?? row?.failed_count);
    const skipped = safeNumber(row?.skipped_count_items ?? row?.skipped_count);
    const completed = safeNumber(row?.completed_items ?? row?.success_count)
        || (['completed', 'completed_with_errors'].includes(String(row?.status))
            ? Math.max(0, total - failed - skipped - safeNumber(row?.active_items))
            : 0);
    const accountId = params.storageAccountId == null ? null : String(params.storageAccountId);
    const provider = params.storageProvider == null ? null : String(params.storageProvider);
    return {
        id: String(row?.id),
        sourceType: 'telegram_channel',
        kind: String(row?.kind),
        title: row?.source || 'Telegram 频道任务',
        status: state.status,
        stage: state.stage,
        progress: total > 0 ? Math.min(100, ((completed + failed + skipped) / total) * 100) : 0,
        ownerUserId: row?.user_id == null ? null : safeNumber(row.user_id),
        chatId: row?.chat_id == null ? null : String(row.chat_id),
        source: row?.source == null ? null : String(row.source),
        target: {
            provider,
            accountId,
            accountName: accountId ? accountNames.get(accountId) || null : (provider === 'local' ? '服务器本地目录' : null),
            folder: params.folderOverride == null ? null : String(params.folderOverride),
        },
        counts: { total, completed, failed },
        bytes: { total: safeNumber(row?.total_bytes), transferred: 0 },
        detail: { scanStatus: row?.scan_status, downloadStatus: row?.download_status, skipped },
        error: row?.error == null ? null : String(row.error),
        retryable: ['failed', 'completed_with_errors'].includes(String(row?.status)),
        cancellable: ['queued', 'running', 'paused', 'cooling'].includes(String(row?.status)),
        createdAt: row?.created_at,
        updatedAt: row?.updated_at,
        finishedAt: row?.finished_at || null,
    };
}

export function mapTransferTask(task: TransferTaskRecord, accountNames: ReadonlyMap<string, string>): UnifiedTask {
    return {
        id: task.id,
        sourceType: task.sourceType,
        kind: task.kind,
        title: task.title,
        status: task.status,
        stage: task.stage,
        progress: task.progress,
        ownerUserId: task.ownerUserId,
        chatId: task.chatId,
        source: task.source,
        target: {
            provider: task.targetProvider,
            accountId: task.targetAccountId,
            accountName: task.targetAccountId ? accountNames.get(task.targetAccountId) || null : (task.targetProvider === 'local' ? '服务器本地目录' : null),
            folder: task.targetFolder,
        },
        counts: { total: task.totalItems, completed: task.completedItems, failed: task.failedItems },
        bytes: { total: task.totalBytes, transferred: task.transferredBytes },
        detail: task.payload,
        error: task.error,
        retryable: task.retryable,
        cancellable: ['pending', 'running', 'paused'].includes(task.status) || task.retryable,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        finishedAt: task.finishedAt,
    };
}
