-- Repair task attribution created before job identity reached the download/save stages.
UPDATE telegram_download_attempts a
SET job_id = i.job_id
FROM telegram_download_items i
WHERE a.item_id = i.id AND a.job_id IS NULL AND i.job_id IS NOT NULL;

-- Migrations run before the new process starts any download workers. Previous
-- process attempts cannot still be live; leave successful/failed history intact.
UPDATE telegram_download_attempts
SET status = 'cancelled', error = '服务重启，旧下载执行已结束', finished_at = NOW()
WHERE status = 'running';
