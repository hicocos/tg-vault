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

-- 存储账户表
CREATE TABLE IF NOT EXISTS storage_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    config JSONB NOT NULL,
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER storage_accounts_updated_at
    BEFORE UPDATE ON storage_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- 文件表
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

CREATE INDEX IF NOT EXISTS idx_files_type ON files(type);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
CREATE INDEX IF NOT EXISTS idx_files_is_favorite ON files(is_favorite);
CREATE INDEX IF NOT EXISTS idx_files_storage_account_id ON files(storage_account_id);

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

CREATE OR REPLACE TRIGGER system_settings_updated_at
    BEFORE UPDATE ON system_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Telegram 频道订阅表
CREATE TABLE IF NOT EXISTS telegram_channel_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL,
    chat_id BIGINT,
    source TEXT NOT NULL,
    title TEXT,
    last_message_id INT DEFAULT 0,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, source)
);

CREATE INDEX IF NOT EXISTS idx_tg_channel_subscriptions_enabled ON telegram_channel_subscriptions(enabled);
CREATE INDEX IF NOT EXISTS idx_tg_channel_subscriptions_user_id ON telegram_channel_subscriptions(user_id);

CREATE OR REPLACE TRIGGER telegram_channel_subscriptions_updated_at
    BEFORE UPDATE ON telegram_channel_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Telegram 后台任务表（用于重启后可见、可追踪）
CREATE TABLE IF NOT EXISTS telegram_background_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL,
    chat_id BIGINT,
    kind VARCHAR(50) NOT NULL,
    source TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    params JSONB DEFAULT '{}'::jsonb,
    total_count INT DEFAULT 0,
    enqueued_count INT DEFAULT 0,
    skipped_count INT DEFAULT 0,
    duplicate_count INT DEFAULT 0,
    error TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tg_background_jobs_user_created ON telegram_background_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_background_jobs_status ON telegram_background_jobs(status);

CREATE OR REPLACE TRIGGER telegram_background_jobs_updated_at
    BEFORE UPDATE ON telegram_background_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Telegram 下载条目表（用于任务条目审计 / 失败统计）
CREATE TABLE IF NOT EXISTS telegram_download_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID REFERENCES telegram_background_jobs(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    message_id INT NOT NULL,
    grouped_id TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(job_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_download_items_job_status ON telegram_download_items(job_id, status);

CREATE OR REPLACE TRIGGER telegram_download_items_updated_at
    BEFORE UPDATE ON telegram_download_items
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
