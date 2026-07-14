import crypto from 'node:crypto';

export type ChunkReconciliationState = 'unknown' | 'present' | 'deleted';

export interface ChunkReconciliationEvidence {
    uploadId: string;
    completionToken: string;
    provider: string;
    accountId: string | null;
    storedPath: string;
    fileId: string;
    objectState: ChunkReconciliationState;
    indexState: ChunkReconciliationState;
    reason: string;
}

interface Queryable {
    query(text: string, params?: unknown[]): Promise<unknown>;
}

export interface ClaimedChunkReconciliation {
    operationId: string;
    uploadId: string;
    completionToken: string;
    provider: string;
    accountId: string | null;
    storedPath: string | null;
    fileId: string | null;
    objectState: ChunkReconciliationState;
    indexState: ChunkReconciliationState;
    sessionStatus: string;
    completedFileId: string | null;
}

export async function claimChunkReconciliations(db: Queryable, leaseToken: string, limit = 100): Promise<ClaimedChunkReconciliation[]> {
    const result = await db.query(
        `WITH candidates AS (
             SELECT r.operation_id FROM chunk_upload_reconciliations r
             WHERE r.status = 'pending'
               AND r.resolution IS DISTINCT FROM 'operator_required'
               AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= NOW())
             ORDER BY r.created_at FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE chunk_upload_reconciliations r
         SET lease_token = $1::uuid, lease_expires_at = NOW() + INTERVAL '5 minutes', attempts = r.attempts + 1, updated_at = NOW()
         FROM candidates c, chunk_upload_sessions s
         WHERE r.operation_id = c.operation_id AND s.upload_id = r.upload_id
         RETURNING r.*, s.status AS session_status, s.completed_file_id`,
        [leaseToken, Math.max(1, Math.min(limit, 1000))],
    ) as { rows: any[] };
    return result.rows.map(row => ({
        operationId: String(row.operation_id), uploadId: String(row.upload_id), completionToken: String(row.completion_token),
        provider: String(row.provider), accountId: row.account_id ? String(row.account_id) : null,
        storedPath: row.stored_path ? String(row.stored_path) : null, fileId: row.file_id ? String(row.file_id) : null,
        objectState: row.object_state, indexState: row.index_state, sessionStatus: String(row.session_status),
        completedFileId: row.completed_file_id ? String(row.completed_file_id) : null,
    }));
}

export async function resolveClaimedChunkReconciliation(input: {
    db: Queryable; leaseToken: string; row: ClaimedChunkReconciliation; deleteObject: (path: string) => Promise<void>;
}): Promise<'resolved' | 'operator-required' | 'pending'> {
    const { db, row, leaseToken } = input;
    if (row.sessionStatus === 'completed' && row.completedFileId === row.fileId && row.objectState === 'present' && row.indexState === 'present') {
        const result = await db.query(
            `UPDATE chunk_upload_reconciliations SET status = 'resolved', resolution = 'committed', reason = '重启扫描确认 session 已完成',
             resolved_at = NOW(), lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
             WHERE operation_id = $1 AND lease_token = $2::uuid AND status = 'pending'`, [row.operationId, leaseToken],
        ) as { rowCount?: number | null };
        return result.rowCount === 1 ? 'resolved' : 'pending';
    }
    if (row.objectState === 'unknown' && !row.storedPath) {
        await db.query(
            `UPDATE chunk_upload_reconciliations SET resolution = 'operator_required', reason = '对象结果未知且缺少精确 stored_path，禁止盲目重试',
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
    } else if (!row.fileId && indexState === 'unknown') errors.push('index: 缺少精确 file_id');
    const resolved = objectState === 'deleted' && indexState === 'deleted';
    await db.query(
        `UPDATE chunk_upload_reconciliations SET object_state = $3, index_state = $4,
         status = CASE WHEN $5::boolean THEN 'resolved' ELSE 'pending' END,
         resolution = CASE WHEN $5::boolean THEN 'compensated' ELSE resolution END, reason = $6,
         resolved_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE operation_id = $1 AND lease_token = $2::uuid AND status = 'pending'`,
        [row.operationId, leaseToken, objectState, indexState, resolved, errors.join('; ') || '重启扫描补偿已确认'],
    );
    return resolved ? 'resolved' : 'pending';
}

export async function beginChunkCompletionReconciliation(db: Queryable, input: {
    uploadId: string;
    completionToken: string;
    provider: string;
    accountId: string | null;
}): Promise<string> {
    const operationId = crypto.randomUUID();
    const result = await db.query(
        `INSERT INTO chunk_upload_reconciliations
         (operation_id, upload_id, completion_token, provider, account_id, object_state, index_state, reason, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'unknown','unknown','分块完成副作用进行中','pending',NOW(),NOW())
         ON CONFLICT (upload_id, completion_token) WHERE status = 'pending'
         DO UPDATE SET updated_at = NOW()
         RETURNING operation_id`,
        [operationId, input.uploadId, input.completionToken, input.provider, input.accountId],
    ) as { rows?: Array<{ operation_id?: string }> };
    return String(result.rows?.[0]?.operation_id || operationId);
}

export async function markChunkReconciliationObjectPresent(db: Queryable, operationId: string, storedPath: string): Promise<void> {
    const result = await db.query(
        `UPDATE chunk_upload_reconciliations SET stored_path = $2, object_state = 'present', updated_at = NOW()
         WHERE operation_id = $1 AND status = 'pending'`, [operationId, storedPath],
    ) as { rowCount?: number | null };
    if (result.rowCount !== 1) throw new Error('分块完成对账 journal 对象状态更新失败');
}

export async function markChunkReconciliationIndexPresent(db: Queryable, operationId: string, fileId: string): Promise<void> {
    const result = await db.query(
        `UPDATE chunk_upload_reconciliations SET file_id = $2, index_state = 'present', updated_at = NOW()
         WHERE operation_id = $1 AND status = 'pending'`, [operationId, fileId],
    ) as { rowCount?: number | null };
    if (result.rowCount !== 1) throw new Error('分块完成对账 journal 索引状态更新失败');
}

export async function updateChunkReconciliationAfterCompensation(
    db: Queryable,
    operationId: string,
    evidence: Pick<ChunkReconciliationEvidence, 'objectState' | 'indexState' | 'reason'>,
): Promise<string> {
    const resolved = evidence.objectState === 'deleted' && evidence.indexState === 'deleted';
    const result = await db.query(
        `UPDATE chunk_upload_reconciliations
         SET object_state = $2, index_state = $3, reason = $4,
             status = CASE WHEN $5::boolean THEN 'resolved' ELSE 'pending' END,
             resolved_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE operation_id = $1 AND status = 'pending'
         RETURNING operation_id`,
        [operationId, evidence.objectState, evidence.indexState, evidence.reason.slice(0, 2000), resolved],
    ) as { rowCount?: number | null };
    if (result.rowCount !== 1) throw new Error('分块完成对账 journal 补偿状态更新失败');
    return operationId;
}

export async function compensateChunkCompletionFailure(input: {
    uploadId: string;
    completionToken: string;
    provider: string;
    accountId: string | null;
    storedPath: string;
    fileId: string;
    deleteObject: () => Promise<void>;
    deleteIndex: () => Promise<boolean>;
    persist: (evidence: ChunkReconciliationEvidence) => Promise<string>;
    initialIndexState?: ChunkReconciliationState;
}): Promise<{ reconciled: boolean; operationId: string }> {
    let objectState: ChunkReconciliationState = 'present';
    let indexState: ChunkReconciliationState = input.initialIndexState || 'present';
    const errors: string[] = [];
    try {
        await input.deleteObject();
        objectState = 'deleted';
    } catch (error) {
        objectState = 'unknown';
        errors.push(`object: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        if (!(await input.deleteIndex())) throw new Error('数据库索引补偿影响 0 行');
        indexState = 'deleted';
    } catch (error) {
        indexState = 'unknown';
        errors.push(`index: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (objectState === 'deleted' && indexState === 'deleted') {
        const operationId = await input.persist({
            uploadId: input.uploadId,
            completionToken: input.completionToken,
            provider: input.provider,
            accountId: input.accountId,
            storedPath: input.storedPath,
            fileId: input.fileId,
            objectState,
            indexState,
            reason: '补偿已确认完成',
        });
        return { reconciled: true, operationId };
    }
    const operationId = await input.persist({
        uploadId: input.uploadId,
        completionToken: input.completionToken,
        provider: input.provider,
        accountId: input.accountId,
        storedPath: input.storedPath,
        fileId: input.fileId,
        objectState,
        indexState,
        reason: errors.join('; ') || '补偿结果不确定',
    });
    return { reconciled: false, operationId };
}

export async function persistChunkReconciliation(db: Queryable, evidence: ChunkReconciliationEvidence): Promise<string> {
    const operationId = crypto.randomUUID();
    await db.query(
        `INSERT INTO chunk_upload_reconciliations
         (operation_id, upload_id, completion_token, provider, account_id, stored_path, file_id,
          object_state, index_state, reason, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',NOW(),NOW())`,
        [operationId, evidence.uploadId, evidence.completionToken, evidence.provider, evidence.accountId,
            evidence.storedPath, evidence.fileId, evidence.objectState, evidence.indexState, evidence.reason.slice(0, 2000)],
    );
    return operationId;
}
