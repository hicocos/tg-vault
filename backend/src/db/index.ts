import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { buildSqlLogEvent, parseSqlLoggingConfig, shouldLogSqlQuery, sqlOperation } from '../utils/dbLogging.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://tgvault:password@localhost:5432/tgvault',
});

let initializationPromise: Promise<void> | null = null;

async function ensureFavoritesColumn() {
    try {
        await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT false`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_is_favorite ON files(is_favorite)`);
    } catch (err: any) {
        if (err?.code === '42P01') {
            return;
        }
        console.error('❌ 数据库迁移失败 (收藏字段):', err);
        throw err;
    }
}

async function ensureFilesPerformanceIndexes() {
    try {
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_account_created ON files(storage_account_id, created_at DESC, id DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_source_created ON files(source, created_at DESC, id DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_account_fav_created ON files(storage_account_id, is_favorite, created_at DESC, id DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_source_fav_created ON files(source, is_favorite, created_at DESC, id DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_account_folder_created ON files(storage_account_id, folder, created_at DESC, id DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_files_source_folder_created ON files(source, folder, created_at DESC, id DESC)`);
    } catch (err: any) {
        if (err?.code === '42P01') {
            return;
        }
        console.error('❌ 数据库迁移失败 (文件列表性能索引):', err);
        throw err;
    }
}

// 自动初始化数据库表结构
async function initializeDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = await fs.readFile(schemaPath, 'utf-8');

        // 智能分割 SQL 语句（处理 PL/pgSQL 的 $$ 块）
        const statements: string[] = [];
        let current = '';
        let inDollarQuote = false;

        for (let i = 0; i < schemaSql.length; i++) {
            const char = schemaSql[i];
            current += char;

            // 检测 $$ 块的开始和结束
            if (char === '$' && schemaSql[i + 1] === '$') {
                inDollarQuote = !inDollarQuote;
                current += '$';
                i++; // 跳过下一个 $
            } else if (char === ';' && !inDollarQuote) {
                const stmt = current.trim();
                if (stmt.length > 1) {
                    const withoutLeadingLineComments = stmt.replace(/^\s*(--[^\n]*\n\s*)+/g, '').trim();
                    if (withoutLeadingLineComments.length > 0) {
                        statements.push(withoutLeadingLineComments.slice(0, -1)); // 移除末尾的分号
                    }
                }
                current = '';
            }
        }
        // 添加最后一条语句（如果没有以分号结尾）
        const lastStmt = current.trim();
        if (lastStmt.length > 0) {
            const withoutLeadingLineComments = lastStmt.replace(/^\s*(--[^\n]*\n\s*)+/g, '').trim();
            if (withoutLeadingLineComments.length > 0) {
                statements.push(withoutLeadingLineComments);
            }
        }

        for (const statement of statements) {
            try {
                await pool.query(statement);
            } catch (err: any) {
                // 如果是表已存在的错误，忽略
                if (err.message?.includes('already exists')) {
                    continue;
                }
                throw err;
            }
        }

        await ensureFavoritesColumn();
        await ensureFilesPerformanceIndexes();
        await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_path VARCHAR(500)`);
        await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash VARCHAR(64)`);
        await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`);
        await pool.query(`ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS source_original TEXT`);
        await pool.query(`ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'public'`);
        await pool.query(`ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS disabled_reason TEXT`);
        await pool.query(`ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ`);
        await pool.query(`CREATE TABLE IF NOT EXISTS web_sessions (
            token_hash VARCHAR(64) PRIMARY KEY,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS task_center_dismissals (
            source_type VARCHAR(30) NOT NULL,
            task_id VARCHAR(128) NOT NULL,
            task_updated_at TIMESTAMPTZ NOT NULL,
            dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (source_type, task_id)
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_task_center_dismissals_version ON task_center_dismissals(source_type, task_id, task_updated_at)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS storage_account_cooldowns (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            storage_account_id UUID REFERENCES storage_accounts(id) ON DELETE CASCADE,
            provider VARCHAR(50) NOT NULL,
            reason VARCHAR(100) NOT NULL,
            cooldown_until TIMESTAMPTZ NOT NULL,
            last_error TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(storage_account_id, provider, reason)
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_storage_account_cooldowns_until ON storage_account_cooldowns(cooldown_until)`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash) WHERE key_hash IS NOT NULL`);

        console.log('✅ 数据库表结构初始化完成');
    } catch (err: any) {
        console.error('❌ 数据库初始化失败:', err);
        throw err;
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
    console.error(JSON.stringify({ event: 'db.pool_error', code: (err as any)?.code || 'UNKNOWN' }));
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
