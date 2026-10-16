-- Older compactions kept successful bytes but discarded the total/count aggregates.
-- Missing skipped sizes cannot be recovered; retain an explicit lower bound for those.
WITH retained AS (
    SELECT j.id,
           GREATEST(0, j.total_count - COUNT(i.id)) AS missing_count,
           GREATEST(0, j.skipped_count - COUNT(i.id) FILTER (WHERE i.status = 'skipped')) AS missing_skipped
    FROM telegram_background_jobs j
    LEFT JOIN telegram_download_items i ON i.job_id = j.id AND i.status <> 'excluded'
    WHERE j.params ? 'completedBytes'
      AND NOT (j.params ? 'compactedItemCount')
    GROUP BY j.id
)
UPDATE telegram_background_jobs j
SET params = j.params || jsonb_build_object(
    'compactedItemCount', r.missing_count,
    'compactedTotalBytes', COALESCE((j.params->>'completedBytes')::bigint, 0),
    'compactedUnknownSizeCount', COALESCE((j.params->>'savedUnknownCount')::bigint, 0) + r.missing_skipped)
FROM retained r
WHERE j.id = r.id AND r.missing_count > 0;
