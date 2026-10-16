import { query } from '../db/index.js';
import { getSetting } from '../utils/settings.js';

export type TelegramDownloadHistoryPolicy = 'errors_only' | 'all';

export const DEFAULT_TELEGRAM_DOWNLOAD_HISTORY_POLICY: TelegramDownloadHistoryPolicy = 'errors_only';
export const TELEGRAM_DOWNLOAD_HISTORY_POLICY_SETTING = 'telegram_download_history_policy';

export function normalizeTelegramDownloadHistoryPolicy(value: unknown): TelegramDownloadHistoryPolicy {
    return value === 'all' ? 'all' : DEFAULT_TELEGRAM_DOWNLOAD_HISTORY_POLICY;
}

export function terminalStatusesToDelete(policy: TelegramDownloadHistoryPolicy): Array<'success' | 'skipped' | 'excluded'> {
    return policy === 'errors_only' ? ['success', 'skipped', 'excluded'] : [];
}

export async function getTelegramDownloadHistoryPolicy(): Promise<TelegramDownloadHistoryPolicy> {
    return normalizeTelegramDownloadHistoryPolicy(await getSetting(
        TELEGRAM_DOWNLOAD_HISTORY_POLICY_SETTING,
        DEFAULT_TELEGRAM_DOWNLOAD_HISTORY_POLICY,
    ));
}

export async function compactTelegramDownloadHistory(jobId?: string): Promise<number> {
    const policy = await getTelegramDownloadHistoryPolicy();
    const statuses = terminalStatusesToDelete(policy);
    if (statuses.length === 0) return 0;
    // Delete and accumulate in one statement: retries and concurrent compactions must not
    // overwrite earlier successes or count the same removed item twice.
    const result = await query(
        `WITH removed AS (
             DELETE FROM telegram_download_items i
             USING telegram_background_jobs j
             WHERE i.job_id = j.id
               AND i.status = ANY($1::varchar[])
               AND j.finished_at IS NOT NULL
               AND ($2::uuid IS NULL OR j.id = $2::uuid)
             RETURNING i.job_id, i.status, i.total_size
         ), summaries AS (
             SELECT job_id,
                    COUNT(*) FILTER (WHERE status <> 'excluded') AS item_count,
                    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
                    COUNT(*) FILTER (WHERE status = 'skipped') AS skipped_count,
                    COALESCE(SUM(total_size) FILTER (WHERE status <> 'excluded'), 0) AS total_bytes,
                    COUNT(*) FILTER (WHERE status <> 'excluded' AND COALESCE(total_size, 0) <= 0) AS unknown_sizes,
                    COALESCE(SUM(total_size) FILTER (WHERE status = 'success'), 0) AS completed_bytes,
                    COUNT(*) FILTER (WHERE status = 'success' AND COALESCE(total_size, 0) <= 0) AS saved_unknown_sizes
             FROM removed GROUP BY job_id
         ), updated AS (
             UPDATE telegram_background_jobs j
             SET params = j.params || jsonb_build_object(
                 'compactedItemCount', COALESCE((j.params->>'compactedItemCount')::bigint, 0) + s.item_count,
                 'compactedSuccessCount', COALESCE((j.params->>'compactedSuccessCount')::bigint, 0) + s.success_count,
                 'compactedSkippedCount', COALESCE((j.params->>'compactedSkippedCount')::bigint, 0) + s.skipped_count,
                 'compactedTotalBytes', COALESCE((j.params->>'compactedTotalBytes')::bigint, 0) + s.total_bytes,
                 'compactedUnknownSizeCount', COALESCE((j.params->>'compactedUnknownSizeCount')::bigint, 0) + s.unknown_sizes,
                 'completedBytes', COALESCE((j.params->>'completedBytes')::bigint, 0) + s.completed_bytes,
                 'savedUnknownCount', COALESCE((j.params->>'savedUnknownCount')::bigint, 0) + s.saved_unknown_sizes)
             FROM summaries s WHERE j.id = s.job_id
             RETURNING j.id
         )
         SELECT COUNT(*)::int AS deleted_count FROM removed`,
        [statuses, jobId || null],
    );
    return Number(result.rows[0]?.deleted_count || 0);
}
