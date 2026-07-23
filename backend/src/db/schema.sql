-- TG Vault 数据库表结构

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
ALTER TABLE storage_accounts ADD COLUMN IF NOT EXISTS last_probe_status VARCHAR(20);
ALTER TABLE storage_accounts ADD COLUMN IF NOT EXISTS last_probe_error TEXT;
ALTER TABLE storage_accounts ADD COLUMN IF NOT EXISTS last_probed_at TIMESTAMPTZ;

CREATE OR REPLACE TRIGGER storage_accounts_updated_at
    BEFORE UPDATE ON storage_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- 存储账户使用租约：上传等外部副作用在账户删除期间必须持有未释放租约。
CREATE TABLE IF NOT EXISTS storage_account_leases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    storage_account_id UUID NOT NULL REFERENCES storage_accounts(id) ON DELETE CASCADE,
    purpose VARCHAR(50) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE storage_account_leases DROP CONSTRAINT IF EXISTS storage_account_leases_storage_account_id_fkey;
ALTER TABLE storage_account_leases ADD CONSTRAINT storage_account_leases_storage_account_id_fkey
    FOREIGN KEY (storage_account_id) REFERENCES storage_accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_storage_account_leases_active
    ON storage_account_leases(storage_account_id, expires_at)
    WHERE released_at IS NULL;

-- OAuth pending flow records are hashed/session-bound, encrypted-config, TTL and one-time consumed.
CREATE TABLE IF NOT EXISTS oauth_pending_flows (
    state_hash VARCHAR(64) PRIMARY KEY,
    provider VARCHAR(32) NOT NULL,
    auth_session_hash VARCHAR(64) NOT NULL,
    redirect_uri TEXT NOT NULL,
    pending_config JSONB NOT NULL,
    flow_nonce VARCHAR(128) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oauth_pending_flows_expiry ON oauth_pending_flows(expires_at);

-- 存储账户冷却表（如 Google Drive 每日上传限额触发后暂停 24 小时）
CREATE TABLE IF NOT EXISTS storage_account_cooldowns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    storage_account_id UUID REFERENCES storage_accounts(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    reason VARCHAR(100) NOT NULL,
    cooldown_until TIMESTAMPTZ NOT NULL,
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(storage_account_id, provider, reason)
);

CREATE INDEX IF NOT EXISTS idx_storage_account_cooldowns_until ON storage_account_cooldowns(cooldown_until);

CREATE OR REPLACE TRIGGER storage_account_cooldowns_updated_at
    BEFORE UPDATE ON storage_account_cooldowns
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
    preview_path VARCHAR(500),
    width INT,
    height INT,
    source VARCHAR(50) DEFAULT 'web',
    folder VARCHAR(255),
    storage_account_id UUID REFERENCES storage_accounts(id) ON DELETE CASCADE,
    is_favorite BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_files_type ON files(type);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
CREATE INDEX IF NOT EXISTS idx_files_is_favorite ON files(is_favorite);
CREATE INDEX IF NOT EXISTS idx_files_storage_account_id ON files(storage_account_id);
CREATE INDEX IF NOT EXISTS idx_files_account_created ON files(storage_account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_files_source_created ON files(source, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_files_account_fav_created ON files(storage_account_id, is_favorite, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_files_source_fav_created ON files(source, is_favorite, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_files_account_folder_created ON files(storage_account_id, folder, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_files_source_folder_created ON files(source, folder, created_at DESC, id DESC);
ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_path VARCHAR(500);

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

-- 持久 Web 会话（仅存 token SHA-256，不存原始 token）
CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);

-- 持久、可恢复的分块上传会话。owner_id 是认证 token 的 SHA-256，不保存原始凭据。
CREATE TABLE IF NOT EXISTS chunk_upload_sessions (
    upload_id UUID PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    folder VARCHAR(255),
    total_size BIGINT NOT NULL CHECK (total_size > 0),
    total_chunks INT NOT NULL CHECK (total_chunks > 0),
    received_bytes BIGINT NOT NULL DEFAULT 0 CHECK (received_bytes >= 0 AND received_bytes <= total_size),
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completing', 'completed', 'cancelled', 'failed')),
    target_provider VARCHAR(50) NOT NULL,
    target_account_id UUID REFERENCES storage_accounts(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    completion_token UUID,
    completion_expires_at TIMESTAMPTZ,
    completed_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE chunk_upload_sessions ADD COLUMN IF NOT EXISTS completion_expires_at TIMESTAMPTZ;
ALTER TABLE chunk_upload_sessions DROP CONSTRAINT IF EXISTS chunk_upload_sessions_target_account_id_fkey;
ALTER TABLE chunk_upload_sessions ADD CONSTRAINT chunk_upload_sessions_target_account_id_fkey
    FOREIGN KEY (target_account_id) REFERENCES storage_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_upload_sessions_owner ON chunk_upload_sessions(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunk_upload_sessions_budget ON chunk_upload_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_chunk_upload_sessions_completion_lease ON chunk_upload_sessions(status, completion_expires_at);

CREATE TABLE IF NOT EXISTS chunk_upload_chunks (
    upload_id UUID NOT NULL REFERENCES chunk_upload_sessions(upload_id) ON DELETE CASCADE,
    chunk_index INT NOT NULL CHECK (chunk_index >= 0),
    size BIGINT NOT NULL CHECK (size > 0),
    sha256 VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    path VARCHAR(1000) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (upload_id, chunk_index)
);

-- 永久对象/文件索引补偿出现不确定结果时的持久对账证据。
CREATE TABLE IF NOT EXISTS chunk_upload_reconciliations (
    operation_id UUID PRIMARY KEY,
    upload_id UUID NOT NULL REFERENCES chunk_upload_sessions(upload_id) ON DELETE CASCADE,
    completion_token UUID NOT NULL,
    provider VARCHAR(50) NOT NULL,
    account_id UUID REFERENCES storage_accounts(id) ON DELETE SET NULL,
    stored_path VARCHAR(2000),
    file_id UUID,
    object_state VARCHAR(20) NOT NULL CHECK (object_state IN ('unknown', 'present', 'deleted')),
    index_state VARCHAR(20) NOT NULL CHECK (index_state IN ('unknown', 'present', 'deleted')),
    reason TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE chunk_upload_reconciliations ALTER COLUMN stored_path DROP NOT NULL;
ALTER TABLE chunk_upload_reconciliations ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE chunk_upload_reconciliations DROP CONSTRAINT IF EXISTS chunk_upload_reconciliations_upload_id_fkey;
ALTER TABLE chunk_upload_reconciliations ADD CONSTRAINT chunk_upload_reconciliations_upload_id_fkey
    FOREIGN KEY (upload_id) REFERENCES chunk_upload_sessions(upload_id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_chunk_upload_reconciliations_pending
    ON chunk_upload_reconciliations(status, created_at);
ALTER TABLE chunk_upload_reconciliations ADD COLUMN IF NOT EXISTS resolution VARCHAR(30);
ALTER TABLE chunk_upload_reconciliations ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE chunk_upload_reconciliations ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE chunk_upload_reconciliations ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_chunk_upload_reconciliations_claim
    ON chunk_upload_reconciliations(status, lease_expires_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunk_upload_reconciliations_pending_completion
    ON chunk_upload_reconciliations(upload_id, completion_token) WHERE status = 'pending';

CREATE OR REPLACE TRIGGER chunk_upload_sessions_updated_at
    BEFORE UPDATE ON chunk_upload_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Cross-entry-point task records. Channel jobs and browser chunk sessions retain
-- their specialized tables, while this table persists ordinary Bot and yt-dlp tasks.
CREATE TABLE IF NOT EXISTS transfer_tasks (
    source_type VARCHAR(30) NOT NULL,
    id VARCHAR(128) NOT NULL,
    kind VARCHAR(50) NOT NULL,
    title TEXT NOT NULL,
    status VARCHAR(30) NOT NULL,
    stage VARCHAR(50) NOT NULL DEFAULT 'waiting',
    progress NUMERIC(5,2) NOT NULL DEFAULT 0,
    owner_user_id BIGINT,
    chat_id TEXT,
    source TEXT,
    target_provider VARCHAR(50),
    target_account_id UUID REFERENCES storage_accounts(id) ON DELETE SET NULL,
    target_folder TEXT,
    total_items INT NOT NULL DEFAULT 0,
    completed_items INT NOT NULL DEFAULT 0,
    failed_items INT NOT NULL DEFAULT 0,
    total_bytes BIGINT NOT NULL DEFAULT 0,
    transferred_bytes BIGINT NOT NULL DEFAULT 0,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT,
    retryable BOOLEAN NOT NULL DEFAULT false,
    cancel_requested BOOLEAN NOT NULL DEFAULT false,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_type, id)
);
CREATE INDEX IF NOT EXISTS idx_transfer_tasks_updated ON transfer_tasks(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_tasks_status ON transfer_tasks(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_tasks_owner ON transfer_tasks(owner_user_id, chat_id, updated_at DESC);
ALTER TABLE transfer_tasks ADD COLUMN IF NOT EXISTS execution_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE transfer_tasks ADD COLUMN IF NOT EXISTS snapshot_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE transfer_tasks ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE transfer_tasks ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_transfer_tasks_claim ON transfer_tasks(source_type, status, lease_expires_at, updated_at);

-- Task-center dismissals hide only an exact terminal snapshot. Source rows and files remain untouched.
CREATE TABLE IF NOT EXISTS task_center_dismissals (
    source_type VARCHAR(30) NOT NULL,
    task_id VARCHAR(128) NOT NULL,
    task_updated_at TIMESTAMPTZ NOT NULL,
    dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_type, task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_center_dismissals_version
    ON task_center_dismissals(source_type, task_id, task_updated_at);

CREATE TABLE IF NOT EXISTS ytdlp_write_reconciliations (
    operation_id UUID PRIMARY KEY,
    source_type VARCHAR(30) NOT NULL DEFAULT 'ytdlp' CHECK (source_type = 'ytdlp'),
    task_id VARCHAR(128) NOT NULL,
    execution_generation BIGINT NOT NULL,
    task_lease_token UUID NOT NULL,
    provider VARCHAR(50) NOT NULL,
    account_id UUID REFERENCES storage_accounts(id) ON DELETE SET NULL,
    stored_path VARCHAR(2000),
    file_id UUID,
    object_state VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK (object_state IN ('unknown', 'present', 'deleted')),
    index_state VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK (index_state IN ('unknown', 'present', 'deleted')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    resolution VARCHAR(30),
    reason TEXT NOT NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (source_type, task_id) REFERENCES transfer_tasks(source_type, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ytdlp_reconciliation_pending_task
    ON ytdlp_write_reconciliations(task_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ytdlp_reconciliation_status
    ON ytdlp_write_reconciliations(status, created_at);

CREATE OR REPLACE TRIGGER transfer_tasks_updated_at
    BEFORE UPDATE ON transfer_tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- 持久化 Telegram /p（下一次）和 /ps（会话）路径状态。
CREATE TABLE IF NOT EXISTS telegram_path_states (
    chat_id TEXT NOT NULL,
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('once', 'session')),
    folder TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chat_id, mode)
);
CREATE INDEX IF NOT EXISTS idx_telegram_path_states_expiry ON telegram_path_states(expires_at);

CREATE OR REPLACE TRIGGER telegram_path_states_updated_at
    BEFORE UPDATE ON telegram_path_states
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Telegram 频道订阅表
CREATE TABLE IF NOT EXISTS telegram_channel_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL,
    chat_id BIGINT,
    source TEXT NOT NULL,
    source_original TEXT,
    source_type TEXT DEFAULT 'public',
    title TEXT,
    last_message_id INT DEFAULT 0,
    folder_override TEXT,
    enabled BOOLEAN DEFAULT true,
    disabled_reason TEXT,
    disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, source)
);

CREATE INDEX IF NOT EXISTS idx_tg_channel_subscriptions_enabled ON telegram_channel_subscriptions(enabled);
CREATE INDEX IF NOT EXISTS idx_tg_channel_subscriptions_user_id ON telegram_channel_subscriptions(user_id);
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS source_original TEXT;
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'public';
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS folder_override TEXT;
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ;
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS last_result JSONB;

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
    scan_status TEXT DEFAULT 'pending',
    download_status TEXT DEFAULT 'pending',
    scan_cursor JSONB DEFAULT '{}'::jsonb,
    cooldown_until TIMESTAMPTZ,
    paused_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
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
ALTER TABLE telegram_background_jobs ADD COLUMN IF NOT EXISTS scan_status TEXT DEFAULT 'pending';
ALTER TABLE telegram_background_jobs ADD COLUMN IF NOT EXISTS download_status TEXT DEFAULT 'pending';
ALTER TABLE telegram_background_jobs ADD COLUMN IF NOT EXISTS scan_cursor JSONB DEFAULT '{}'::jsonb;
ALTER TABLE telegram_background_jobs ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;
ALTER TABLE telegram_background_jobs ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE telegram_background_jobs ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tg_background_jobs_pipeline ON telegram_background_jobs(status, scan_status, download_status);
CREATE INDEX IF NOT EXISTS idx_tg_background_jobs_cooldown ON telegram_background_jobs(cooldown_until);

CREATE OR REPLACE TRIGGER telegram_background_jobs_updated_at
    BEFORE UPDATE ON telegram_background_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Telegram 下载条目表（用于任务条目审计 / 失败统计）
CREATE TABLE IF NOT EXISTS telegram_download_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID REFERENCES telegram_background_jobs(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_peer TEXT,
    origin TEXT DEFAULT 'channel',
    message_id INT NOT NULL,
    grouped_id TEXT,
    shared_caption TEXT,
    group_index INT,
    group_size INT,
    channel_post_id INT,
    file_name TEXT,
    mime_type TEXT,
    generated_name BOOLEAN DEFAULT false,
    total_size BIGINT DEFAULT 0,
    folder_override TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INT DEFAULT 0,
    error TEXT,
    last_error TEXT,
    locked_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(job_id, message_id)
);

ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS source_peer TEXT;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS grouped_id TEXT;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS shared_caption TEXT;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS group_index INT;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS group_size INT;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT 'channel';
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS channel_post_id INT;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS generated_name BOOLEAN DEFAULT false;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS total_size BIGINT DEFAULT 0;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS folder_override TEXT;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE telegram_download_items ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
UPDATE telegram_download_items SET source_peer = COALESCE(source_peer, source) WHERE source_peer IS NULL;
ALTER TABLE telegram_download_items DROP CONSTRAINT IF EXISTS telegram_download_items_job_id_message_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_download_items_job_peer_msg
    ON telegram_download_items(job_id, source_peer, message_id);
CREATE INDEX IF NOT EXISTS idx_tg_download_items_job_status ON telegram_download_items(job_id, status);
CREATE INDEX IF NOT EXISTS idx_tg_download_items_recover ON telegram_download_items(status, locked_at);
CREATE INDEX IF NOT EXISTS idx_tg_download_items_lease_expiry ON telegram_download_items(status, lease_expires_at);

-- Telegram provider save/index 与 child settlement 的 write-ahead 对账 journal。
CREATE TABLE IF NOT EXISTS telegram_write_reconciliations (
    operation_id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES telegram_background_jobs(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES telegram_download_items(id) ON DELETE CASCADE,
    child_lease_token UUID NOT NULL,
    provider VARCHAR(50) NOT NULL,
    account_id UUID REFERENCES storage_accounts(id) ON DELETE SET NULL,
    stored_path VARCHAR(2000),
    file_id UUID,
    object_state VARCHAR(20) NOT NULL CHECK (object_state IN ('unknown', 'present', 'deleted')),
    index_state VARCHAR(20) NOT NULL CHECK (index_state IN ('unknown', 'present', 'deleted')),
    reason TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    resolution VARCHAR(30),
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE telegram_write_reconciliations ADD COLUMN IF NOT EXISTS resolution VARCHAR(30);
ALTER TABLE telegram_write_reconciliations ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE telegram_write_reconciliations ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE telegram_write_reconciliations ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_tg_write_reconciliations_claim
    ON telegram_write_reconciliations(status, lease_expires_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_write_reconciliations_pending_item
    ON telegram_write_reconciliations(item_id) WHERE status = 'pending';

CREATE OR REPLACE TRIGGER telegram_download_items_updated_at
    BEFORE UPDATE ON telegram_download_items
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
