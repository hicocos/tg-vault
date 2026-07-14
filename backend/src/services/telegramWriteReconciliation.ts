import crypto from 'node:crypto';

export type TelegramWriteState = 'unknown' | 'present' | 'deleted';

interface Queryable {
    query(text: string, params?: unknown[]): Promise<unknown>;
}

export interface TelegramWriteReconciliationInput {
    jobId: string;
    itemId: string;
    childLeaseToken: string;
    provider: string;
    accountId: string | null;
}

export interface ClaimedTelegramWriteReconciliation {
    operationId: string;
    jobId: string;
    itemId: string;
    childLeaseToken: string;
    provider: string;
    accountId: string | null;
    storedPath: string | null;
    fileId: string | null;
    objectState: TelegramWriteState;
    indexState: TelegramWriteState;
    itemStatus: string;
}

export async function beginTelegramWriteReconciliation(db: Queryable, input: TelegramWriteReconciliationInput): Promise<string> {
    const operationId = crypto.randomUUID();
    const result = await db.query(
        `INSERT INTO telegram_write_reconciliations
         (operation_id, job_id, item_id, child_lease_token, provider, account_id,
          object_state, index_state, reason, status, created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,$6,'unknown','unknown','Telegram 外部写进行中','pending',NOW(),NOW()
         WHERE EXISTS (
             SELECT 1 FROM telegram_download_items i
             WHERE i.id = $3::uuid AND i.job_id = $2::uuid AND i.status = 'downloading' AND i.lease_token = $4::uuid
         )
         RETURNING operation_id`,
        [operationId, input.jobId, input.itemId, input.childLeaseToken, input.provider, input.accountId],
    ) as { rowCount?: number | null };
    if (result.rowCount !== 1) throw new Error('Telegram write journal 创建失败或 child lease 已丢失');
    return operationId;
}

export async function markTelegramWriteObjectPresent(db: Queryable, operationId: string, storedPath: string): Promise<void> {
    const result = await db.query(
        `UPDATE telegram_write_reconciliations
         SET stored_path = $2, object_state = 'present', updated_at = NOW()
         WHERE operation_id = $1 AND status = 'pending'`, [operationId, storedPath],
    ) as { rowCount?: number | null };
    if (result.rowCount !== 1) throw new Error('Telegram write journal 对象状态更新失败');
}

export async function markTelegramWriteIndexPresent(db: Queryable, operationId: string, fileId: string): Promise<void> {
    const result = await db.query(
        `UPDATE telegram_write_reconciliations
         SET file_id = $2, index_state = 'present', updated_at = NOW()
         WHERE operation_id = $1 AND status = 'pending'`, [operationId, fileId],
    ) as { rowCount?: number | null };
    if (result.rowCount !== 1) throw new Error('Telegram write journal 索引状态更新失败');
}

export async function updateTelegramWriteAfterCompensation(
    db: Queryable,
    operationId: string,
    evidence: { objectState: TelegramWriteState; indexState: TelegramWriteState; reason: string },
): Promise<void> {
    const resolved = evidence.objectState === 'deleted' && evidence.indexState === 'deleted';
    const result = await db.query(
        `UPDATE telegram_write_reconciliations
         SET object_state = $2, index_state = $3, reason = $4,
             status = CASE WHEN $5::boolean THEN 'resolved' ELSE 'pending' END,
             resolution = CASE WHEN $5::boolean THEN 'compensated' ELSE resolution END,
             resolved_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
             lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE operation_id = $1 AND status = 'pending'
         RETURNING operation_id`,
        [operationId, evidence.objectState, evidence.indexState, evidence.reason.slice(0, 2000), resolved],
    ) as { rowCount?: number | null };
    if (result.rowCount !== 1) throw new Error('Telegram write journal 补偿状态更新失败');
}

export async function resolveTelegramWriteCommittedWithQuery(db: Queryable, operationId: string, childLeaseToken: string): Promise<void> {
    const result = await db.query(
        `UPDATE telegram_write_reconciliations
         SET status = 'resolved', resolution = 'committed', reason = 'Telegram child 与外部写已提交',
             resolved_at = NOW(), lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE operation_id = $1 AND child_lease_token = $2::uuid AND status = 'pending'
           AND object_state = 'present' AND index_state = 'present'
         RETURNING operation_id`, [operationId, childLeaseToken],
    ) as { rowCount?: number | null };
    if (result.rowCount !== 1) throw new Error('Telegram child terminal+journal resolve 影响 0 行');
}

export async function claimTelegramWriteReconciliations(db: Queryable, leaseToken: string, limit = 100): Promise<ClaimedTelegramWriteReconciliation[]> {
    const result = await db.query(
        `WITH candidates AS (
             SELECT r.operation_id
             FROM telegram_write_reconciliations r
             WHERE r.status = 'pending'
               AND r.resolution IS DISTINCT FROM 'operator_required'
               AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= NOW())
             ORDER BY r.created_at
             FOR UPDATE SKIP LOCKED
             LIMIT $2
         )
         UPDATE telegram_write_reconciliations r
         SET lease_token = $1::uuid, lease_expires_at = NOW() + INTERVAL '5 minutes',
             attempts = r.attempts + 1, updated_at = NOW()
         FROM candidates c, telegram_download_items i
         WHERE r.operation_id = c.operation_id AND i.id = r.item_id
         RETURNING r.*, i.status AS item_status`,
        [leaseToken, Math.max(1, Math.min(limit, 1000))],
    ) as { rows: any[] };
    return result.rows.map(row => ({
        operationId: String(row.operation_id), jobId: String(row.job_id), itemId: String(row.item_id),
        childLeaseToken: String(row.child_lease_token), provider: String(row.provider), accountId: row.account_id ? String(row.account_id) : null,
        storedPath: row.stored_path ? String(row.stored_path) : null, fileId: row.file_id ? String(row.file_id) : null,
        objectState: row.object_state, indexState: row.index_state, itemStatus: String(row.item_status),
    }));
}

export async function resolveClaimedTelegramWrite(input: {
    db: Queryable;
    leaseToken: string;
    row: ClaimedTelegramWriteReconciliation;
    deleteObject: (path: string) => Promise<void>;
}): Promise<'resolved' | 'operator-required' | 'pending'> {
    const { db, row, leaseToken } = input;
    if (row.itemStatus === 'success' && row.fileId && row.objectState === 'present' && row.indexState === 'present') {
        const result = await db.query(
            `UPDATE telegram_write_reconciliations SET status = 'resolved', resolution = 'committed', reason = '重启扫描确认 child 已成功',
             resolved_at = NOW(), lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
             WHERE operation_id = $1 AND lease_token = $2::uuid AND status = 'pending'`, [row.operationId, leaseToken],
        ) as { rowCount?: number | null };
        return result.rowCount === 1 ? 'resolved' : 'pending';
    }
    if (row.objectState === 'unknown' && !row.storedPath) {
        await db.query(
            `UPDATE telegram_write_reconciliations SET resolution = 'operator_required', reason = '对象结果未知且缺少精确 stored_path，禁止盲目重试',
             lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
             WHERE operation_id = $1 AND lease_token = $2::uuid AND status = 'pending'`, [row.operationId, leaseToken],
        );
        return 'operator-required';
    }
    let objectState = row.objectState;
    let indexState = row.indexState;
    const errors: string[] = [];
    if (row.storedPath && objectState !== 'deleted') {
        try { await input.deleteObject(row.storedPath); objectState = 'deleted'; }
        catch (error) { objectState = 'unknown'; errors.push(`object: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (row.fileId && indexState !== 'deleted') {
        try {
            const deleted = await db.query('DELETE FROM files WHERE id = $1', [row.fileId]) as { rowCount?: number | null };
            if (deleted.rowCount !== 0 && deleted.rowCount !== 1) throw new Error('索引补偿影响行数异常');
            indexState = 'deleted';
        } catch (error) { indexState = 'unknown'; errors.push(`index: ${error instanceof Error ? error.message : String(error)}`); }
    } else if (!row.fileId && indexState === 'unknown') {
        errors.push('index: 缺少精确 file_id');
    }
    const resolved = objectState === 'deleted' && indexState === 'deleted';
    await db.query(
        `UPDATE telegram_write_reconciliations SET object_state = $3, index_state = $4,
         status = CASE WHEN $5::boolean THEN 'resolved' ELSE 'pending' END,
         resolution = CASE WHEN $5::boolean THEN 'compensated' ELSE resolution END,
         reason = $6, resolved_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
         lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE operation_id = $1 AND lease_token = $2::uuid AND status = 'pending'`,
        [row.operationId, leaseToken, objectState, indexState, resolved, errors.join('; ') || '重启扫描补偿已确认'],
    );
    return resolved ? 'resolved' : 'pending';
}
