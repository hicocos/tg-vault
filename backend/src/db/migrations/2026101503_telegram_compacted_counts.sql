-- Compacted item totals survive retries; split them into success/skipped counts.
WITH archived AS (
    SELECT j.id,
           (j.params->>'compactedItemCount')::bigint AS item_count,
           LEAST((j.params->>'compactedItemCount')::bigint,
               GREATEST(0, j.skipped_count - COUNT(i.id) FILTER (WHERE i.status = 'skipped'))) AS skipped_count
    FROM telegram_background_jobs j
    LEFT JOIN telegram_download_items i ON i.job_id = j.id
    WHERE j.params ? 'compactedItemCount'
      AND NOT (j.params ? 'compactedSuccessCount')
    GROUP BY j.id
)
UPDATE telegram_background_jobs j
SET params = j.params || jsonb_build_object(
    'compactedSuccessCount', a.item_count - a.skipped_count,
    'compactedSkippedCount', a.skipped_count)
FROM archived a
WHERE j.id = a.id;
