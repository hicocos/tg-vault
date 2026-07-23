import type { PoolClient } from 'pg';

type LifecycleClient = Pick<PoolClient, 'query'>;

export class StorageAccountNotFoundError extends Error {
    constructor() {
        super('存储账户不存在或已被删除');
        this.name = 'StorageAccountNotFoundError';
    }
}

export class StorageAccountConflictError extends Error {
    constructor(readonly kind: 'active' | 'job' | 'upload') {
        super(kind === 'active'
            ? '无法删除当前正在使用的账户，请先切换到其他账户或本地存储。'
            : kind === 'job'
                ? '该账户仍被未完成的 Telegram 任务使用，请先完成或取消这些任务。'
                : '该账户仍被进行中的上传使用，请等待上传完成或取消后重试。');
        this.name = 'StorageAccountConflictError';
    }
}

export async function lockStorageAccountForUse(client: LifecycleClient, accountId: string): Promise<{ id: string; type: string }> {
    const result = await client.query(
        'SELECT id, type FROM storage_accounts WHERE id = $1 FOR KEY SHARE',
        [accountId],
    );
    if (!result.rows[0]) throw new StorageAccountNotFoundError();
    return result.rows[0] as { id: string; type: string };
}

export async function lockStorageTargetForUse(
    client: LifecycleClient,
    provider: string,
    accountId: string | null,
): Promise<{ provider: string; accountId: string | null }> {
    if (provider === 'local') {
        if (accountId) throw new Error('本地存储目标不能绑定云存储账户');
        return { provider, accountId: null };
    }
    if (!accountId) throw new Error('云存储上传目标缺少账户');
    const account = await lockStorageAccountForUse(client, accountId);
    if (account.type !== provider) throw new Error('上传目标账户与 provider 不匹配');
    return { provider, accountId };
}

export async function switchStorageAccountWithClient(client: LifecycleClient, accountId: string): Promise<string> {
    const account = await client.query(
        'SELECT id, type FROM storage_accounts WHERE id = $1 FOR UPDATE',
        [accountId],
    );
    if (!account.rows[0]) throw new StorageAccountNotFoundError();
    const type = String(account.rows[0].type);
    await client.query('UPDATE storage_accounts SET is_active = (id = $1)', [accountId]);
    await client.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ('active_storage_provider', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [type],
    );
    return type;
}

export async function switchStorageToLocalWithClient(client: LifecycleClient): Promise<void> {
    await client.query('UPDATE storage_accounts SET is_active = false');
    await client.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ('active_storage_provider', 'local', NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    );
}

export async function deleteStorageAccountWithClient(client: LifecycleClient, accountId: string): Promise<{
    id: string;
    name: string;
    type: string;
    deletedFiles: number;
}> {
    const accountResult = await client.query(
        'SELECT id, name, type, is_active FROM storage_accounts WHERE id = $1 FOR UPDATE',
        [accountId],
    );
    if (!accountResult.rows[0]) throw new StorageAccountNotFoundError();
    const account = accountResult.rows[0];
    if (account.is_active) throw new StorageAccountConflictError('active');

    const taskReference = await client.query(
        `SELECT id FROM telegram_background_jobs
         WHERE finished_at IS NULL AND cancelled_at IS NULL
           AND params->>'storageAccountId' = $1
         LIMIT 1 FOR UPDATE`,
        [accountId],
    );
    if (taskReference.rows.length > 0) throw new StorageAccountConflictError('job');

    const transferReference = await client.query(
        `SELECT id FROM transfer_tasks
         WHERE target_account_id = $1
           AND (
               status IN ('pending', 'running', 'paused', 'interrupted', 'retry_required')
               OR retryable = true
           )
         LIMIT 1 FOR UPDATE`,
        [accountId],
    );
    if (transferReference.rows.length > 0) throw new StorageAccountConflictError('job');

    const uploadReference = await client.query(
        `SELECT id FROM storage_account_leases
         WHERE storage_account_id = $1 AND released_at IS NULL
         LIMIT 1 FOR UPDATE`,
        [accountId],
    );
    if (uploadReference.rows.length > 0) throw new StorageAccountConflictError('upload');

    const reconciliationReference = await client.query(
        `SELECT operation_id FROM telegram_write_reconciliations
         WHERE account_id = $1 AND status = 'pending'
         UNION ALL
         SELECT operation_id FROM chunk_upload_reconciliations
         WHERE account_id = $1 AND status = 'pending'
         UNION ALL
         SELECT operation_id FROM ytdlp_write_reconciliations
         WHERE account_id = $1 AND status = 'pending'
         LIMIT 1`,
        [accountId],
    );
    if (reconciliationReference.rows.length > 0) throw new StorageAccountConflictError('upload');

    const chunkReference = await client.query(
        `SELECT upload_id FROM chunk_upload_sessions
         WHERE target_account_id = $1 AND status IN ('open', 'completing', 'failed')
         LIMIT 1 FOR UPDATE`,
        [accountId],
    );
    if (chunkReference.rows.length > 0) throw new StorageAccountConflictError('upload');

    await client.query(
        `UPDATE transfer_tasks
         SET target_account_id = NULL, updated_at = NOW()
         WHERE target_account_id = $1 AND status IN ('completed', 'cancelled') AND retryable = false`,
        [accountId],
    );

    const fileResult = await client.query('DELETE FROM files WHERE storage_account_id = $1', [accountId]);
    const deleted = await client.query(
        'DELETE FROM storage_accounts WHERE id = $1 AND is_active = false RETURNING id',
        [accountId],
    );
    if (deleted.rowCount !== 1) throw new StorageAccountConflictError('active');
    return {
        id: String(account.id),
        name: String(account.name),
        type: String(account.type),
        deletedFiles: fileResult.rowCount || 0,
    };
}
