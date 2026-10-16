-- Type-filtered files never entered the download queue. Keep their audit status separate.
UPDATE telegram_download_items i
SET status = 'excluded'
FROM telegram_background_jobs j
WHERE i.job_id = j.id
  AND j.kind IN ('date_range', 'tag_download')
  AND j.params->>'fileSelectionConfirmed' = 'true'
  AND jsonb_typeof(j.params->'selectedFileTypes') = 'array'
  AND i.status = 'skipped'
  AND i.file_category IS NOT NULL
  AND NOT ((j.params->'selectedFileTypes') ? i.file_category);

-- Available-type counts survive history compaction, unlike the individual excluded items.
WITH selection AS (
    SELECT j.id,
           COALESCE(SUM((category->>'count')::int) FILTER (
               WHERE NOT ((j.params->'selectedFileTypes') ? (category->>'fileType'))
           ), 0)::int AS excluded_count
    FROM telegram_background_jobs j
    CROSS JOIN LATERAL jsonb_array_elements(j.params->'availableFileTypes') category
    WHERE j.kind IN ('date_range', 'tag_download')
      AND j.params->>'fileSelectionConfirmed' = 'true'
      AND jsonb_typeof(j.params->'selectedFileTypes') = 'array'
      AND NOT (j.params ? 'excludedCount')
    GROUP BY j.id
)
UPDATE telegram_background_jobs j
SET total_count = GREATEST(0, j.total_count - s.excluded_count),
    skipped_count = GREATEST(0, j.skipped_count - s.excluded_count),
    params = j.params || jsonb_build_object('excludedCount', s.excluded_count),
    updated_at = NOW()
FROM selection s
WHERE j.id = s.id;
