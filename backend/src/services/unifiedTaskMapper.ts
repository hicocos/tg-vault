import { downloadProgressView } from './downloadProgress.js';
import type { DownloadTaskGroupSnapshot } from './downloadTaskQueue.js';
import type { TransferTaskRecord } from './transferTasks.js';

export type UnifiedTaskSourceType = 'telegram_bot' | 'telegram_channel' | 'web_upload' | 'subscription' | 'telegram_target' | 'qbittorrent';

export interface UnifiedTask {
    id: string;
    sourceType: UnifiedTaskSourceType;
    kind: string;
    title: string;
    status: string;
    stage: string;
    progress: number;
    downloadProgress?: ReturnType<typeof downloadProgressView>;
    speedBytesPerSecond?: number;
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

/** Both clients count settled items, including failures and skips, as processed. */
export function telegramChannelJobCounts(row: Record<string, unknown>) {
    const params = parseTaskOptions(row?.params);
    const total = Math.max(safeNumber(row?.total_count), safeNumber(row?.item_count) + safeNumber(params.compactedItemCount));
    const failed = safeNumber(row?.failed_items ?? row?.failed_count);
    const skipped = Math.max(safeNumber(row?.skipped_count_items) + safeNumber(params.compactedSkippedCount), safeNumber(row?.skipped_count));
    const pending = safeNumber(row?.pending_count);
    const active = safeNumber(row?.downloading_count ?? row?.active_items);
    const completed = (safeNumber(row?.completed_items ?? row?.success_count) + safeNumber(params.compactedSuccessCount))
        || (['completed', 'completed_with_errors'].includes(String(row?.status))
            ? Math.max(0, total - failed - skipped - active - pending) : 0);
    return { total, completed, failed, skipped, pending, active, processed: completed + failed + skipped };
}

export function telegramChannelJobTaskState(row: Record<string, unknown>): TelegramChannelTaskState {
    let status = String(row.runtime_status || channelStatus(String(row?.status || 'pending')));
    const scanStatus = String(row?.scan_status || 'pending');
    const counts = telegramChannelJobCounts(row);
    if (status === 'awaiting_selection') return { status, stage: 'awaiting_selection' };
    if (status === 'running' && scanStatus === 'done' && counts.active === 0 && counts.pending > 0) status = 'pending';
    const stage = status === 'completed'
        ? 'completed'
        : status === 'failed'
            ? 'failed'
            : status === 'cancelled' || scanStatus === 'cancelled'
                ? 'cancelled'
                : status === 'paused' || status === 'pausing' || status === 'waiting'
                    ? status
                : scanStatus === 'scanning'
                    ? 'scanning'
                    : status === 'pending'
                        ? 'waiting'
                        : scanStatus === 'done'
                            ? (counts.active + counts.pending === 0 ? 'processing' : 'downloading')
                            : 'waiting';
    return { status, stage };
}

export function mapTelegramChannelJob(row: any, accountNames: ReadonlyMap<string, string>): UnifiedTask {
    const params = parseTaskOptions(row?.params);
    const state = telegramChannelJobTaskState(row);
    const checkpoint = parseTaskOptions(row?.scan_cursor);
    const scan = parseTaskOptions(checkpoint.progress || checkpoint);
    const { total, completed, failed, skipped, pending, active, processed } = telegramChannelJobCounts(row);
    const unfinished = !['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(String(row?.status));
    const accountId = params.storageAccountId == null ? null : String(params.storageAccountId);
    const provider = params.storageProvider == null ? null : String(params.storageProvider);
    return {
        id: String(row?.id),
        sourceType: 'telegram_channel',
        kind: String(row?.kind),
        title: row?.source || 'Telegram 频道任务',
        status: state.status,
        stage: state.stage === 'downloading' && row?.runtime_stage ? String(row.runtime_stage) : state.stage,
        progress: total > 0 ? Math.min(unfinished ? 99 : 100, (processed / total) * 100) : 0,
        ownerUserId: row?.user_id == null ? null : safeNumber(row.user_id),
        chatId: row?.chat_id == null ? null : String(row.chat_id),
        source: row?.source == null ? null : String(row.source),
        target: {
            provider,
            accountId,
            accountName: accountId ? params.storageAccountName || accountNames.get(accountId) || null : (provider === 'local' ? '服务器本地目录' : null),
            folder: params.folderOverride == null ? null : String(params.folderOverride),
        },
        counts: { total, completed, failed },
        bytes: { total: safeNumber(row?.total_bytes) + safeNumber(params.compactedTotalBytes),
            transferred: safeNumber(row?.completed_bytes) + safeNumber(params.completedBytes) },
        detail: { scanStatus: row?.scan_status, downloadStatus: row?.download_status,
            scan: ['date_range', 'tag_download'].includes(String(row?.kind)) ? scan : undefined,
            skipped, pending, active, processed,
            downloading: safeNumber(row?.runtime_downloading), uploading: safeNumber(row?.runtime_uploading),
            waitingUpload: safeNumber(row?.runtime_waiting_upload), retrying: safeNumber(row?.runtime_retrying),
            excluded: Number(params.excludedCount || 0), fileSelectionConfirmed: Boolean(params.fileSelectionConfirmed),
            speedBytesPerSecond: safeNumber(row?.speed_bytes_per_second), currentFileName: row?.current_file_name,
            savedUnknownCount: safeNumber(row?.completed_unknown_size_count) + safeNumber(params.savedUnknownCount),
            bytesKnown: safeNumber(row?.item_count) + safeNumber(params.compactedItemCount) >= total
                && safeNumber(row?.unknown_size_count) + safeNumber(params.compactedUnknownSizeCount) === 0,
            savedBytesKnown: safeNumber(row?.completed_unknown_size_count) === 0 && safeNumber(params.savedUnknownCount) === 0 },
        speedBytesPerSecond: safeNumber(row?.speed_bytes_per_second),
        error: row?.error == null ? null : String(row.error),
        retryable: ['failed', 'completed_with_errors'].includes(String(row?.status)),
        cancellable: ['queued', 'running', 'paused', 'cooling', 'awaiting_selection'].includes(String(row?.status)),
        createdAt: row?.created_at,
        updatedAt: row?.progress_updated_at || row?.updated_at,
        finishedAt: row?.finished_at || null,
    };
}

export function mapTransferTask(task: TransferTaskRecord, accountNames: ReadonlyMap<string, string>, live?: DownloadTaskGroupSnapshot): UnifiedTask {
    const fallbackProgress = live
        ? live.total > 0 ? Math.min(100, (live.completed + live.failed + live.cancelled) / live.total * 100) : 0
        : task.progress;
    const telemetry = downloadProgressView(live || { totalBytes: task.totalBytes, completedBytes: task.transferredBytes, ...task.payload }, live ? ['running', 'pausing'].includes(live.state) : task.status === 'running', fallbackProgress);
    const telegram = task.sourceType === 'telegram_bot';
    const status = live
        ? live.state === 'paused' || live.state === 'pausing' ? live.state
            : live.state === 'cancelling' || live.state === 'cancelled' ? 'cancelled'
                : live.state === 'completed' ? live.failed > 0 ? 'failed' : 'completed'
                    : live.state === 'running' ? 'running' : 'pending'
        : task.status;
    const retryable = live ? status === 'failed' : task.retryable;
    const terminal = live && ['completed', 'cancelled'].includes(live.state);
    return {
        id: task.id,
        sourceType: task.sourceType,
        kind: task.kind,
        title: task.title,
        status,
        stage: live ? status === 'running' ? live.stage : status === 'pending' ? 'waiting' : status : task.stage,
        progress: telegram ? telemetry.percent : task.progress,
        ...(telegram ? { downloadProgress: telemetry, speedBytesPerSecond: telemetry.speedBytesPerSecond } : {}),
        ownerUserId: task.ownerUserId,
        chatId: task.chatId,
        source: task.source,
        target: {
            provider: task.targetProvider,
            accountId: task.targetAccountId,
            accountName: task.targetAccountId ? accountNames.get(task.targetAccountId) || null : (task.targetProvider === 'local' ? '服务器本地目录' : null),
            folder: task.targetFolder,
        },
        counts: live ? { total: live.total, completed: live.completed, failed: live.failed }
            : { total: task.totalItems, completed: task.completedItems, failed: task.failedItems },
        bytes: telegram ? { total: telemetry.totalBytes, transferred: telemetry.completedBytes }
            : { total: task.totalBytes, transferred: task.sourceType === 'qbittorrent' && ['submitting', 'metadata', 'downloading'].includes(task.stage) ? Number(task.payload.downloadedBytes ?? Math.floor(task.totalBytes * Number(task.payload.downloadProgress || 0) / 100)) : task.transferredBytes },
        detail: telegram ? { ...task.payload, ...live, speedBytesPerSecond: telemetry.speedBytesPerSecond }
            : task.sourceType === 'qbittorrent' ? { downloadProgress: task.payload.downloadProgress, downloadSpeed: task.payload.downloadSpeed, downloadedBytes: task.payload.downloadedBytes, uploadSpeed: task.status === 'running' && task.stage === 'uploading' ? task.payload.uploadSpeed : 0, preserveLocalFiles: task.payload.preserveLocalFiles }
                : task.payload,
        error: live ? live.reason || (live.failed > 0 ? `${live.failed} 个文件处理失败` : null) : task.error,
        retryable,
        cancellable: !(task.sourceType === 'qbittorrent' && (task.cancelRequested || ['cleaning', 'cancelling'].includes(task.stage))) && (['pending', 'running', 'pausing', 'paused'].includes(status) || retryable),
        createdAt: task.createdAt,
        updatedAt: live ? new Date(live.updatedAt).toISOString() : task.updatedAt,
        finishedAt: live ? terminal ? new Date(live.updatedAt).toISOString() : null : task.finishedAt,
    };
}
