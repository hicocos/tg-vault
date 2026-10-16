import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { buildSqlLogEvent, parseSqlLoggingConfig, shouldLogSqlQuery, sqlOperation } from '../utils/dbLogging.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_LOCK_KEY = 0x54475641;

dotenv.config();

const { Pool } = pg;
type DatabaseClient = pg.PoolClient;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://tgvault:***@localhost:5432/tgvault',
});

let initializationPromise: Promise<void> | null = null;

interface MigrationFile {
    version: number;
    name: string;
    checksum: string;
    sql: string;
}

async function listMigrations(): Promise<MigrationFile[]> {
    let entries: string[];
    try {
        entries = await fs.readdir(MIGRATIONS_DIR);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
        throw error;
    }
    return Promise.all(entries
        .filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
        .sort()
        .map(async fileName => {
            const separator = fileName.indexOf('_');
            const version = Number(fileName.slice(0, separator));
            if (!Number.isSafeInteger(version)) throw new Error(`invalid migration version: ${fileName}`);
            const sql = await fs.readFile(path.join(MIGRATIONS_DIR, fileName), 'utf8');
            return {
                version,
                name: fileName.slice(separator + 1, -4),
                checksum: crypto.createHash('sha256').update(sql).digest('hex'),
                sql,
            };
        }));
}

async function ensureMigrationLedger(client: DatabaseClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version BIGINT PRIMARY KEY,
            name TEXT NOT NULL,
            checksum VARCHAR(64) NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

async function applyMigrations(client: DatabaseClient): Promise<void> {
    for (const migration of await listMigrations()) {
        const existing = await client.query(
            'SELECT name, checksum FROM schema_migrations WHERE version = $1',
            [migration.version],
        );
        if (existing.rowCount) {
            if (existing.rows[0].name !== migration.name || existing.rows[0].checksum !== migration.checksum) {
                throw new Error(`migration ${migration.version} checksum/name mismatch`);
            }
            continue;
        }
        await client.query('BEGIN');
        try {
            await client.query(migration.sql);
            await client.query(
                'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
                [migration.version, migration.name, migration.checksum],
            );
            await client.query('COMMIT');
            console.log(`✅ 数据库迁移 ${migration.version}_${migration.name} 已应用`);
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }
}

async function bootstrapNewDatabase(client: DatabaseClient): Promise<void> {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = await fs.readFile(schemaPath, 'utf8');
    await client.query('BEGIN');
    try {
        // PostgreSQL receives the canonical snapshot as one script; no custom semicolon parser is involved.
        await client.query(schemaSql);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    }
}

async function initializeDatabase(): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
        const exists = await client.query("SELECT to_regclass('public.schema_migrations') AS ledger");
        if (!exists.rows[0]?.ledger) await bootstrapNewDatabase(client);
        await ensureMigrationLedger(client);
        await applyMigrations(client);
        // Initialization precedes worker creation; no previous-process attempt can still be live.
        await client.query(`UPDATE telegram_download_attempts
            SET status = 'cancelled', error = '服务重启，旧下载执行已结束', finished_at = NOW()
            WHERE status = 'running'`);
        console.log('✅ 数据库表结构初始化完成');
    } catch (error) {
        console.error('❌ 数据库初始化失败:', error);
        throw error;
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
        client.release();
    }
}

export function ensureDatabaseInitialized(): Promise<void> {
    if (!initializationPromise) initializationPromise = initializeDatabase();
    return initializationPromise;
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
