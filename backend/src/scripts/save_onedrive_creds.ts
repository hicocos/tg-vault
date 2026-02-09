
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// ============================================
// 在此填入您的 OneDrive 国际版凭证
// ============================================
const CREDENTIALS = {
    onedrive_client_id: 'REMOVED_ONEDRIVE_CLIENT_ID',
    onedrive_client_secret: '', // Public client has no secret
    onedrive_refresh_token: 'REMOVED_ONEDRIVE_REFRESH_TOKEN',
    onedrive_tenant_id: '79e54b9b-9f89-4c66-be4d-6f5bb457703b',
    storage_provider: 'onedrive'
};
// ============================================

const updateSetting = async (key: string, value: string) => {
    await pool.query(
        `INSERT INTO system_settings (key, value, updated_at) 
         VALUES ($1, $2, NOW()) 
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
    );
    console.log(`✓ Updated setting: ${key}`);
};

async function main() {
    try {
        console.log('==========================================');
        console.log('OneDrive 国际版凭证保存工具');
        console.log('==========================================\n');

        console.log('1. 连接数据库...');

        // 确保表存在
        await pool.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR(255) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✓ 确认 system_settings 表存在\n');

        console.log('2. 保存 OneDrive 凭证...');
        await updateSetting('onedrive_client_id', CREDENTIALS.onedrive_client_id);
        await updateSetting('onedrive_client_secret', CREDENTIALS.onedrive_client_secret);
        await updateSetting('onedrive_refresh_token', CREDENTIALS.onedrive_refresh_token);
        await updateSetting('onedrive_tenant_id', CREDENTIALS.onedrive_tenant_id);
        await updateSetting('storage_provider', CREDENTIALS.storage_provider);

        console.log('\n==========================================');
        console.log('✓ OneDrive 凭证保存成功！');
        console.log('✓ 存储提供商已切换为 OneDrive');
        console.log('==========================================\n');

        console.log('下一步：重启后端服务使配置生效');
        console.log('  cd backend && npm run dev\n');

    } catch (err: any) {
        console.error('\n✗ 自动保存凭证失败 (可能是因为本地没有运行数据库)');
        console.error('  错误信息:', err.message);

        console.log('\n请手动在您的数据库管理工具中运行以下 SQL 语句：\n');
        console.log('---------------------------------------------------');
        console.log(`INSERT INTO system_settings (key, value, updated_at) VALUES ('onedrive_client_id', '${CREDENTIALS.onedrive_client_id}', NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`);
        console.log(`INSERT INTO system_settings (key, value, updated_at) VALUES ('onedrive_client_secret', '${CREDENTIALS.onedrive_client_secret}', NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`);
        console.log(`INSERT INTO system_settings (key, value, updated_at) VALUES ('onedrive_refresh_token', '${CREDENTIALS.onedrive_refresh_token}', NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`);
        console.log(`INSERT INTO system_settings (key, value, updated_at) VALUES ('onedrive_tenant_id', '${CREDENTIALS.onedrive_tenant_id}', NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`);
        console.log(`INSERT INTO system_settings (key, value, updated_at) VALUES ('storage_provider', '${CREDENTIALS.storage_provider}', NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`);
        console.log('---------------------------------------------------\n');

        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
