-- Retire runtime schema setup; all objects are owned by the migration lifecycle.
-- Legacy ledgers allowed NULL checksums, but applied migration identities must be immutable.
ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL;

CREATE TABLE IF NOT EXISTS telegram_auth (
    user_id BIGINT PRIMARY KEY,
    authenticated_at TIMESTAMPTZ DEFAULT NOW()
);
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
DELETE FROM oauth_pending_flows older USING oauth_pending_flows newer
WHERE older.auth_session_hash = newer.auth_session_hash
  AND (older.created_at, older.state_hash) < (newer.created_at, newer.state_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_pending_flows_session ON oauth_pending_flows(auth_session_hash);
ALTER TABLE storage_accounts ADD COLUMN IF NOT EXISTS last_probe_status VARCHAR(20);
ALTER TABLE storage_accounts ADD COLUMN IF NOT EXISTS last_probe_error TEXT;
ALTER TABLE storage_accounts ADD COLUMN IF NOT EXISTS last_probed_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN IF NOT EXISTS storage_account_id UUID REFERENCES storage_accounts(id) ON DELETE CASCADE;
