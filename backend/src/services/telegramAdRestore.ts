import type { PoolClient } from 'pg';

export interface TelegramAdRestoreRow {
    id: string;
    subscription_id: string;
    source_peer: string;
    message_ids: number[];
    decision: string;
    restored_job_id: string | null;
    restore_status: string;
    restore_attempted_at: string | Date | null;
    user_id: string | number;
    chat_id: string | number | null;
    folder_override: string | null;
}

export interface TelegramAdRestoreLockResult {
    kind: 'missing' | 'existing' | 'in_progress' | 'claimed';
    row?: TelegramAdRestoreRow;
    restoredJobId?: string;
}

export async function claimTelegramAdRestore(
    client: Pick<PoolClient, 'query'>,
    decisionId: string,
    requestRestore: boolean,
): Promise<TelegramAdRestoreLockResult> {
    const result = await client.query(
        `SELECT d.id, d.subscription_id, d.source_peer, d.message_ids, d.decision, d.restored_job_id,
                d.restore_status, d.restore_attempted_at, s.user_id, s.chat_id, s.folder_override
         FROM telegram_subscription_ad_decisions d
         JOIN telegram_channel_subscriptions s ON s.id = d.subscription_id
         WHERE d.id = $1
         FOR UPDATE OF d`,
        [decisionId],
    );
    const row = result.rows[0] as TelegramAdRestoreRow | undefined;
    if (!row) return { kind: 'missing' };
    if (!requestRestore) return { kind: 'claimed', row };
    if (row.restored_job_id) return { kind: 'existing', row, restoredJobId: String(row.restored_job_id) };
    if (row.restore_status === 'restoring' && row.restore_attempted_at) {
        const attemptedAt = new Date(row.restore_attempted_at).getTime();
        if (Number.isFinite(attemptedAt) && Date.now() - attemptedAt < 5 * 60_000) {
            return { kind: 'in_progress', row };
        }
    }
    await client.query(
        `UPDATE telegram_subscription_ad_decisions
         SET restore_status = 'restoring', restore_error = NULL, restore_attempted_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [decisionId],
    );
    return { kind: 'claimed', row };
}

export async function markTelegramAdRestoreSuccess(decisionId: string, jobId: string): Promise<void> {
    const { query } = await import('../db/index.js');
    await query(
        `UPDATE telegram_subscription_ad_decisions
         SET restored_job_id = $2, restored_at = COALESCE(restored_at, NOW()), restore_status = 'restored',
             restore_error = NULL, updated_at = NOW()
         WHERE id = $1`,
        [decisionId, jobId],
    );
}

export async function markTelegramAdRestoreFailure(decisionId: string, error: unknown): Promise<void> {
    const { query } = await import('../db/index.js');
    const message = (error instanceof Error ? error.message : String(error || '恢复下载失败')).slice(0, 1000);
    await query(
        `UPDATE telegram_subscription_ad_decisions
         SET restore_status = 'failed', restore_error = $2, restore_attempted_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [decisionId, message],
    );
}
