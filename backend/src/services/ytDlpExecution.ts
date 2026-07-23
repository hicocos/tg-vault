export interface Queryable {
    query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface YtDlpExecutionClaim {
    generation: number;
    leaseToken: string;
}

const LEASE_SQL = "NOW() + INTERVAL '2 minutes'";

export async function claimYtDlpExecution(db: Queryable, id: string, leaseToken: string): Promise<YtDlpExecutionClaim | null> {
    const result = await db.query(
        `UPDATE transfer_tasks
         SET status = 'running', stage = 'downloading', progress = 0, error = NULL,
             retryable = false, cancel_requested = false, started_at = NOW(), finished_at = NULL,
             execution_generation = execution_generation + 1,
             lease_token = $2::uuid, lease_expires_at = ${LEASE_SQL}, updated_at = NOW()
         WHERE source_type = 'ytdlp' AND id = $1
           AND status IN ('pending', 'failed', 'interrupted', 'retry_required')
           AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
           AND NOT EXISTS (
               SELECT 1 FROM ytdlp_write_reconciliations r
               WHERE r.task_id = transfer_tasks.id AND r.status = 'pending'
           )
         RETURNING execution_generation, lease_token`,
        [id, leaseToken],
    );
    const row = result.rows[0];
    return row ? { generation: Number(row.execution_generation), leaseToken: String(row.lease_token) } : null;
}

export async function renewYtDlpExecution(db: Queryable, id: string, generation: number, leaseToken: string): Promise<boolean> {
    const result = await db.query(
        `UPDATE transfer_tasks SET lease_expires_at = ${LEASE_SQL}, updated_at = NOW()
         WHERE source_type = 'ytdlp' AND id = $1 AND status = 'running'
           AND execution_generation = $2 AND lease_token = $3::uuid AND cancel_requested = false`,
        [id, generation, leaseToken],
    );
    return result.rowCount === 1;
}

export async function updateYtDlpExecutionProgress(
    db: Queryable,
    id: string,
    generation: number,
    leaseToken: string,
    patch: { stage?: string; progress?: number; totalBytes?: number; payload?: Record<string, unknown> },
): Promise<boolean> {
    const result = await db.query(
        `UPDATE transfer_tasks
         SET stage = COALESCE($5, stage), progress = COALESCE($6, progress),
             total_bytes = COALESCE($7, total_bytes), payload = payload || COALESCE($8::jsonb, '{}'::jsonb),
             lease_expires_at = ${LEASE_SQL}, updated_at = NOW()
         WHERE source_type = $1 AND id = $2 AND status = 'running'
           AND execution_generation = $3 AND lease_token = $4::uuid AND cancel_requested = false`,
        ['ytdlp', id, generation, leaseToken, patch.stage ?? null, patch.progress ?? null, patch.totalBytes ?? null,
            patch.payload ? JSON.stringify(patch.payload) : null],
    );
    return result.rowCount === 1;
}

export async function settleYtDlpExecution(db: Queryable, input: {
    id: string;
    generation: number;
    leaseToken: string;
    status: 'completed' | 'failed';
    stage: string;
    progress?: number;
    error?: string | null;
    retryable?: boolean;
    completedItems?: number;
    failedItems?: number;
    transferredBytes?: number;
    payload?: Record<string, unknown>;
    operationId?: string;
}): Promise<boolean> {
    const result = await db.query(
        `WITH settled AS (
             UPDATE transfer_tasks
             SET status = $5, stage = $6, progress = COALESCE($7, progress), error = $8,
                 retryable = $9, completed_items = COALESCE($10, completed_items),
                 failed_items = COALESCE($11, failed_items), transferred_bytes = COALESCE($12, transferred_bytes),
                 payload = payload || COALESCE($13::jsonb, '{}'::jsonb), finished_at = NOW(),
                 lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
             WHERE source_type = $1 AND id = $2 AND status = 'running'
               AND execution_generation = $3 AND lease_token = $4::uuid AND cancel_requested = false
               AND ($14::uuid IS NULL OR EXISTS (
                   SELECT 1 FROM ytdlp_write_reconciliations r
                   WHERE r.operation_id = $14::uuid AND r.task_id = $2
                     AND r.execution_generation = $3 AND r.task_lease_token = $4::uuid
                     AND r.status = 'pending' AND r.object_state = 'present' AND r.index_state = 'present'
               ))
             RETURNING id
         ), resolved AS (
             UPDATE ytdlp_write_reconciliations r
             SET status = 'resolved', resolution = 'committed', reason = 'yt-dlp 任务与外部写已提交',
                 resolved_at = NOW(), updated_at = NOW()
             FROM settled s
             WHERE $14::uuid IS NOT NULL AND r.operation_id = $14::uuid AND r.status = 'pending'
             RETURNING r.operation_id
         )
         SELECT id FROM settled`,
        ['ytdlp', input.id, input.generation, input.leaseToken, input.status, input.stage,
            input.progress ?? null, input.error ?? null, input.retryable ?? false,
            input.completedItems ?? null, input.failedItems ?? null, input.transferredBytes ?? null,
            input.payload ? JSON.stringify(input.payload) : null, input.operationId ?? null],
    );
    return result.rows.length === 1 || result.rowCount === 1;
}

export async function cancelYtDlpExecution(db: Queryable, id: string): Promise<boolean> {
    const result = await db.query(
        `UPDATE transfer_tasks
         SET status = 'cancelled', stage = 'cancelled', cancel_requested = true, retryable = true,
             error = '用户取消任务', finished_at = NOW(), lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE source_type = 'ytdlp' AND id = $1 AND status IN ('pending','running','paused','failed','interrupted','retry_required')
         RETURNING id`, [id],
    );
    return result.rowCount === 1;
}

export async function retryYtDlpExecution(db: Queryable, id: string): Promise<boolean> {
    const result = await db.query(
        `UPDATE transfer_tasks
         SET status = 'pending', stage = 'waiting', progress = 0, completed_items = 0, failed_items = 0,
             transferred_bytes = 0, error = NULL, retryable = false, cancel_requested = false,
             started_at = NULL, finished_at = NULL, lease_token = NULL, lease_expires_at = NULL,
             payload = payload - 'speed' - 'eta' - 'finalPath', updated_at = NOW()
         WHERE source_type = 'ytdlp' AND id = $1
           AND status IN ('failed','interrupted','retry_required','cancelled') AND retryable = true
           AND NOT EXISTS (
               SELECT 1 FROM ytdlp_write_reconciliations r
               WHERE r.task_id = transfer_tasks.id AND r.status = 'pending'
           )
         RETURNING id`, [id],
    );
    return result.rowCount === 1;
}

export async function beginYtDlpWrite(db: Queryable, input: {
    operationId: string;
    taskId: string;
    generation: number;
    leaseToken: string;
    provider: string;
    accountId: string | null;
}): Promise<string> {
    const result = await db.query(
        `INSERT INTO ytdlp_write_reconciliations
         (operation_id, task_id, execution_generation, task_lease_token, provider, account_id,
          object_state, index_state, status, reason, created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,$6,'unknown','unknown','pending','yt-dlp 外部写进行中',NOW(),NOW()
         WHERE EXISTS (
             SELECT 1 FROM transfer_tasks
             WHERE source_type = 'ytdlp' AND id = $2 AND status = 'running'
               AND execution_generation = $3 AND lease_token = $4::uuid AND cancel_requested = false
         )
         RETURNING operation_id`,
        [input.operationId, input.taskId, input.generation, input.leaseToken, input.provider, input.accountId],
    );
    if (result.rowCount !== 1) throw new Error('yt-dlp write journal 创建失败或执行 lease 已丢失');
    return String(result.rows[0].operation_id);
}

export async function markYtDlpObjectPresent(db: Queryable, operationId: string, storedPath: string): Promise<void> {
    const result = await db.query(
        `UPDATE ytdlp_write_reconciliations SET stored_path = $2, object_state = 'present', updated_at = NOW()
         WHERE operation_id = $1 AND status = 'pending' RETURNING operation_id`, [operationId, storedPath],
    );
    if (result.rowCount !== 1) throw new Error('yt-dlp write journal 对象状态更新失败');
}

export async function markYtDlpIndexPresent(db: Queryable, operationId: string, fileId: string): Promise<void> {
    const result = await db.query(
        `UPDATE ytdlp_write_reconciliations SET file_id = $2, index_state = 'present', updated_at = NOW()
         WHERE operation_id = $1 AND status = 'pending' RETURNING operation_id`, [operationId, fileId],
    );
    if (result.rowCount !== 1) throw new Error('yt-dlp write journal 索引状态更新失败');
}

export async function updateYtDlpCompensation(db: Queryable, input: {
    operationId: string;
    objectDeleted: boolean;
    indexDeleted: boolean;
    reason: string;
}): Promise<boolean> {
    const resolved = input.objectDeleted && input.indexDeleted;
    const result = await db.query(
        `UPDATE ytdlp_write_reconciliations
         SET object_state = CASE WHEN $2::boolean THEN 'deleted' ELSE object_state END,
             index_state = CASE WHEN $3::boolean THEN 'deleted' ELSE index_state END,
             status = CASE WHEN $4::boolean THEN 'resolved' ELSE 'pending' END,
             resolution = CASE WHEN $4::boolean THEN 'compensated' ELSE 'operator_required' END,
             reason = $5, resolved_at = CASE WHEN $4::boolean THEN NOW() ELSE NULL END, updated_at = NOW()
         WHERE operation_id = $1 AND status = 'pending' RETURNING operation_id`,
        [input.operationId, input.objectDeleted, input.indexDeleted, resolved, input.reason.slice(0, 2000)],
    );
    return result.rowCount === 1 && resolved;
}

export async function reconcileCommittedYtDlpWrites(db: Queryable): Promise<number> {
    const result = await db.query(
        `WITH candidates AS (
             SELECT r.operation_id, r.task_id, r.execution_generation, r.file_id, r.stored_path,
                    f.size, f.name AS stored_name
             FROM ytdlp_write_reconciliations r
             JOIN files f ON f.id = r.file_id
                         AND f.path = r.stored_path
                         AND f.source = r.provider
                         AND f.storage_account_id IS NOT DISTINCT FROM r.account_id
             WHERE r.status = 'pending' AND r.object_state = 'present' AND r.index_state = 'present'
             FOR UPDATE OF r
         ), completed AS (
             UPDATE transfer_tasks t
             SET status = 'completed', stage = 'completed', progress = 100, completed_items = 1,
                 failed_items = 0, transferred_bytes = c.size, retryable = false, cancel_requested = false,
                 error = NULL, finished_at = NOW(), lease_token = NULL, lease_expires_at = NULL,
                 payload = t.payload || jsonb_build_object('finalPath', c.stored_path, 'storedName', c.stored_name),
                 updated_at = NOW()
             FROM candidates c
             WHERE t.source_type = 'ytdlp' AND t.id = c.task_id
               AND t.execution_generation = c.execution_generation
               AND t.status IN ('running', 'retry_required', 'interrupted')
             RETURNING t.id, c.operation_id
         ), resolved AS (
             UPDATE ytdlp_write_reconciliations r
             SET status = 'resolved', resolution = 'committed', reason = '重启对账确认精确对象和索引已提交',
                 resolved_at = NOW(), updated_at = NOW()
             FROM completed c
             WHERE r.operation_id = c.operation_id AND r.status = 'pending'
             RETURNING r.operation_id
         )
         SELECT COUNT(*)::text AS count FROM resolved`,
    );
    return Number(result.rows[0]?.count || 0);
}

export async function resolveYtDlpCompensated(db: Queryable, operationId: string, reason: string): Promise<void> {
    await db.query(
        `UPDATE ytdlp_write_reconciliations
         SET object_state = 'deleted', index_state = 'deleted', status = 'resolved', resolution = 'compensated',
             reason = $2, resolved_at = NOW(), updated_at = NOW()
         WHERE operation_id = $1 AND status = 'pending'`, [operationId, reason.slice(0, 2000)],
    );
}

export async function markInterruptedYtDlpExecutions(db: Queryable): Promise<void> {
    await db.query(
        `UPDATE transfer_tasks t
         SET status = CASE WHEN r.operation_id IS NULL THEN 'pending' ELSE 'retry_required' END,
             stage = CASE WHEN r.operation_id IS NULL THEN 'recovering' ELSE 'reconciliation_required' END,
             retryable = CASE WHEN r.operation_id IS NULL THEN true ELSE false END,
             error = CASE WHEN r.operation_id IS NULL THEN '服务重启后正在重新排队'
                          ELSE '上次外部写结果需要对账，已阻止自动重试' END,
             lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         FROM (SELECT task_id, MIN(operation_id::text)::uuid AS operation_id
               FROM ytdlp_write_reconciliations WHERE status = 'pending' GROUP BY task_id) r
         WHERE t.source_type = 'ytdlp' AND t.status = 'running' AND r.task_id = t.id`,
    );
    await db.query(
        `UPDATE transfer_tasks t
         SET status = 'pending', stage = 'recovering', retryable = true,
             error = '服务重启后正在重新排队', lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE t.source_type = 'ytdlp' AND t.status = 'running'
           AND NOT EXISTS (SELECT 1 FROM ytdlp_write_reconciliations r WHERE r.task_id = t.id AND r.status = 'pending')`,
    );
}