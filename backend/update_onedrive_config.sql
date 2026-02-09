-- 手动更新 OneDrive 配置的 SQL 语句
-- 如果自动脚本无法连接数据库，请在您的数据库管理工具中运行这些语句

INSERT INTO system_settings (key, value, updated_at) VALUES 
('onedrive_client_id', 'REMOVED_ONEDRIVE_CLIENT_ID', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO system_settings (key, value, updated_at) VALUES 
('onedrive_client_secret', '', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO system_settings (key, value, updated_at) VALUES 
('onedrive_refresh_token', 'REMOVED_ONEDRIVE_REFRESH_TOKEN', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO system_settings (key, value, updated_at) VALUES 
('onedrive_tenant_id', '79e54b9b-9f89-4c66-be4d-6f5bb457703b', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO system_settings (key, value, updated_at) VALUES 
('storage_provider', 'onedrive', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- 验证更新
SELECT * FROM system_settings WHERE key LIKE 'onedrive_%' OR key = 'storage_provider';
