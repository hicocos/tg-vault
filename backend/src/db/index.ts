import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://foomclous:password@localhost:5432/foomclous',
});

// 测试连接
pool.on('connect', () => {
    console.log('📦 已连接到 PostgreSQL 数据库');
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
