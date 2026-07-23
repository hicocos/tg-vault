import { Router, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/index.js';
import { requireAuth, getAuthToken } from './auth.js';
import { webDestructiveConfirmationStore } from '../services/webDestructiveConfirmation.js';
import { listTransferTasks, getTransferTask, updateTransferTask } from '../services/transferTasks.js';
import { cancelYtDlpTask, retryYtDlpTask } from '../services/ytDlpDownload.js';
import { cancelDownloadTaskGroup, retryFailedDownloadTasks, cancelChannelExecutionGroup } from '../services/telegramUpload.js';
import { cancelTelegramBackgroundJob, retryTelegramBackgroundJob } from '../services/telegramChannelJobs.js';
import { filterDismissedTasks, isTaskDismissible, loadTaskCenterDismissals, saveTaskCenterDismissals } from '../services/taskCenterDismissals.js';
import crypto from 'node:crypto';

const router = Router();
const CHUNK_DIR = process.env.CHUNK_DIR || './data/chunks';

function parseJsonObject(value: unknown): Record<string, any> {
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

async function collectUnifiedTasks(limit: number): Promise<any[]> {
        const [transfers, channels, chunks, subscriptions, accounts] = await Promise.all([
            listTransferTasks({ limit }),
            query(
                `SELECT j.*,
                        COUNT(i.id)::int AS item_count,
                        COUNT(i.id) FILTER (WHERE i.status = 'success')::int AS completed_items,
                        COUNT(i.id) FILTER (WHERE i.status = 'failed')::int AS failed_items,
                        COUNT(i.id) FILTER (WHERE i.status IN ('pending','downloading'))::int AS active_items,
                        COALESCE(SUM(i.total_size), 0)::text AS total_bytes
                 FROM telegram_background_jobs j
                 LEFT JOIN telegram_download_items i ON i.job_id = j.id
                 GROUP BY j.id
                 ORDER BY j.updated_at DESC LIMIT $1`,
                [limit],
            ),
            query(
                `SELECT * FROM chunk_upload_sessions
                 WHERE status IN ('open','completing','failed') AND expires_at > NOW()
                 ORDER BY updated_at DESC LIMIT $1`,
                [limit],
            ),
            query(
                `SELECT * FROM telegram_channel_subscriptions
                 ORDER BY updated_at DESC LIMIT $1`,
                [limit],
            ),
            query('SELECT id, name FROM storage_accounts'),
        ]);
        const accountNames = new Map(accounts.rows.map(row => [String(row.id), String(row.name)]));
        const tasks: any[] = transfers.map(task => ({
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
            cancellable: ['pending', 'running', 'paused'].includes(task.status),
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            finishedAt: task.finishedAt,
        }));
        for (const row of channels.rows) {
            const params = parseJsonObject(row.params);
            const total = Math.max(Number(row.total_count || 0), Number(row.item_count || 0));
            const completed = Number(row.completed_items || 0);
            const failed = Number(row.failed_items || 0);
            tasks.push({
                id: String(row.id),
                sourceType: 'telegram_channel',
                kind: String(row.kind),
                title: row.source || 'Telegram 频道任务',
                status: channelStatus(String(row.status)),
                stage: row.scan_status !== 'completed' ? 'scanning' : 'downloading',
                progress: total > 0 ? Math.min(100, ((completed + failed + Number(row.skipped_count || 0)) / total) * 100) : 0,
                ownerUserId: Number(row.user_id),
                chatId: row.chat_id == null ? null : String(row.chat_id),
                source: row.source,
                target: {
                    provider: params.storageProvider || null,
                    accountId: params.storageAccountId || null,
                    accountName: params.storageAccountId ? accountNames.get(String(params.storageAccountId)) || null : (params.storageProvider === 'local' ? '服务器本地目录' : null),
                    folder: params.folderOverride || null,
                },
                counts: { total, completed, failed },
                bytes: { total: Number(row.total_bytes || 0), transferred: 0 },
                detail: { scanStatus: row.scan_status, downloadStatus: row.download_status, skipped: Number(row.skipped_count || 0) },
                error: row.error,
                retryable: ['failed', 'completed_with_errors'].includes(String(row.status)),
                cancellable: ['queued', 'running', 'paused', 'cooling'].includes(String(row.status)),
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                finishedAt: row.finished_at,
            });
        }
        for (const row of chunks.rows) {
            const total = Number(row.total_size || 0);
            const received = Number(row.received_bytes || 0);
            tasks.push({
                id: String(row.upload_id),
                sourceType: 'web_upload',
                kind: 'chunk_upload',
                title: String(row.filename),
                status: row.status === 'open' ? 'waiting' : String(row.status),
                stage: row.status === 'completing' ? 'processing' : row.status === 'open' ? 'resumable' : 'awaiting_file',
                progress: total > 0 ? Math.round((received / total) * 100) : 0,
                ownerUserId: null,
                chatId: null,
                source: 'Web',
                target: {
                    provider: row.target_provider,
                    accountId: row.target_account_id,
                    accountName: row.target_account_id ? accountNames.get(String(row.target_account_id)) || null : '服务器本地目录',
                    folder: row.folder,
                },
                counts: { total: Number(row.total_chunks || 0), completed: 0, failed: row.status === 'failed' ? 1 : 0 },
                bytes: { total, transferred: received },
                detail: { expiresAt: row.expires_at },
                error: row.last_error,
                retryable: row.status !== 'completing',
                cancellable: row.status !== 'completing',
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                finishedAt: null,
            });
        }
        for (const row of subscriptions.rows) {
            tasks.push({
                id: String(row.id),
                sourceType: 'subscription',
                kind: 'telegram_subscription',
                title: row.title || row.source,
                status: row.enabled ? 'scheduled' : 'disabled',
                stage: row.enabled ? 'waiting_for_next_scan' : 'disabled',
                progress: 0,
                ownerUserId: Number(row.user_id),
                chatId: row.chat_id == null ? null : String(row.chat_id),
                source: row.source,
                target: { provider: null, accountId: null, accountName: null, folder: row.folder_override || null },
                counts: { total: 0, completed: 0, failed: 0 },
                bytes: { total: 0, transferred: 0 },
                detail: { lastMessageId: Number(row.last_message_id || 0) },
                error: row.disabled_reason,
                retryable: false,
                cancellable: false,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                finishedAt: null,
            });
        }

        return tasks;
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
        const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
        const tasks = filterDismissedTasks(await collectUnifiedTasks(limit), await loadTaskCenterDismissals())
            .map(task => ({ ...task, dismissible: isTaskDismissible(task) }));
        const source = String(req.query.source || '').trim();
        const status = String(req.query.status || '').trim();
        const filtered = tasks
            .filter(task => !source || task.sourceType === source)
            .filter(task => !status || task.status === status)
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
            .slice(0, limit);
        res.json({ tasks: filtered, total: filtered.length, generatedAt: new Date().toISOString() });
    } catch (error) {
        console.error('获取统一任务列表失败:', error);
        res.status(500).json({ error: '获取任务列表失败' });
    }
});

router.post('/dismissals/prepare', requireAuth, async (req: Request, res: Response) => {
    try {
        const authToken = getAuthToken(req);
        if (!authToken) return res.status(401).json({ error: '未认证' });
        const source = String(req.body?.source || '').trim();
        const status = String(req.body?.status || '').trim();
        const requested = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
        const requestedKeys = new Set(requested.map((item: any) => `${String(item.sourceType)}:${String(item.id)}`));
        const all = filterDismissedTasks(await collectUnifiedTasks(500), await loadTaskCenterDismissals());
        const selected = all
            .filter(task => isTaskDismissible(task))
            .filter(task => requestedKeys.size > 0 ? requestedKeys.has(`${task.sourceType}:${task.id}`) : (!source || task.sourceType === source) && (!status || task.status === status))
            .map(task => ({ sourceType: task.sourceType, id: task.id, status: task.status, title: task.title, updatedAt: task.updatedAt }));
        if (selected.length === 0) return res.status(409).json({ error: '当前范围没有可删除的终态记录' });
        const context = JSON.stringify(selected);
        const snapshotId = crypto.createHash('sha256').update(context).digest('hex');
        const bySource = Object.fromEntries([...new Set(selected.map(item => item.sourceType))].map(key => [key, selected.filter(item => item.sourceType === key).length]));
        const byStatus = Object.fromEntries([...new Set(selected.map(item => item.status))].map(key => [key, selected.filter(item => item.status === key).length]));
        res.json({
            ...webDestructiveConfirmationStore.issue({ authToken, action: 'dismiss_tasks', objectId: snapshotId, context }),
            snapshotId,
            context,
            impact: { count: selected.length, bySource, byStatus, filesDeleted: false, cloudObjectsDeleted: false, subscriptionsDeleted: false },
        });
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : '创建删除预览失败' });
    }
});

router.post('/dismissals/confirm', requireAuth, async (req: Request, res: Response) => {
    const authToken = getAuthToken(req);
    const confirmationToken = String(req.header('x-confirmation-token') || '');
    const snapshotId = String(req.body?.snapshotId || '');
    const context = String(req.body?.context || '');
    const confirmed = authToken && confirmationToken
        ? webDestructiveConfirmationStore.consume(confirmationToken, { authToken, action: 'dismiss_tasks', objectId: snapshotId, context })
        : { status: 'missing' as const };
    if (confirmed.status !== 'ok') return res.status(409).json({ error: '需要一次性任务删除确认令牌', code: 'CONFIRMATION_REQUIRED' });
    try {
        const frozen = JSON.parse(context) as any[];
        const live = await collectUnifiedTasks(500);
        const liveMap = new Map(live.map(task => [`${task.sourceType}:${task.id}`, task]));
        const dismissed: any[] = [];
        const failed: any[] = [];
        for (const item of frozen) {
            const task = liveMap.get(`${item.sourceType}:${item.id}`);
            if (!task || !isTaskDismissible(task) || new Date(task.updatedAt).getTime() !== new Date(item.updatedAt).getTime()) {
                failed.push({ sourceType: item.sourceType, id: item.id, reason: '任务状态或版本已变化' });
            } else dismissed.push(task);
        }
        await saveTaskCenterDismissals(dismissed);
        const payload = { status: failed.length ? 'partial' : 'complete', dismissed: dismissed.map(task => ({ sourceType: task.sourceType, id: task.id })), failed, filesDeleted: false, cloudObjectsDeleted: false };
        return res.status(failed.length ? 207 : 200).json(payload);
    } catch (error) {
        return res.status(400).json({ error: '删除快照无效' });
    }
});

router.post('/:sourceType/:id/cancel-confirmation', requireAuth, async (req: Request, res: Response) => {
    const sourceType = String(req.params.sourceType);
    const id = String(req.params.id);
    if (!['ytdlp', 'telegram_bot', 'telegram_channel', 'web_upload'].includes(sourceType)) {
        return res.status(400).json({ error: '该任务类型暂不支持取消' });
    }
    const authToken = getAuthToken(req);
    if (!authToken) return res.status(401).json({ error: '未认证' });
    const objectId = `${sourceType}:${id}`;
    res.json({
        ...webDestructiveConfirmationStore.issue({ authToken, action: 'cancel_task', objectId }),
        impact: {
            sourceType,
            taskId: id,
            stopsOnlySelectedTask: true,
            removesReceivedChunks: sourceType === 'web_upload',
        },
    });
});

router.post('/:sourceType/:id/:action', requireAuth, async (req: Request, res: Response) => {
    const sourceType = String(req.params.sourceType);
    const id = String(req.params.id);
    const action = String(req.params.action);
    if (!['cancel', 'retry'].includes(action)) return res.status(400).json({ error: '不支持的任务操作' });
    if (action === 'cancel') {
        const authToken = getAuthToken(req);
        const confirmationToken = String(req.header('x-confirmation-token') || '');
        const confirmed = authToken && confirmationToken
            ? webDestructiveConfirmationStore.consume(confirmationToken, {
                authToken,
                action: 'cancel_task',
                objectId: `${sourceType}:${id}`,
            })
            : { status: 'missing' as const };
        if (confirmed.status !== 'ok') {
            return res.status(409).json({ error: '需要一次性任务取消确认令牌', code: 'CONFIRMATION_REQUIRED' });
        }
    }
    try {
        if (sourceType === 'ytdlp') {
            const task = action === 'cancel' ? await cancelYtDlpTask(id) : await retryYtDlpTask(id);
            if (!task) return res.status(409).json({ error: '任务当前不能执行该操作' });
            return res.json({ success: true, task });
        }
        if (sourceType === 'telegram_bot') {
            const task = await getTransferTask('telegram_bot', id);
            if (!task) return res.status(404).json({ error: '任务不存在' });
            if (action === 'cancel') {
                const cancelled = task.chatId && task.ownerUserId
                    ? cancelDownloadTaskGroup(id, task.chatId, task.ownerUserId)
                    : { status: 'not_found' as const };
                if (cancelled.status !== 'ok') {
                    return res.status(409).json({ error: `任务当前不能取消: ${cancelled.status}` });
                }
                await updateTransferTask('telegram_bot', id, { status: 'cancelled', stage: 'cancelled', finishedAt: new Date(), error: 'Web 管理员取消任务' });
                return res.json({ success: true });
            }
            if (!task.chatId || !task.ownerUserId || task.status === 'interrupted') {
                return res.status(409).json({ error: '该普通 Bot 任务无法在重启后自动重建，请在 Telegram 中重新发送原文件' });
            }
            const result = await retryFailedDownloadTasks(50, id, task.chatId, task.ownerUserId);
            return res.status(result.retried > 0 ? 200 : 409).json({ success: result.retried > 0, retried: result.retried, error: result.retried ? undefined : '没有可重试的失败文件' });
        }
        if (sourceType === 'telegram_channel') {
            const row = (await query('SELECT user_id, chat_id FROM telegram_background_jobs WHERE id = $1', [id])).rows[0];
            if (!row) return res.status(404).json({ error: '任务不存在' });
            if (action === 'cancel') {
                const task = await cancelTelegramBackgroundJob(Number(row.user_id), id, row.chat_id == null ? undefined : String(row.chat_id));
                if (task) cancelChannelExecutionGroup(id);
                return res.status(task ? 200 : 409).json({ success: Boolean(task), error: task ? undefined : '任务当前不能取消' });
            }
            const task = await retryTelegramBackgroundJob(Number(row.user_id), id, row.chat_id == null ? undefined : String(row.chat_id));
            return res.status(task ? 200 : 409).json({ success: Boolean(task), error: task ? undefined : '任务当前不能重试' });
        }
        if (sourceType === 'web_upload') {
            if (action === 'retry') return res.status(409).json({ error: 'FILE_RESELECT_REQUIRED', message: '请在文件页重新选择原文件后续传' });
            const result = await query(
                `UPDATE chunk_upload_sessions SET status = 'cancelled', last_error = 'Web 管理员取消任务', updated_at = NOW()
                 WHERE upload_id = $1 AND status IN ('open','failed') RETURNING upload_id`,
                [id],
            );
            if ((result.rowCount || 0) === 0) return res.status(409).json({ error: '上传正在完成或已结束，不能取消' });
            await fs.rm(path.join(CHUNK_DIR, id), { recursive: true, force: true });
            return res.json({ success: true });
        }
        return res.status(400).json({ error: '该任务类型暂不支持控制' });
    } catch (error) {
        console.error('统一任务操作失败:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : '任务操作失败' });
    }
});

export default router;
