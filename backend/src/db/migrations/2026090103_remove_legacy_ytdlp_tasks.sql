-- Remove any legacy yt-dlp transfer state left by pre-removal releases.
-- The feature is absent from the current schema; this migration only cleans old rows.
UPDATE transfer_tasks
SET status = 'cancelled',
    stage = 'cancelled',
    retryable = false,
    cancel_requested = true,
    finished_at = COALESCE(finished_at, NOW()),
    updated_at = NOW()
WHERE source_type = 'ytdlp'
  AND status IN ('pending', 'running', 'paused', 'completing', 'retry_required');

DELETE FROM task_center_dismissals WHERE source_type = 'ytdlp';
DELETE FROM transfer_tasks WHERE source_type = 'ytdlp';
