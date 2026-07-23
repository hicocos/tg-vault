import { query } from '../db/index.js';
import type { DownloadTaskGroupSnapshot } from './downloadTaskQueue.js';
import { reconcileCommittedYtDlpWrites } from './ytDlpExecution.js';

export type TransferTaskSource = 'telegram_bot' | 'ytdlp';
export type TransferTaskStatus =
    | 'pending'
    | 'running'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'retry_required';

export interface TransferTaskRecord {
    sourceType: TransferTaskSource;
    id: string;
    kind: string;
    title: string;
    status: TransferTaskStatus;
    stage: string;
    progress: number;
    ownerUserId: number | null;
    chatId: string | null;
    source: string | null;
    targetProvider: string | null;
    targetAccountId: string | null;
    targetFolder: string | null;
    totalItems: number;
    completedItems: number;
    failedItems: number;
    totalBytes: number;
    transferredBytes: number;
    payload: Record<string, unknown>;
    error: string | null;
    retryable: boolean;
    cancelRequested: boolean;
    startedAt: Date | null;
    finishedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreateTransferTaskInput {
    sourceType: TransferTaskSource;
    id: string;
    kind: string;
    title: string;
    status?: TransferTaskStatus;
    stage?: string;
    progress?: number;
    ownerUserId?: number | null;
    chatId?: string | null;
    source?: string | null;
    targetProvider?: string | null;
    targetAccountId?: string | null;
    targetFolder?: string | null;
    totalItems?: number;
    completedItems?: number;
    failedItems?: number;
    totalBytes?: number;
    transferredBytes?: number;
    payload?: Record<string, unknown>;
    error?: string | null;
    retryable?: boolean;
    cancelRequested?: boolean;
    startedAt?: Date | null;
    finishedAt?: Date | null;
}

export type TransferTaskPatch = Partial<Omit<CreateTransferTaskInput, 'sourceType' | 'id' | 'kind' | 'title'>> & {
    kind?: string;
    title?: string;
};

function safePayload(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
}

function mapTask(row: any): TransferTaskRecord {
    return {
        sourceType: String(row.source_type) as TransferTaskSource,
        id: String(row.id),
        kind: String(row.kind),
        title: String(row.title),
        status: String(row.status) as TransferTaskStatus,
        stage: String(row.stage || 'waiting'),
        progress: Number(row.progress || 0),
        ownerUserId: row.owner_user_id == null ? null : Number(row.owner_user_id),
        chatId: row.chat_id == null ? null : String(row.chat_id),
        source: row.source == null ? null : String(row.source),
        targetProvider: row.target_provider == null ? null : String(row.target_provider),
        targetAccountId: row.target_account_id == null ? null : String(row.target_account_id),
        targetFolder: row.target_folder == null ? null : String(row.target_folder),
        totalItems: Number(row.total_items || 0),
        completedItems: Number(row.completed_items || 0),
        failedItems: Number(row.failed_items || 0),
        totalBytes: Number(row.total_bytes || 0),
        transferredBytes: Number(row.transferred_bytes || 0),
        payload: safePayload(row.payload),
        error: row.error == null ? null : String(row.error),
        retryable: Boolean(row.retryable),
        cancelRequested: Boolean(row.cancel_requested),
        startedAt: row.started_at ? new Date(row.started_at) : null,
        finishedAt: row.finished_at ? new Date(row.finished_at) : null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
    };
}

export async function createTransferTask(input: CreateTransferTaskInput): Promise<TransferTaskRecord> {
    const result = await query(
        `INSERT INTO transfer_tasks
         (source_type, id, kind, title, status, stage, progress, owner_user_id, chat_id, source,
          target_provider, target_account_id, target_folder, total_items, completed_items, failed_items,
          total_bytes, transferred_bytes, payload, error, retryable, cancel_requested, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24)
         ON CONFLICT (source_type, id) DO UPDATE SET
            kind = EXCLUDED.kind,
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            stage = EXCLUDED.stage,
            progress = EXCLUDED.progress,
            owner_user_id = EXCLUDED.owner_user_id,
            chat_id = EXCLUDED.chat_id,
            source = EXCLUDED.source,
            target_provider = EXCLUDED.target_provider,
            target_account_id = EXCLUDED.target_account_id,
            target_folder = EXCLUDED.target_folder,
            total_items = EXCLUDED.total_items,
            completed_items = EXCLUDED.completed_items,
            failed_items = EXCLUDED.failed_items,
            total_bytes = EXCLUDED.total_bytes,
            transferred_bytes = EXCLUDED.transferred_bytes,
            payload = transfer_tasks.payload || EXCLUDED.payload,
            error = EXCLUDED.error,
            retryable = EXCLUDED.retryable,
            cancel_requested = EXCLUDED.cancel_requested,
            started_at = COALESCE(transfer_tasks.started_at, EXCLUDED.started_at),
            finished_at = EXCLUDED.finished_at,
            updated_at = NOW()
         RETURNING *`,
        [
            input.sourceType,
            input.id,
            input.kind,
            input.title,
            input.status || 'pending',
            input.stage || 'waiting',
            Math.max(0, Math.min(100, input.progress || 0)),
            input.ownerUserId ?? null,
            input.chatId ?? null,
            input.source ?? null,
            input.targetProvider ?? null,
            input.targetAccountId ?? null,
            input.targetFolder ?? null,
            Math.max(0, input.totalItems || 0),
            Math.max(0, input.completedItems || 0),
            Math.max(0, input.failedItems || 0),
            Math.max(0, input.totalBytes || 0),
            Math.max(0, input.transferredBytes || 0),
            JSON.stringify(input.payload || {}),
            input.error ?? null,
            input.retryable || false,
            input.cancelRequested || false,
            input.startedAt ?? null,
            input.finishedAt ?? null,
        ],
    );
    return mapTask(result.rows[0]);
}

const PATCH_COLUMNS: Record<keyof TransferTaskPatch, string> = {
    kind: 'kind',
    title: 'title',
    status: 'status',
    stage: 'stage',
    progress: 'progress',
    ownerUserId: 'owner_user_id',
    chatId: 'chat_id',
    source: 'source',
    targetProvider: 'target_provider',
    targetAccountId: 'target_account_id',
    targetFolder: 'target_folder',
    totalItems: 'total_items',
    completedItems: 'completed_items',
    failedItems: 'failed_items',
    totalBytes: 'total_bytes',
    transferredBytes: 'transferred_bytes',
    payload: 'payload',
    error: 'error',
    retryable: 'retryable',
    cancelRequested: 'cancel_requested',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
};

export async function updateTransferTask(sourceType: TransferTaskSource, id: string, patch: TransferTaskPatch): Promise<TransferTaskRecord | null> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as Array<[keyof TransferTaskPatch, unknown]>;
    if (entries.length === 0) return getTransferTask(sourceType, id);
    const params: unknown[] = [sourceType, id];
    const assignments = entries.map(([key, value]) => {
        params.push(key === 'payload' ? JSON.stringify(value || {}) : value);
        const column = PATCH_COLUMNS[key];
        return key === 'payload'
            ? `${column} = ${column} || $${params.length}::jsonb`
            : `${column} = $${params.length}`;
    });
    const result = await query(
        `UPDATE transfer_tasks SET ${assignments.join(', ')}, updated_at = NOW()
         WHERE source_type = $1 AND id = $2 RETURNING *`,
        params,
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
}

export async function getTransferTask(sourceType: TransferTaskSource, id: string): Promise<TransferTaskRecord | null> {
    const result = await query('SELECT * FROM transfer_tasks WHERE source_type = $1 AND id = $2', [sourceType, id]);
    return result.rows[0] ? mapTask(result.rows[0]) : null;
}

export async function listTransferTasks(options: {
    sourceType?: TransferTaskSource;
    ownerUserId?: number;
    chatId?: string;
    limit?: number;
} = {}): Promise<TransferTaskRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.sourceType) {
        params.push(options.sourceType);
        conditions.push(`source_type = $${params.length}`);
    }
    if (options.ownerUserId !== undefined) {
        params.push(options.ownerUserId);
        conditions.push(`owner_user_id = $${params.length}`);
    }
    if (options.chatId !== undefined) {
        params.push(options.chatId);
        conditions.push(`chat_id = $${params.length}`);
    }
    params.push(Math.max(1, Math.min(500, options.limit || 200)));
    const result = await query(
        `SELECT * FROM transfer_tasks
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY updated_at DESC LIMIT $${params.length}`,
        params,
    );
    return result.rows.map(mapTask);
}

export async function markTransferTasksAfterRestart(): Promise<void> {
    await reconcileCommittedYtDlpWrites({ query });
    await query(
        `UPDATE transfer_tasks
         SET status = 'interrupted', stage = 'retry_required', retryable = true,
             error = '服务重启中断了普通 Bot 下载。请在 Telegram 中重新发送原文件后重试。',
             finished_at = NOW(), updated_at = NOW()
         WHERE source_type = 'telegram_bot' AND status IN ('pending','running','paused')`,
    );
    await query(
        `UPDATE transfer_tasks t
         SET status = CASE WHEN EXISTS (
                 SELECT 1 FROM ytdlp_write_reconciliations r WHERE r.task_id = t.id AND r.status = 'pending'
             ) THEN 'retry_required' ELSE 'pending' END,
             stage = CASE WHEN EXISTS (
                 SELECT 1 FROM ytdlp_write_reconciliations r WHERE r.task_id = t.id AND r.status = 'pending'
             ) THEN 'reconciliation_required' ELSE 'recovering' END,
             retryable = CASE WHEN EXISTS (
                 SELECT 1 FROM ytdlp_write_reconciliations r WHERE r.task_id = t.id AND r.status = 'pending'
             ) THEN false ELSE true END,
             error = CASE WHEN EXISTS (
                 SELECT 1 FROM ytdlp_write_reconciliations r WHERE r.task_id = t.id AND r.status = 'pending'
             ) THEN '上次外部写结果需要对账，已阻止自动重试' ELSE '服务重启后正在重新排队' END,
             cancel_requested = false, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE source_type = 'ytdlp' AND status = 'running'`,
    );
}

function ordinaryStatus(group: DownloadTaskGroupSnapshot): TransferTaskStatus {
    if (group.state === 'cancelled' || group.state === 'cancelling') return 'cancelled';
    if (group.state === 'completed') return group.failed > 0 ? 'failed' : 'completed';
    if (group.state === 'paused' || group.state === 'pausing') return 'paused';
    if (group.state === 'running') return 'running';
    return 'pending';
}

export async function persistOrdinaryTransferTask(group: DownloadTaskGroupSnapshot): Promise<void> {
    const status = ordinaryStatus(group);
    const finished = group.completed + group.failed + group.cancelled;
    const total = Math.max(group.total, finished);
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);
    await query(
        `INSERT INTO transfer_tasks
         (source_type, id, kind, title, status, stage, progress, owner_user_id, chat_id, source,
          target_provider, target_account_id, target_folder, total_items, completed_items, failed_items,
          payload, error, retryable, cancel_requested, started_at, finished_at, snapshot_version)
         VALUES ('telegram_bot',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (source_type, id) DO UPDATE SET
            kind=EXCLUDED.kind, title=EXCLUDED.title, status=EXCLUDED.status, stage=EXCLUDED.stage,
            progress=EXCLUDED.progress, owner_user_id=EXCLUDED.owner_user_id, chat_id=EXCLUDED.chat_id,
            source=EXCLUDED.source, target_provider=EXCLUDED.target_provider,
            target_account_id=EXCLUDED.target_account_id, target_folder=EXCLUDED.target_folder,
            total_items=EXCLUDED.total_items, completed_items=EXCLUDED.completed_items,
            failed_items=EXCLUDED.failed_items, payload=transfer_tasks.payload || EXCLUDED.payload,
            error=EXCLUDED.error, retryable=EXCLUDED.retryable, cancel_requested=EXCLUDED.cancel_requested,
            started_at=COALESCE(transfer_tasks.started_at, EXCLUDED.started_at), finished_at=EXCLUDED.finished_at,
            snapshot_version=EXCLUDED.snapshot_version, updated_at=NOW()
         WHERE EXCLUDED.snapshot_version > transfer_tasks.snapshot_version
           AND transfer_tasks.status NOT IN ('completed','failed','cancelled')`,
        [group.id, group.kind, group.title, status,
            status === 'running' ? 'downloading' : status === 'pending' ? 'waiting' : status,
            total > 0 ? Math.min(100, (finished / total) * 100) : 0,
            group.userId ?? null, group.chatId || null, group.source || null,
            group.targetProvider || null, group.targetAccountId ?? null, group.targetFolder || null,
            total, group.completed, group.failed,
            JSON.stringify({ groupId: group.id, active: group.active, pending: group.pending,
                cancelled: group.cancelled, currentFileName: group.currentFileName || null }),
            group.reason || (group.failed > 0 ? `${group.failed} 个文件处理失败` : null),
            status === 'failed', status === 'cancelled',
            status === 'running' ? new Date(group.updatedAt) : null,
            terminal ? new Date(group.updatedAt) : null, group.updatedAt],
    );
}
