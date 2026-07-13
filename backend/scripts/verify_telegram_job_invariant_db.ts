import pg from 'pg';
import { repairTelegramJobInvariantsWithQuery } from '../src/services/telegramChannelJobs.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const client = new pg.Client({ connectionString });
await client.connect();
try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE telegram_background_jobs (LIKE public.telegram_background_jobs INCLUDING DEFAULTS) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE telegram_download_items (LIKE public.telegram_download_items INCLUDING DEFAULTS) ON COMMIT DROP`);
    const jobs = await client.query(`
        INSERT INTO telegram_background_jobs (user_id, chat_id, kind, source, status, scan_status, download_status, params, finished_at)
        VALUES
          (1, 10, 'date_range', 'source-a', 'completed', 'done', 'done', '{"mode":"date"}'::jsonb, NOW()),
          (2, 20, 'subscription_sync', 'source-b', 'running', 'done', 'active', '{}'::jsonb, NOW())
        RETURNING id, user_id
    `);
    jobs.rows.sort((a, b) => Number(a.user_id) - Number(b.user_id));
    for (const job of jobs.rows) {
        await client.query(`
            INSERT INTO telegram_download_items (job_id, source, source_peer, message_id, file_name, mime_type, status)
            VALUES ($1, 'source', 'source', 1, 'file.bin', 'application/octet-stream', 'pending')
        `, [job.id]);
    }

    const repaired = await repairTelegramJobInvariantsWithQuery((text, params) => client.query(text, params));
    if (repaired !== 2) throw new Error(`expected 2 repaired jobs, got ${repaired}`);
    const result = await client.query(`SELECT status, finished_at, scan_status FROM telegram_background_jobs ORDER BY user_id`);
    for (const row of result.rows) {
        if (row.status !== 'running' || row.finished_at !== null || row.scan_status !== 'done') {
            throw new Error(`unexpected repaired row: ${JSON.stringify(row)}`);
        }
    }
    console.log('telegram job invariant db integration ok');
} finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
}
