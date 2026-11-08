import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, query } from '../db/index.js';
import { McpError, type McpContext, type McpTool } from './contracts.js';
import { admitTelegramArchive, wakeTelegramArchiveWorker, subscribeTelegramChannel } from '../services/telegramChannelJobs.js';
import { listSubscriptionRecipients, parseSubscriptionConfiguration } from '../services/telegramSubscriptionInput.js';
import { getTransferTask } from '../services/transferTasks.js';
import { mapTelegramChannelJob, mapTransferTask } from '../services/unifiedTaskMapper.js';
import { channelRuntimeView } from '../services/telegramChannelRuntimeView.js';
import { getChannelExecutionGroup, getDownloadTaskSnapshot } from '../services/telegramUpload.js';
import { getTelegramTaskFailures } from '../services/telegramTaskFailures.js';
import { controlStoredTask, getStoredTaskActionBlocks, TaskControlError, type StoredTaskSource } from '../services/taskControl.js';
import { parseTelegramDateRange } from '../services/telegramDateRange.js';
import { normalizeHashtag } from '../services/telegramHashtag.js';
import { TELEGRAM_BATCH_FILE_TYPES } from '../utils/telegramBatchMediaFilter.js';
import { sanitizeCustomStoragePath } from '../utils/telegramPathSettings.js';
import { getMcpUpload, controlMcpUpload } from './uploads.js';
import { telegramIngressLimit } from '../services/telegramIngressLimit.js';
import { getMcpFileBatch, controlMcpFileBatch } from './fileBatches.js';
import { lockStorageTargetForUse } from '../services/storageAccountLifecycle.js';
import { taskActionAvailability, taskActions } from './taskActions.js';

const page = { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(1_000_000).default(0) };
const controlledSources = ['telegram_channel', 'telegram_bot', 'qbittorrent', 'web_upload', 'mcp_upload', 'mcp_file_batch'] as const;
const sources = [...controlledSources, 'subscription'] as const;
type TaskSource = typeof sources[number];
const taskKey = { sourceType: z.enum(sources), taskId: z.string().min(1).max(128) };
const controlledTaskKey = { ...taskKey, sourceType: z.enum(controlledSources) };
const subscriptionKey = { subscriptionId: z.uuid() };
const subscriptionFields = {
    folder: z.string().max(255).nullable(),
    adFilterMode: z.enum(['off', 'conservative', 'aggressive']),
    fileFilterMode: z.enum(['all', 'include', 'exclude']),
    fileFilterTypes: z.array(z.enum(TELEGRAM_BATCH_FILE_TYPES)).max(TELEGRAM_BATCH_FILE_TYPES.length),
};
const subscriptionConfig = {
    folder: subscriptionFields.folder.default(null),
    adFilterMode: subscriptionFields.adFilterMode.default('off'),
    fileFilterMode: subscriptionFields.fileFilterMode.default('all'),
    fileFilterTypes: subscriptionFields.fileFilterTypes.default([]),
};
const expectedVersion = z.string().regex(/^[a-f0-9]{64}$/).optional()
    .describe('Optional version from subscriptions_get/list. Rejects a concurrent configuration change; background scan progress does not change this version.');
const notificationUser = z.string().regex(/^[1-9]\d*$/).refine(value => Number.isSafeInteger(Number(value)), 'Invalid Telegram user ID');
const taskScope = (context: McpContext) => [context.target.provider.name, context.target.accountId];
const subscriptionScope = "target_mode='fixed' AND target_provider=$1 AND target_account_id IS NOT DISTINCT FROM $2::uuid";
const missing = () => new McpError('NOT_FOUND', 'Object not found in the selected storage account.');

export function analyzeTaskFailure(error: unknown): { code: string; suggestedAction: string } | null {
    if (!error) return null;
    const text = String(error);
    if (/quota|upload.?limit|上传额度|容量|空间不足|ENOSPC/i.test(text)) return { code: 'STORAGE_CAPACITY', suggestedAction: 'Check the selected storage quota and wait until capacity is available.' };
    if (/flood.?wait|429|rate.?limit|限流/i.test(text)) return { code: 'RATE_LIMITED', suggestedAction: 'Wait for the provider cooldown to end.' };
    if (/unauthor|forbidden|access.?denied|private|403|401|权限|认证|授权/i.test(text)) return { code: 'ACCESS_DENIED', suggestedAction: 'Check source access and the selected storage account credentials in Settings.' };
    if (/not.?found|404|ENOENT|不存在|已删除/i.test(text)) return { code: 'SOURCE_NOT_FOUND', suggestedAction: 'Check whether the original source still exists.' };
    if (/timeout|timed.?out|ECONN|ETIMEDOUT|network|超时|网络/i.test(text)) return { code: 'NETWORK_FAILURE', suggestedAction: 'Check provider connectivity.' };
    if (/reconcil|补偿|写入.*确认/i.test(text)) return { code: 'RECONCILIATION_REQUIRED', suggestedAction: 'Wait for storage write reconciliation; do not create a duplicate transfer.' };
    if (/restart|重启|重新发送|重新选择/i.test(text)) return { code: 'SOURCE_REQUIRED', suggestedAction: 'Resend or reselect the original file to resume this transfer.' };
    return { code: 'TRANSFER_FAILED', suggestedAction: 'Inspect the selected task in the authenticated Web interface and resolve its reported cause.' };
}

function subscriptionConfiguration(row: Record<string, any>) {
    return { folder: row.folder_override, adFilterMode: row.ad_filter_mode,
        fileFilterMode: row.file_filter_mode, fileFilterTypes: row.file_filter_types };
}

function subscriptionVersion(row: Record<string, any>) {
    return createHash('sha256').update(JSON.stringify({ ...subscriptionConfiguration(row),
        enabled: row.enabled, provider: row.target_provider, accountId: row.target_account_id })).digest('hex');
}

function subscriptionView(row: Record<string, any>) {
    return {
        id: row.id, userId: String(row.user_id), source: row.source, title: row.title, enabled: row.enabled,
        storageAccountId: row.target_account_id || 'local', provider: row.target_provider, folder: row.folder_override,
        adFilterMode: row.ad_filter_mode, fileFilterMode: row.file_filter_mode, fileFilterTypes: row.file_filter_types,
        lastMessageId: row.last_message_id, lastScanAt: row.last_scan_at, lastSuccessAt: row.last_success_at,
        nextScanAt: row.next_scan_at, failure: analyzeTaskFailure(row.last_error),
        lastResult: row.last_result ? { status: row.last_result.status, found: row.last_result.found,
            skipped: row.last_result.skipped, failed: row.last_result.failed } : null,
        createdAt: row.created_at, updatedAt: row.updated_at, version: subscriptionVersion(row),
    };
}

async function getSubscription(context: McpContext, id: string) {
    const result = await query(`SELECT * FROM telegram_channel_subscriptions WHERE ${subscriptionScope} AND id=$3`, [...taskScope(context), id]);
    if (!result.rows[0]) throw missing();
    return result.rows[0];
}

async function withSubscription<T>(context: McpContext, id: string, operation: (client: PoolClient, row: Record<string, any>) => Promise<T>) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await lockStorageTargetForUse(client, context.target.provider.name, context.target.accountId);
        const row = await client.query(`SELECT * FROM telegram_channel_subscriptions WHERE ${subscriptionScope} AND id=$3 FOR UPDATE`, [...taskScope(context), id]);
        if (!row.rows[0]) throw missing();
        const result = await operation(client, row.rows[0]);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function assertSubscriptionVersion(row: Record<string, any>, expected?: string) {
    const actual = subscriptionVersion(row);
    if (expected !== undefined && expected !== actual) {
        throw new McpError('VERSION_CONFLICT', 'Subscription configuration changed. Read it again before retrying the update.', { currentVersion: actual });
    }
}

async function updateSubscription(context: McpContext, input: Record<string, any>, replace: boolean) {
    return withSubscription(context, input.subscriptionId, async (client, row) => {
        assertSubscriptionVersion(row, input.expectedVersion);
        const before = subscriptionView(row);
        const previous = subscriptionConfiguration(row);
        const supplied = Object.fromEntries(Object.keys(subscriptionFields)
            .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
        const next = configuration(context, replace ? supplied : { ...previous, ...supplied });
        const afterConfiguration = { folder: next.folderOverride, adFilterMode: next.adFilterMode,
            fileFilterMode: next.fileFilterMode, fileFilterTypes: next.fileFilterTypes };
        const changedFields = (Object.keys(previous) as Array<keyof typeof previous>)
            .filter(key => JSON.stringify(previous[key]) !== JSON.stringify(afterConfiguration[key]));
        if (!changedFields.length) return { changed: false, changedFields, before, after: before, subscription: before };
        const result = await client.query(`UPDATE telegram_channel_subscriptions
            SET folder_override=$2, ad_filter_mode=$3, file_filter_mode=$4, file_filter_types=$5::text[], updated_at=NOW()
            WHERE id=$1 RETURNING *`, [input.subscriptionId, next.folderOverride, next.adFilterMode, next.fileFilterMode, next.fileFilterTypes]);
        const after = subscriptionView(result.rows[0]);
        return { changed: true, changedFields, before, after, subscription: after };
    });
}

async function assertRecipient(userId: string) {
    if (!(await listSubscriptionRecipients()).some(row => row.userId === userId)) {
        throw new McpError('FORBIDDEN', 'The notification user must be authenticated in Telegram and present in the configured allowed-user list.');
    }
}

function admitTelegramRequest(userId: number, kind: 'message' | 'control', heavyCommand?: string): void {
    const result = telegramIngressLimit.consume(userId, kind, heavyCommand);
    if (result.limited) throw new McpError('RATE_LIMITED', 'Telegram request limit reached. Wait before submitting a new request.', { retryAfterSeconds: result.retryAfterSeconds });
}

function configuration(context: McpContext, input: Record<string, unknown>) {
    try {
        return parseSubscriptionConfiguration({ ...input, folderOverride: input.folder, targetMode: 'fixed',
            targetProvider: context.target.provider.name, targetAccountId: context.target.accountId });
    } catch {
        throw new McpError('INVALID_ARGUMENT', 'Invalid folder or file filter configuration; include/exclude mode requires at least one file type.');
    }
}

function validateTaskId(source: TaskSource, id: string) {
    if (source !== 'telegram_bot' && !z.uuid().safeParse(id).success) throw new McpError('INVALID_ARGUMENT', 'This task type requires a UUID taskId.');
}

async function scopedTaskView(context: McpContext, source: TaskSource, id: string): Promise<Record<string, any>> {
    validateTaskId(source, id);
    if (source === 'mcp_upload') return getMcpUpload(context, id);
    if (source === 'mcp_file_batch') return getMcpFileBatch(context, id);
    if (source === 'subscription') {
        const subscription = subscriptionView(await getSubscription(context, id));
        const jobs = await query(`SELECT id, status, created_at, updated_at FROM telegram_background_jobs
            WHERE params->>'subscriptionId'=$1 AND params->>'storageProvider'=$2
              AND params->>'storageAccountId' IS NOT DISTINCT FROM $3::text ORDER BY created_at DESC LIMIT 10`,
            [id, ...taskScope(context)]);
        return { id, sourceType: source, status: subscription.enabled ? 'scheduled' : 'disabled', subscription, recentJobs: jobs.rows };
    }
    if (source === 'telegram_channel') {
        const result = await query(`SELECT j.*, s.* FROM telegram_background_jobs j
            LEFT JOIN LATERAL (SELECT COUNT(*)::int AS item_count,
                COUNT(*) FILTER(WHERE status='success')::int AS completed_items,
                COUNT(*) FILTER(WHERE status='failed')::int AS failed_items,
                COUNT(*) FILTER(WHERE status='skipped')::int AS skipped_count_items,
                COUNT(*) FILTER(WHERE status='pending')::int AS pending_count,
                COUNT(*) FILTER(WHERE status='downloading')::int AS downloading_count,
                COALESCE(SUM(total_size),0)::text AS total_bytes,
                COALESCE(SUM(total_size) FILTER(WHERE status='success'),0)::text AS completed_bytes,
                COUNT(*) FILTER(WHERE COALESCE(total_size,0)<=0)::int AS unknown_size_count,
                COUNT(*) FILTER(WHERE status='success' AND COALESCE(total_size,0)<=0)::int AS completed_unknown_size_count
                FROM telegram_download_items WHERE job_id=j.id AND status<>'excluded') s ON true
            WHERE j.id=$3 AND j.params->>'storageProvider'=$1
              AND j.params->>'storageAccountId' IS NOT DISTINCT FROM $2::text`, [...taskScope(context), id]);
        if (!result.rows[0]) throw missing();
        const task = mapTelegramChannelJob(channelRuntimeView(result.rows[0], getChannelExecutionGroup(id)), new Map());
        const { error, ...view } = task;
        return { ...view, failure: analyzeTaskFailure(error), cooldownUntil: result.rows[0].cooldown_until };
    }
    if (source === 'web_upload') {
        const result = await query(`SELECT upload_id, filename, status, total_size, received_bytes, expires_at, updated_at, created_at, last_error
            FROM chunk_upload_sessions WHERE target_provider=$1 AND target_account_id IS NOT DISTINCT FROM $2::uuid AND upload_id=$3`, [...taskScope(context), id]);
        const row = result.rows[0];
        if (!row) throw missing();
        return { id, sourceType: source, title: row.filename, status: row.status,
            totalBytes: Number(row.total_size), receivedBytes: Number(row.received_bytes),
            progress: Number(row.total_size) > 0 ? Math.round(Number(row.received_bytes) / Number(row.total_size) * 100) : 0,
            expiresAt: row.expires_at, updatedAt: row.updated_at, createdAt: row.created_at, failure: analyzeTaskFailure(row.last_error) };
    }
    const record = await getTransferTask(source, id);
    if (!record || record.targetProvider !== context.target.provider.name || record.targetAccountId !== context.target.accountId) throw missing();
    const { error, detail, ...task } = mapTransferTask(record, new Map(), source === 'telegram_bot' ? getDownloadTaskSnapshot(id) : undefined);
    const stopped = ['completed', 'cancelled', 'failed', 'interrupted', 'retry_required'].includes(task.status);
    return { ...task, detail: { currentFileName: stopped ? null : detail.currentFileName,
        active: stopped ? 0 : detail.active, pending: stopped ? 0 : detail.pending,
        downloadProgress: detail.downloadProgress, downloadSpeed: stopped ? 0 : detail.downloadSpeed, downloadedBytes: detail.downloadedBytes,
        uploadSpeed: stopped ? 0 : detail.uploadSpeed, preserveLocalFiles: detail.preserveLocalFiles }, failure: analyzeTaskFailure(error) };
}

export async function getScopedMcpTask(context: McpContext, source: TaskSource, id: string): Promise<Record<string, any>> {
    const task = await scopedTaskView(context, source, id);
    if (source === 'mcp_upload' || source === 'mcp_file_batch') return task;
    if (source === 'subscription') return { ...task, ...taskActionAvailability(context,
        Object.fromEntries(taskActions.map(action => [action, 'USE_SUBSCRIPTION_TOOLS']))) };
    try {
        const availability = taskActionAvailability(context, await getStoredTaskActionBlocks(source, id, context.target));
        const canRetry = availability.allowedActions.includes('retry');
        const failure = ['cancelled', 'paused', 'pausing'].includes(task.status) ? null : task.failure ? { ...task.failure,
            suggestedAction: task.failure.suggestedAction + (canRetry
                ? ' Once resolved, use tasks_retry for this task.'
                : availability.blockedActions.retry === 'FILE_RESELECT_REQUIRED' && task.failure.code !== 'SOURCE_REQUIRED'
                    ? ' Resend or reselect the original file to start a new transfer.' : '') } : null;
        return { ...task, failure, ...availability,
            ...('retryable' in task ? { retryable: canRetry, cancellable: availability.allowedActions.includes('cancel') } : {}) };
    } catch (error) {
        if (error instanceof TaskControlError) throw new McpError(error.code, error.message);
        throw error;
    }
}

async function listTasks(context: McpContext, input: { sourceType?: TaskSource; status?: string; limit: number; offset: number }) {
    const result = await query(`WITH scoped AS (
        SELECT source_type::text AS source_type, id::text, status::text, updated_at FROM transfer_tasks
          WHERE target_provider=$1 AND target_account_id IS NOT DISTINCT FROM $2::uuid
        UNION ALL
        SELECT 'telegram_channel', id::text, CASE status WHEN 'queued' THEN 'pending' WHEN 'cooling' THEN 'waiting' WHEN 'completed_with_errors' THEN 'failed' ELSE status END, updated_at
          FROM telegram_background_jobs WHERE params->>'storageProvider'=$1 AND params->>'storageAccountId' IS NOT DISTINCT FROM $2::text
        UNION ALL
        SELECT 'web_upload', upload_id::text, status, updated_at FROM chunk_upload_sessions
          WHERE target_provider=$1 AND target_account_id IS NOT DISTINCT FROM $2::uuid
        UNION ALL
        SELECT 'subscription', id::text, CASE WHEN enabled THEN 'scheduled' ELSE 'disabled' END, updated_at
          FROM telegram_channel_subscriptions WHERE ${subscriptionScope}
        UNION ALL
        SELECT 'mcp_upload', id::text, status, updated_at FROM mcp_uploads WHERE client_id=$3 AND storage_id=$4
        UNION ALL
        SELECT 'mcp_file_batch', id::text, status, updated_at FROM mcp_file_batches WHERE client_id=$3 AND storage_id=$4
    ), filtered AS (SELECT * FROM scoped WHERE ($5::text IS NULL OR source_type=$5) AND ($6::text IS NULL OR status=$6)),
    page AS (SELECT * FROM filtered ORDER BY updated_at DESC, source_type, id LIMIT $7 OFFSET $8)
    SELECT (SELECT COUNT(*)::int FROM filtered) AS total,
      COALESCE((SELECT json_agg(page ORDER BY updated_at DESC, source_type, id) FROM page), '[]'::json) AS items`,
    [...taskScope(context), context.client.id, context.storageId, input.sourceType || null, input.status || null, input.limit, input.offset]);
    const { total, items } = result.rows[0];
    const tasks: Record<string, unknown>[] = [];
    for (const item of items) {
        try { tasks.push(await getScopedMcpTask(context, item.source_type, item.id)); }
        catch (error) {
            if (error instanceof McpError && error.code === 'NOT_FOUND') continue;
            throw error;
        }
    }
    return { tasks, total, offset: input.offset, limit: input.limit, nextOffset: input.offset + items.length < total ? input.offset + items.length : null };
}

function archivePreview(input: Record<string, any>) {
    let folder: string | null;
    try { folder = input.folder ? sanitizeCustomStoragePath(input.folder) : null; }
    catch { throw new McpError('INVALID_ARGUMENT', 'Invalid archive destination folder.'); }
    if (input.mode === 'date') {
        if (!input.startDate || !input.endDate || input.tag) throw new McpError('INVALID_ARGUMENT', 'Date mode requires startDate and endDate and does not accept tag.');
        try {
            const range = parseTelegramDateRange(input.startDate, input.endDate);
            return { source: input.source, mode: input.mode, startDate: input.startDate, endDate: input.endDate,
                dayCount: range.dayCount, largeRange: range.requiresLargeRangeConfirmation, timezone: 'UTC', folder,
                fileTypes: input.fileTypes, includeComments: input.includeComments };
        } catch { throw new McpError('INVALID_ARGUMENT', 'Provide valid inclusive UTC dates in YYYY-MM-DD order.'); }
    }
    if (!input.tag || input.startDate || input.endDate) throw new McpError('INVALID_ARGUMENT', 'Tag mode requires tag and does not accept date bounds.');
    let tag: string;
    try { tag = normalizeHashtag(input.tag); }
    catch { throw new McpError('INVALID_ARGUMENT', 'Provide a valid Telegram hashtag.'); }
    return { source: input.source, mode: input.mode, tag, folder, fileTypes: input.fileTypes,
        includeComments: input.includeComments, scansEntireHistory: true };
}

export const jobTools: McpTool[] = [
    { name: 'tasks_list', description: 'List tasks in exactly one storage account, newest first. Includes Telegram archives/Bot, qBittorrent, Web/MCP uploads and fixed subscriptions. Pagination uses limit/offset. Each task includes allowedActions/blockedActions for current local controller state and client permissions; execution revalidates state and provider availability.',
        permission: 'tasks:read', inputSchema: { ...page, sourceType: z.enum(sources).optional(), status: z.string().max(40).optional() }, run: listTasks },
    { name: 'tasks_get', description: 'Get progress, safe failure classification and allowedActions/blockedActions for current local controller state and client permissions. Execution revalidates state and provider availability. Subscription tasks include recent child download job IDs and use subscription-specific controls.',
        permission: 'tasks:read', inputSchema: taskKey, run: async (context, input) => ({ task: await getScopedMcpTask(context, input.sourceType, input.taskId) }) },
    { name: 'tasks_failures', description: 'Explain failures without exposing provider credentials or raw logs. Telegram archive failures are paginated with per-file retry attempts and public message links.',
        permission: 'tasks:read', inputSchema: { ...taskKey, ...page }, run: async (context, input) => {
            const task = await getScopedMcpTask(context, input.sourceType, input.taskId);
            if (input.sourceType !== 'telegram_channel') return { taskId: input.taskId, failure: task.failure || (task.errorCode ? { code: task.errorCode } : null), items: [], nextOffset: null };
            const failures = await getTelegramTaskFailures(input.taskId, input, query);
            if (!failures) throw missing();
            return { ...failures, items: failures.items.map(({ error, ...item }) => ({ ...item, failure: analyzeTaskFailure(error) })),
                nextOffset: failures.offset + failures.items.length < failures.total ? failures.offset + failures.items.length : null };
        } },
    ...(['pause', 'resume', 'retry', 'cancel'] as const).map(action => ({
        name: `tasks_${action}`, description: `${action} one task. Current state and source restrictions apply; interrupted uploads may require the original file. Cancellation requires a dryRun confirmation first.`,
        permission: 'tasks:control' as const, inputSchema: controlledTaskKey, mutation: true, destructive: action === 'cancel',
        preview: async (context: McpContext, input: any) => {
            const task = await getScopedMcpTask(context, input.sourceType, input.taskId);
            if (task.blockedActions[action]) throw new McpError(task.blockedActions[action], 'This task cannot currently perform the requested action.');
            return { taskId: input.taskId, sourceType: input.sourceType, action, title: task.title,
                removesReceivedChunks: input.sourceType === 'web_upload' || input.sourceType === 'mcp_upload' };
        },
        run: async (context: McpContext, input: any) => {
            const task = await getScopedMcpTask(context, input.sourceType, input.taskId);
            if (task.blockedActions[action]) throw new McpError(task.blockedActions[action], 'This task cannot currently perform the requested action.');
            if (input.sourceType === 'telegram_channel' || input.sourceType === 'telegram_bot') admitTelegramRequest(Number(task.ownerUserId), 'control');
            let result: Record<string, unknown>;
            if (input.sourceType === 'mcp_upload') result = await controlMcpUpload(context, input.taskId, action);
            else if (input.sourceType === 'mcp_file_batch') result = await controlMcpFileBatch(context, input.taskId, action);
            else {
                try { result = await controlStoredTask(input.sourceType as StoredTaskSource, input.taskId, action, context.target); }
                catch (error) { if (error instanceof TaskControlError) throw new McpError(error.code, error.message); throw error; }
            }
            const current = await getScopedMcpTask(context, input.sourceType, input.taskId);
            const before = { status: task.status, stage: task.stage ?? task.status };
            const after = { status: current.status, stage: current.stage ?? current.status };
            return { ...result, status: current.status,
                requestedState: action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'running',
                changed: before.status !== after.status || before.stage !== after.stage || Number(result.retried) > 0,
                before, after, task: current };
        },
    })),
    { name: 'telegram_recipients', description: 'List existing authenticated Telegram notification recipients allowed by the instance. Use a returned userId when creating subscriptions or archives.',
        permission: 'subscriptions:read', inputSchema: {}, run: async () => ({ recipients: await listSubscriptionRecipients() }) },
    { name: 'subscriptions_list', description: 'List fixed-target subscriptions for the explicitly selected storage account. Follow-global subscriptions are not exposed to MCP.',
        permission: 'subscriptions:read', inputSchema: page, run: async (context, input) => {
            const result = await query(`SELECT *, COUNT(*) OVER()::int AS total FROM telegram_channel_subscriptions WHERE ${subscriptionScope}
                ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`, [...taskScope(context), input.limit, input.offset]);
            const total = result.rows[0]?.total ?? Number((await query(`SELECT COUNT(*)::int AS total FROM telegram_channel_subscriptions WHERE ${subscriptionScope}`, taskScope(context))).rows[0].total);
            return { subscriptions: result.rows.map(subscriptionView), total, offset: input.offset,
                nextOffset: input.offset + result.rows.length < total ? input.offset + result.rows.length : null };
        } },
    { name: 'subscriptions_get', description: 'Get fixed subscription configuration, synchronization state and recent child download jobs.', permission: 'subscriptions:read',
        inputSchema: subscriptionKey, run: async (context, input) => getScopedMcpTask(context, 'subscription', input.subscriptionId) },
    { name: 'subscriptions_create', description: 'Create or restore a Telegram subscription with a fixed destination. Existing same-owner/source subscriptions in another storage scope cannot be overwritten. Telegram source access and allowed recipients are enforced.',
        permission: 'subscriptions:write', mutation: true, inputSchema: { ...subscriptionConfig, source: z.string().trim().min(1).max(500), userId: notificationUser },
        run: async (context, input) => {
            await assertRecipient(input.userId);
            admitTelegramRequest(Number(input.userId), 'message');
            const config = configuration(context, input);
            const subscription = await subscribeTelegramChannel(Number(input.userId), input.userId, input.source, config.folderOverride, undefined, config, context.target);
            if (!subscription) throw new McpError('CONFLICT', 'A subscription for this recipient and source already exists outside the selected storage account.');
            return { subscription: subscriptionView(subscription) };
        } },
    { name: 'subscriptions_update', description: 'Partially update a fixed subscription. Omitted fields stay unchanged; folder=null explicitly selects the root. Filters are validated after merging with current configuration. Returns changedFields, before/after and version. Supply expectedVersion to reject concurrent configuration edits.',
        permission: 'subscriptions:write', mutation: true, inputSchema: { ...subscriptionKey, ...z.object(subscriptionFields).partial().shape, expectedVersion },
        run: (context, input) => updateSubscription(context, input, false) },
    { name: 'subscriptions_replace', description: 'Replace all folder and filtering configuration for a fixed subscription. Omitted fields reset to folder=null, adFilterMode=off, fileFilterMode=all and fileFilterTypes=[]. Prefer subscriptions_update for a partial edit. Owner, source and storage destination remain unchanged.',
        permission: 'subscriptions:write', mutation: true, inputSchema: { ...subscriptionKey, ...subscriptionConfig, expectedVersion },
        run: (context, input) => updateSubscription(context, input, true) },
    { name: 'subscriptions_set_enabled', description: 'Enable or pause the selected fixed subscription. Existing download jobs are controlled separately.', permission: 'subscriptions:write', mutation: true,
        inputSchema: { ...subscriptionKey, enabled: z.boolean(), expectedVersion }, run: (context, input) => withSubscription(context, input.subscriptionId, async (client, row) => {
            assertSubscriptionVersion(row, input.expectedVersion);
            const before = subscriptionView(row);
            if (row.enabled === input.enabled) return { changed: false, changedFields: [], before, after: before, subscription: before };
            const result = await client.query(`UPDATE telegram_channel_subscriptions SET enabled=$2,
                disabled_reason=CASE WHEN $2 THEN NULL ELSE 'Paused by MCP client' END,
                disabled_at=CASE WHEN $2 THEN NULL ELSE NOW() END, updated_at=NOW()
                WHERE id=$1 RETURNING *`, [input.subscriptionId, input.enabled]);
            const after = subscriptionView(result.rows[0]);
            return { changed: true, changedFields: ['enabled'], before, after, subscription: after };
        }) },
    { name: 'subscriptions_sync', description: 'Schedule an immediate scan through the existing subscription worker and enable the subscription. Returns its standing task ID; poll tasks_get with sourceType=subscription for lastScanAt, lastResult and child download job IDs.',
        permission: 'subscriptions:write', mutation: true, inputSchema: subscriptionKey, run: (context, input) => withSubscription(context, input.subscriptionId, async (client, subscription) => {
            admitTelegramRequest(Number(subscription.user_id), 'control');
            const result = await client.query(`UPDATE telegram_channel_subscriptions SET next_scan_at=NOW(), enabled=true,
                disabled_reason=NULL, disabled_at=NULL, updated_at=NOW() WHERE id=$1 RETURNING id, enabled, next_scan_at`, [input.subscriptionId]);
            return { taskId: input.subscriptionId, sourceType: 'subscription', status: 'scheduled', requestedAt: result.rows[0].next_scan_at,
                changed: true, changedFields: ['nextScanAt', ...(!subscription.enabled ? ['enabled'] : [])],
                before: { enabled: subscription.enabled, nextScanAt: subscription.next_scan_at },
                after: { enabled: result.rows[0].enabled, nextScanAt: result.rows[0].next_scan_at } };
        }) },
    { name: 'subscriptions_delete', description: 'Permanently delete a fixed subscription and its cascading rules/decisions. Existing files and download jobs remain. Requires dryRun preview and confirmation.',
        permission: 'subscriptions:delete', mutation: true, destructive: true, inputSchema: subscriptionKey,
        preview: async (context, input) => {
            const row = await getSubscription(context, input.subscriptionId);
            return { subscriptionId: row.id, source: row.source, deletesRulesAndDecisions: true, deletesFiles: false };
        }, run: async (context, input) => {
            const result = await query(`DELETE FROM telegram_channel_subscriptions WHERE ${subscriptionScope} AND id=$3 RETURNING id`, [...taskScope(context), input.subscriptionId]);
            if (!result.rowCount) throw missing();
            return { deleted: true, changed: true, subscriptionId: input.subscriptionId, after: null };
        } },
    { name: 'subscription_rules_list', description: 'List allow/block filtering rules for one fixed subscription with pagination.', permission: 'subscriptions:read', inputSchema: { ...subscriptionKey, ...page },
        run: async (context, input) => withSubscription(context, input.subscriptionId, async client => {
            const result = await client.query(`SELECT id, kind, action, pattern, label, enabled, created_at, updated_at FROM telegram_subscription_ad_rules
                WHERE subscription_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`, [input.subscriptionId, input.limit + 1, input.offset]);
            return { rules: result.rows.slice(0, input.limit), nextOffset: result.rows.length > input.limit ? input.offset + input.limit : null };
        }) },
    { name: 'subscription_rules_save', description: 'Create a rule or update a rule by ruleId. Supports keyword/domain/username/template/media rules with allow/block actions. Applies only to the selected fixed subscription.',
        permission: 'subscriptions:write', mutation: true, inputSchema: { ...subscriptionKey, ruleId: z.uuid().optional(),
            kind: z.enum(['keyword', 'domain', 'username', 'template', 'media']), action: z.enum(['allow', 'block']),
            pattern: z.string().trim().min(1).max(2000), label: z.string().trim().max(200).default(''), enabled: z.boolean().default(true) },
        run: async (context, input) => withSubscription(context, input.subscriptionId, async client => {
            const values = [input.subscriptionId, input.kind, input.action, input.pattern, input.label || null, input.enabled];
            const result = input.ruleId ? await client.query(`UPDATE telegram_subscription_ad_rules SET kind=$2, action=$3, pattern=$4, label=$5, enabled=$6, updated_at=NOW()
                WHERE subscription_id=$1 AND id=$7 RETURNING id, kind, action, pattern, label, enabled`, [...values, input.ruleId])
                : await client.query(`INSERT INTO telegram_subscription_ad_rules(subscription_id,kind,action,pattern,label,enabled)
                    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(subscription_id,kind,action,pattern)
                    DO UPDATE SET label=EXCLUDED.label, enabled=EXCLUDED.enabled, updated_at=NOW() RETURNING id,kind,action,pattern,label,enabled`, values);
            if (!result.rows[0]) throw missing();
            return { rule: result.rows[0] };
        }) },
    { name: 'subscription_rules_delete', description: 'Delete one filtering rule from a fixed subscription. Requires dryRun preview and confirmation.', permission: 'subscriptions:delete', mutation: true, destructive: true,
        inputSchema: { ...subscriptionKey, ruleId: z.uuid() },
        preview: async (context, input) => withSubscription(context, input.subscriptionId, async client => {
            const result = await client.query('SELECT id,kind,action,pattern FROM telegram_subscription_ad_rules WHERE subscription_id=$1 AND id=$2', [input.subscriptionId, input.ruleId]);
            if (!result.rows[0]) throw missing();
            return { subscriptionId: input.subscriptionId, rule: result.rows[0] };
        }),
        run: async (context, input) => withSubscription(context, input.subscriptionId, async client => {
            const result = await client.query('DELETE FROM telegram_subscription_ad_rules WHERE subscription_id=$1 AND id=$2 RETURNING id', [input.subscriptionId, input.ruleId]);
            if (!result.rowCount) throw missing();
            return { deleted: true, changed: true, ruleId: input.ruleId, after: null };
        }) },
    { name: 'archive_start', description: 'Queue a Telegram historical archive by inclusive UTC date range OR hashtag, with explicit file categories and fixed storage. Always preview with dryRun and confirm, including ranges over 31 days or full-history tag scans. Returns a durable Telegram task ID immediately after admission; the existing recovery worker scans/downloads and resumes checkpoints after restart.',
        permission: 'archive:write', mutation: true, destructive: true, inputSchema: {
            source: z.string().trim().min(1).max(500), userId: notificationUser, mode: z.enum(['date', 'tag']),
            startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            tag: z.string().trim().min(1).max(100).optional(), folder: z.string().max(255).nullable().default(null),
            fileTypes: z.array(z.enum(TELEGRAM_BATCH_FILE_TYPES)).min(1).max(TELEGRAM_BATCH_FILE_TYPES.length),
            includeComments: z.boolean().default(false),
        },
        preview: async (_context, input) => archivePreview(input),
        recover: async context => {
            const result = await query(`SELECT id, source, status FROM telegram_background_jobs
                WHERE params->>'mcpClientId'=$1 AND params->>'mcpRequestId'=$2
                  AND params->>'storageProvider'=$3 AND params->>'storageAccountId' IS NOT DISTINCT FROM $4::text`,
                [context.client.id, context.requestId, ...taskScope(context)]);
            const row = result.rows[0];
            return row ? { taskId: row.id, sourceType: 'telegram_channel', status: row.status, source: row.source } : null;
        },
        run: async (context, input) => {
            archivePreview(input);
            await assertRecipient(input.userId);
            admitTelegramRequest(Number(input.userId), 'message', input.mode === 'date' ? '/tg_date' : '/tg_tag');
            const result = await admitTelegramArchive({ userId: Number(input.userId), chatId: input.userId,
                source: input.source, mode: input.mode, startDate: input.startDate, endDate: input.endDate, tag: input.tag,
                folderOverride: input.folder ? sanitizeCustomStoragePath(input.folder) : null, target: context.target,
                options: { includeComments: input.includeComments }, requestedFileTypes: [...new Set(input.fileTypes)] as typeof input.fileTypes,
                largeRangeConfirmed: true, mcpRequest: { clientId: context.client.id, requestId: context.requestId! } });
            wakeTelegramArchiveWorker();
            return { taskId: result.jobId, sourceType: 'telegram_channel', status: 'queued', source: result.source };
        } },
];
