import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://foomclous:password@localhost:5432/foomclous',
});

// 自动初始化数据库表结构
async function initializeDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = await fs.readFile(schemaPath, 'utf-8');

        // 分割 SQL 语句（按分号分隔）
        const statements = schemaSql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--'));

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

        console.log('✅ 数据库表结构初始化完成');
    } catch (err: any) {
        console.error('❌ 数据库初始化失败:', err);
        throw err;
    }
}

// 测试连接
pool.on('connect', async () => {
    console.log('📦 已连接到 PostgreSQL 数据库');
    // 自动初始化数据库表结构
    await initializeDatabase();
});

pool.on('error', (err) => {
    console.error('❌ 数据库连接错误:', err);
});

export const query = async (text: string, params?: unknown[]) => {
    const start = Date.now();
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('🔍 执行查询', { text: text.substring(0, 50), duration, rows: res.rowCount });
    return res;
};

export default { pool, query };
