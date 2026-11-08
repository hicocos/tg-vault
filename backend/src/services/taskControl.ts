import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/index.js';
import { getTransferTask, updateTransferTask } from './transferTasks.js';
import { cancelDownloadTaskGroup, pauseDownloadTaskGroup, resumeDownloadTaskGroup, retryFailedDownloadTasks, getDownloadTaskSnapshot, getDownloadQueueStats, getTaskStatus } from './telegramUpload.js';
import { cancelTelegramBackgroundJob, pauseTelegramBackgroundJob, resumeTelegramBackgroundJob, retryTelegramBackgroundJob } from './telegramChannelJobs.js';
import { controlQbTask } from './qbittorrentTasks.js';
import type { StorageTargetSnapshot } from './storage/contracts.js';
import { qbEnabled } from './qbittorrentConfig.js';

export type StoredTaskSource = 'telegram_channel' | 'telegram_bot' | 'qbittorrent' | 'web_upload';
export type TaskAction = 'pause' | 'resume' | 'cancel' | 'retry';
export type TaskActionBlocks = Partial<Record<TaskAction, string>>;

export class TaskControlError extends Error {
    constructor(public readonly code: 'NOT_FOUND' | 'STATE_CONFLICT' | 'FILE_RESELECT_REQUIRED' | 'TASK_FINISHED', message: string) {
        super(message);
    }
}

function assertTarget(provider: string | null, accountId: string | null, target?: StorageTargetSnapshot): void {
    if (target && (provider !== target.provider.name || accountId !== target.accountId)) {
        throw new TaskControlError('NOT_FOUND', 'Task not found in the selected storage account');
    }
}

/** Reports local controller preconditions; execution still validates the live state and provider response. */
export async function getStoredTaskActionBlocks(source: StoredTaskSource, id: string, target: StorageTargetSnapshot): Promise<TaskActionBlocks> {
    const blocked: TaskActionBlocks = {};
    if (source === 'telegram_channel') {
        const row = (await query(`SELECT j.*, EXISTS (
            SELECT 1 FROM telegram_download_items i WHERE i.job_id=j.id AND i.status='failed'
            AND NOT EXISTS (SELECT 1 FROM telegram_write_reconciliations r WHERE r.item_id=i.id AND r.status='pending')
            ) AS retryable_items FROM telegram_background_jobs j WHERE j.id=$1`, [id])).rows[0];
        if (!row) throw new TaskControlError('NOT_FOUND', 'Task not found');
        assertTarget(row.params.storageProvider, row.params.storageAccountId, target);
        if (row.finished_at || ['completed', 'completed_with_errors', 'cancelled'].includes(row.status)) blocked.pause = blocked.resume = blocked.cancel = 'TASK_FINISHED';
        else if (row.cancelled_at || row.status !== 'paused') blocked.resume = 'TASK_NOT_PAUSED';
        if (row.cancelled_at || row.paused_at || !['failed', 'completed_with_errors'].includes(row.status)) blocked.retry = 'TASK_NOT_FAILED';
        else if (row.cooldown_until && new Date(row.cooldown_until).getTime() > Date.now()) blocked.retry = 'RATE_LIMITED';
        else if (!row.retryable_items && !(['date_range', 'tag_download'].includes(row.kind) && 'mode' in row.params && row.scan_status !== 'done')) blocked.retry = 'NO_RETRYABLE_ITEMS';
        return blocked;
    }
    if (source === 'web_upload') {
        const row = (await query('SELECT target_provider,target_account_id,status FROM chunk_upload_sessions WHERE upload_id=$1', [id])).rows[0];
        if (!row) throw new TaskControlError('NOT_FOUND', 'Upload session not found');
        assertTarget(row.target_provider, row.target_account_id, target);
        return { pause: 'ACTION_UNSUPPORTED', resume: 'ACTION_UNSUPPORTED', retry: 'FILE_RESELECT_REQUIRED',
            ...(!['open', 'failed'].includes(row.status) ? { cancel: 'INVALID_STATE' } : {}) };
    }
    const task = await getTransferTask(source, id);
    if (!task) throw new TaskControlError('NOT_FOUND', 'Task not found');
    assertTarget(task.targetProvider, task.targetAccountId, target);
    if (['completed', 'cancelled'].includes(task.status)) return { pause: 'TASK_FINISHED', resume: 'TASK_FINISHED', retry: 'TASK_FINISHED', cancel: 'TASK_FINISHED' };
    if (source === 'qbittorrent') {
        if (!await qbEnabled()) return { pause: 'EXTENSION_DISABLED', resume: 'EXTENSION_DISABLED', retry: 'EXTENSION_DISABLED', cancel: 'EXTENSION_DISABLED' };
        if (task.status !== 'failed') blocked.retry = 'TASK_NOT_FAILED';
        if (task.cancelRequested || ['cancelling', 'cleaning'].includes(task.stage)) blocked.pause = blocked.resume = blocked.cancel = 'CLEANUP_IN_PROGRESS';
        return blocked;
    }
    const scoped = Boolean(task.chatId && task.ownerUserId != null);
    const live = scoped ? getDownloadTaskSnapshot(id, task.chatId!, task.ownerUserId!) : undefined;
    const controllable = live && !['completed', 'cancelled', 'cancelling'].includes(live.state);
    if (!controllable) blocked.pause = blocked.resume = 'SOURCE_REQUIRED';
    else {
        const queue = getDownloadQueueStats();
        if (queue.systemPause || queue.userPaused) blocked.resume = 'QUEUE_PAUSED';
    }
    if (!['failed', 'interrupted', 'retry_required'].includes(task.status) && !task.retryable && !controllable) blocked.cancel = 'TASK_FINISHED';
    if (!scoped || task.status === 'interrupted') blocked.retry = 'FILE_RESELECT_REQUIRED';
    else if (!live || ['cancelled', 'cancelling'].includes(live.state)
        || !getTaskStatus().history.some(item => item.groupId === id && item.status === 'failed')) blocked.retry = 'NO_RETRYABLE_ITEMS';
    return blocked;
}

export async function controlStoredTask(source: StoredTaskSource, id: string, action: TaskAction, target?: StorageTargetSnapshot): Promise<Record<string, unknown>> {
    if (source === 'telegram_channel') {
        const row = (await query('SELECT user_id, chat_id, params, status, finished_at FROM telegram_background_jobs WHERE id=$1', [id])).rows[0];
        if (!row) throw new TaskControlError('NOT_FOUND', 'Task not found');
        assertTarget(row.params.storageProvider, row.params.storageAccountId, target);
        if (action !== 'retry' && (row.finished_at || ['completed', 'completed_with_errors', 'cancelled'].includes(row.status))) {
            throw new TaskControlError('TASK_FINISHED', 'The task has finished and cannot perform this action');
        }
        const controls = { pause: pauseTelegramBackgroundJob, resume: resumeTelegramBackgroundJob,
            cancel: cancelTelegramBackgroundJob, retry: retryTelegramBackgroundJob };
        const result = await controls[action](Number(row.user_id), id, row.chat_id == null ? undefined : String(row.chat_id));
        if (!result) throw new TaskControlError('STATE_CONFLICT', 'The task cannot perform this action in its current state');
        return { success: true, taskId: id, sourceType: source, action, ...result };
    }
    if (source === 'web_upload') {
        const row = (await query('SELECT target_provider, target_account_id FROM chunk_upload_sessions WHERE upload_id=$1', [id])).rows[0];
        if (!row) throw new TaskControlError('NOT_FOUND', 'Upload session not found');
        assertTarget(row.target_provider, row.target_account_id, target);
        if (action === 'retry') throw new TaskControlError('FILE_RESELECT_REQUIRED', 'Select the original file in the Web interface to resume this upload');
        if (action !== 'cancel') throw new TaskControlError('STATE_CONFLICT', 'Chunked uploads only support cancellation');
        const result = await query(`UPDATE chunk_upload_sessions SET status='cancelled', last_error='Cancelled by administrator', updated_at=NOW()
            WHERE upload_id=$1 AND status IN ('open','failed') RETURNING upload_id`, [id]);
        if (!result.rowCount) throw new TaskControlError('STATE_CONFLICT', 'Upload is completing or already ended');
        await fs.rm(path.join(process.env.CHUNK_DIR || './data/chunks', id), { recursive: true, force: true });
        return { success: true, taskId: id, sourceType: source, action };
    }
    const task = await getTransferTask(source, id);
    if (!task) throw new TaskControlError('NOT_FOUND', 'Task not found');
    assertTarget(task.targetProvider, task.targetAccountId, target);
    if (['completed', 'cancelled'].includes(task.status)) throw new TaskControlError('TASK_FINISHED', 'The task has finished and cannot perform this action');
    if (source === 'qbittorrent') {
        await controlQbTask(id, action);
        return { success: true, taskId: id, sourceType: source, action };
    }
    if (action === 'pause' || action === 'resume') {
        if (!task.chatId || task.ownerUserId == null) throw new TaskControlError('STATE_CONFLICT', 'Task is missing its control scope');
        const control = action === 'pause' ? pauseDownloadTaskGroup : resumeDownloadTaskGroup;
        const result = control(id, task.chatId, task.ownerUserId);
        if (result.status !== 'ok') throw new TaskControlError('STATE_CONFLICT', 'Task state changed; refresh its details');
    } else if (action === 'cancel') {
        if (!['failed', 'interrupted', 'retry_required'].includes(task.status) && !task.retryable) {
            const result = task.chatId && task.ownerUserId
                ? cancelDownloadTaskGroup(id, task.chatId, task.ownerUserId) : { status: 'not_found' };
            if (result.status !== 'ok') throw new TaskControlError('STATE_CONFLICT', 'Task cannot currently be cancelled');
        }
        await updateTransferTask('telegram_bot', id, { status: 'cancelled', stage: 'cancelled', retryable: false,
            cancelRequested: true, finishedAt: new Date(), error: 'Cancelled by administrator' });
    } else {
        if (!task.chatId || !task.ownerUserId || task.status === 'interrupted') {
            throw new TaskControlError('FILE_RESELECT_REQUIRED', 'This Bot task cannot be reconstructed after restart; resend the original file in Telegram');
        }
        const result = await retryFailedDownloadTasks(50, id, task.chatId, task.ownerUserId);
        if (!result.retried) throw new TaskControlError('STATE_CONFLICT', 'No failed files are currently retryable');
        return { success: true, taskId: id, sourceType: source, action, retried: result.retried };
    }
    return { success: true, taskId: id, sourceType: source, action };
}
