import pg from 'pg';
import dotenv from 'dotenv';
import { buildSqlLogEvent, parseSqlLoggingConfig, shouldLogSqlQuery, sqlOperation } from '../utils/dbLogging.js';
import { checkDatabaseCurrent } from './migrations.js';


dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://tgvault:***@localhost:5432/tgvault',
});


export async function assertDatabaseCurrent(): Promise<void> {
    await checkDatabaseCurrent(pool);
}

const sqlLoggingConfig = parseSqlLoggingConfig();

pool.on('connect', () => {
    if (process.env.LOG_LEVEL === 'debug') console.log(JSON.stringify({ event: 'db.connected' }));
});

pool.on('error', (err) => {
    console.error(JSON.stringify({ event: 'db.pool_error', code: (err as { code?: string })?.code || 'UNKNOWN' }));
});

export const query = async (text: string, params?: unknown[]) => {
    const start = Date.now();
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (shouldLogSqlQuery(duration, sqlLoggingConfig)) {
        console.log(JSON.stringify(buildSqlLogEvent({
            durationMs: duration,
            rowCount: res.rowCount,
            operation: sqlOperation(text),
        })));
    }
    return res;
};

export default { pool, query };
