-- FlClouds 数据库表结构

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 更新时间辅助函数
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 存储账户表 (父表，需先创建)
CREATE TABLE IF NOT EXISTS storage_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(50) NOT NULL, -- 'onedrive'
    name VARCHAR(255) NOT NULL, -- 用户显示名称或邮箱
    config JSONB NOT NULL, -- {clientId, clientSecret, refreshToken, tenantId}
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- storage_accounts 表更新时间触发器
CREATE OR REPLACE TRIGGER storage_accounts_updated_at
    BEFORE UPDATE ON storage_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- 文件表 (子表，依赖 storage_accounts)
CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    stored_name VARCHAR(255) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('image', 'video', 'audio', 'document', 'other')),
    mime_type VARCHAR(100),
    size BIGINT NOT NULL,
    path VARCHAR(500) NOT NULL,
    thumbnail_path VARCHAR(500),
    width INT,
    height INT,
    source VARCHAR(50) DEFAULT 'web',
    folder VARCHAR(255),
    storage_account_id UUID REFERENCES storage_accounts(id),
    is_favorite BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_files_type ON files(type);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
CREATE INDEX IF NOT EXISTS idx_files_is_favorite ON files(is_favorite);

-- files 表更新时间触发器
CREATE OR REPLACE TRIGGER files_updated_at
    BEFORE UPDATE ON files
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- API Keys 表
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    key VARCHAR(128) NOT NULL UNIQUE,
    key_hash VARCHAR(64) UNIQUE,
    permissions JSONB DEFAULT '["upload"]',
    enabled BOOLEAN DEFAULT true,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 系统设置表
CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- system_settings 表更新时间触发器
CREATE OR REPLACE TRIGGER system_settings_updated_at
    BEFORE UPDATE ON system_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
