-- Canonical migration ledger. Version 2026082401 is the idempotent expand schema below.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum VARCHAR(64),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
DELETE FROM oauth_pending_flows older
USING oauth_pending_flows newer
WHERE older.auth_session_hash = newer.auth_session_hash
  AND (older.created_at, older.state_hash) < (newer.created_at, newer.state_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_pending_flows_session ON oauth_pending_flows(auth_session_hash);

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
    derivative_status VARCHAR(20) NOT NULL DEFAULT 'not_required' CHECK (derivative_status IN ('queued', 'processing', 'ready', 'failed', 'not_required')),
    derivative_error TEXT,
    derivative_source_path VARCHAR(1000),
    derivative_cleanup_source BOOLEAN NOT NULL DEFAULT FALSE,
    derivative_attempts INT NOT NULL DEFAULT 0,
    derivative_started_at TIMESTAMPTZ,
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
ALTER TABLE files ADD COLUMN IF NOT EXISTS derivative_status VARCHAR(20) NOT NULL DEFAULT 'not_required';
ALTER TABLE files ADD COLUMN IF NOT EXISTS derivative_error TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS derivative_source_path VARCHAR(1000);
ALTER TABLE files ADD COLUMN IF NOT EXISTS derivative_cleanup_source BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE files ADD COLUMN IF NOT EXISTS derivative_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN IF NOT EXISTS derivative_started_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_files_derivative_pending ON files(derivative_status, created_at, id) WHERE derivative_status IN ('queued', 'processing');

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

-- 已通过 Telegram Bot PIN 身份验证的用户。
CREATE TABLE IF NOT EXISTS telegram_auth (
    user_id BIGINT PRIMARY KEY,
    authenticated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 新版本通知投递状态：每位收件人、每个版本、每个渠道最多成功投递一次。
CREATE TABLE IF NOT EXISTS update_notification_deliveries (
    version VARCHAR(64) NOT NULL,
    channel VARCHAR(32) NOT NULL,
    recipient_id VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (version, channel, recipient_id),
    CHECK (status IN ('pending', 'sending', 'delivered', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_update_notification_pending
    ON update_notification_deliveries (status, last_attempt_at)
    WHERE status <> 'delivered';

DROP TRIGGER IF EXISTS update_notification_deliveries_updated_at ON update_notification_deliveries;
CREATE TRIGGER update_notification_deliveries_updated_at
    BEFORE UPDATE ON update_notification_deliveries
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

-- 每聊天的下一次/会话级存储目标；不会切换系统全局默认。
CREATE TABLE IF NOT EXISTS telegram_target_states (
    chat_id TEXT NOT NULL,
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('once', 'session')),
    provider VARCHAR(50) NOT NULL,
    account_id UUID REFERENCES storage_accounts(id) ON DELETE RESTRICT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chat_id, mode),
    CHECK ((provider = 'local' AND account_id IS NULL) OR (provider <> 'local' AND account_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_telegram_target_states_expiry ON telegram_target_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_telegram_target_states_account ON telegram_target_states(account_id) WHERE account_id IS NOT NULL;
CREATE OR REPLACE TRIGGER telegram_target_states_updated_at
    BEFORE UPDATE ON telegram_target_states
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
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS next_scan_at TIMESTAMPTZ;
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS target_mode VARCHAR(20) NOT NULL DEFAULT 'follow_global';
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS target_provider VARCHAR(50);
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS target_account_id UUID REFERENCES storage_accounts(id) ON DELETE RESTRICT;
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS ad_filter_mode VARCHAR(20) NOT NULL DEFAULT 'off';
DO $$ BEGIN
    ALTER TABLE telegram_channel_subscriptions ADD CONSTRAINT telegram_subscription_ad_filter_mode_check CHECK (ad_filter_mode IN ('off', 'conservative', 'aggressive'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE telegram_channel_subscriptions ADD CONSTRAINT telegram_subscription_target_mode_check CHECK (target_mode IN ('follow_global', 'fixed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_tg_channel_subscriptions_target_account ON telegram_channel_subscriptions(target_account_id) WHERE target_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS telegram_subscription_ad_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES telegram_channel_subscriptions(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('keyword', 'domain', 'username', 'template', 'media')),
    action VARCHAR(10) NOT NULL CHECK (action IN ('allow', 'block')),
    pattern TEXT NOT NULL,
    label TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_subscription_ad_rules_unique ON telegram_subscription_ad_rules(subscription_id, kind, action, pattern);
CREATE INDEX IF NOT EXISTS idx_tg_subscription_ad_rules_subscription ON telegram_subscription_ad_rules(subscription_id, enabled, created_at DESC);
DROP TRIGGER IF EXISTS telegram_subscription_ad_rules_updated_at ON telegram_subscription_ad_rules;
CREATE TRIGGER telegram_subscription_ad_rules_updated_at BEFORE UPDATE ON telegram_subscription_ad_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER telegram_channel_subscriptions_updated_at
    BEFORE UPDATE ON telegram_channel_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS telegram_user_locales (
    user_id BIGINT PRIMARY KEY,
    locale VARCHAR(10) NOT NULL DEFAULT 'zh-CN' CHECK (locale IN ('zh-CN', 'en', 'ru')),
    explicit BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE TRIGGER telegram_user_locales_updated_at
    BEFORE UPDATE ON telegram_user_locales
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS telegram_notification_preferences (
    user_id BIGINT NOT NULL,
    chat_id TEXT NOT NULL,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, chat_id)
);
CREATE OR REPLACE TRIGGER telegram_notification_preferences_updated_at
    BEFORE UPDATE ON telegram_notification_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS telegram_notification_digest (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL,
    chat_id VARCHAR(80) NOT NULL,
    kind VARCHAR(40) NOT NULL,
    payload JSONB NOT NULL,
    claimed_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE telegram_notification_digest ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_telegram_notification_digest_pending ON telegram_notification_digest(user_id, chat_id, created_at) WHERE delivered_at IS NULL;

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

CREATE TABLE IF NOT EXISTS telegram_subscription_ad_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES telegram_channel_subscriptions(id) ON DELETE CASCADE,
    source_peer TEXT NOT NULL,
    message_id INT NOT NULL,
    grouped_id TEXT,
    message_ids INT[] NOT NULL DEFAULT '{}',
    decision VARCHAR(20) NOT NULL CHECK (decision IN ('allow', 'review', 'blocked')),
    score INT NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
    reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    text_excerpt TEXT,
    text_fingerprint TEXT,
    domains TEXT[] NOT NULL DEFAULT '{}',
    usernames TEXT[] NOT NULL DEFAULT '{}',
    media_keys TEXT[] NOT NULL DEFAULT '{}',
    matched_rule_ids UUID[] NOT NULL DEFAULT '{}',
    manual_label VARCHAR(20) CHECK (manual_label IN ('ad', 'normal')),
    manually_reviewed_at TIMESTAMPTZ,
    restored_job_id UUID REFERENCES telegram_background_jobs(id) ON DELETE SET NULL,
    restored_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(subscription_id, source_peer, message_id)
);
CREATE INDEX IF NOT EXISTS idx_tg_subscription_ad_decisions_subscription ON telegram_subscription_ad_decisions(subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_subscription_ad_decisions_blocked ON telegram_subscription_ad_decisions(subscription_id, decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_subscription_ad_decisions_template ON telegram_subscription_ad_decisions(subscription_id, manual_label, created_at DESC) WHERE manual_label IS NOT NULL;
DROP TRIGGER IF EXISTS telegram_subscription_ad_decisions_updated_at ON telegram_subscription_ad_decisions;
CREATE TRIGGER telegram_subscription_ad_decisions_updated_at BEFORE UPDATE ON telegram_subscription_ad_decisions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
ALTER TABLE telegram_background_jobs ADD COLUMN IF NOT EXISTS ad_decision_id UUID REFERENCES telegram_subscription_ad_decisions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_background_jobs_ad_decision ON telegram_background_jobs(ad_decision_id) WHERE ad_decision_id IS NOT NULL;
ALTER TABLE telegram_subscription_ad_decisions ADD COLUMN IF NOT EXISTS restore_status VARCHAR(20) NOT NULL DEFAULT 'not_requested';
ALTER TABLE telegram_subscription_ad_decisions ADD COLUMN IF NOT EXISTS restore_error TEXT;
ALTER TABLE telegram_subscription_ad_decisions ADD COLUMN IF NOT EXISTS restore_attempted_at TIMESTAMPTZ;
DO $$ BEGIN
    ALTER TABLE telegram_subscription_ad_decisions ADD CONSTRAINT telegram_subscription_ad_restore_status_check CHECK (restore_status IN ('not_requested', 'restoring', 'restored', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

-- 多 Telegram 用户账号、来源权限和账号级下载尝试。
CREATE TABLE IF NOT EXISTS telegram_user_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_user_id TEXT NOT NULL UNIQUE,
    username TEXT,
    display_name TEXT,
    session_ciphertext TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    health_state VARCHAR(24) NOT NULL DEFAULT 'healthy'
        CHECK (health_state IN ('healthy', 'degraded', 'session_expired')),
    cooldown_until TIMESTAMPTZ,
    weight NUMERIC(8, 3) NOT NULL DEFAULT 1 CHECK (weight > 0),
    priority INT NOT NULL DEFAULT 0,
    max_connections INT NOT NULL DEFAULT 4 CHECK (max_connections > 0),
    last_error TEXT,
    last_connected_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    session_expired_at TIMESTAMPTZ,
    is_legacy BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telegram_user_accounts_schedulable
    ON telegram_user_accounts(enabled, health_state, cooldown_until, priority DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_user_accounts_visible
    ON telegram_user_accounts(created_at, id) WHERE deleted_at IS NULL;
CREATE OR REPLACE TRIGGER telegram_user_accounts_updated_at
    BEFORE UPDATE ON telegram_user_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS telegram_account_source_access (
    account_id UUID NOT NULL REFERENCES telegram_user_accounts(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    scope VARCHAR(20) NOT NULL DEFAULT 'download'
        CHECK (scope IN ('download', 'scan', 'metadata')),
    access_state VARCHAR(20) NOT NULL DEFAULT 'unknown'
        CHECK (access_state IN ('unknown', 'allowed', 'denied')),
    last_error TEXT,
    checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, source_key, scope)
);
CREATE INDEX IF NOT EXISTS idx_telegram_account_source_access_lookup
    ON telegram_account_source_access(source_key, scope, access_state, checked_at DESC);
CREATE OR REPLACE TRIGGER telegram_account_source_access_updated_at
    BEFORE UPDATE ON telegram_account_source_access
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE telegram_background_jobs
    ADD COLUMN IF NOT EXISTS assigned_account_id UUID REFERENCES telegram_user_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tg_background_jobs_assigned_account
    ON telegram_background_jobs(assigned_account_id, status);

CREATE TABLE IF NOT EXISTS telegram_download_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES telegram_user_accounts(id) ON DELETE RESTRICT,
    source_key TEXT NOT NULL,
    scope VARCHAR(20) NOT NULL DEFAULT 'download'
        CHECK (scope IN ('download', 'scan', 'metadata')),
    job_id UUID REFERENCES telegram_background_jobs(id) ON DELETE SET NULL,
    item_id UUID REFERENCES telegram_download_items(id) ON DELETE SET NULL,
    lease_token UUID,
    status VARCHAR(20) NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    CHECK ((status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_telegram_download_attempts_account_started
    ON telegram_download_attempts(account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_download_attempts_job_item
    ON telegram_download_attempts(job_id, item_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_download_attempts_running
    ON telegram_download_attempts(account_id, source_key) WHERE status = 'running';
