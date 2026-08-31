ALTER TABLE telegram_channel_subscriptions
    ADD COLUMN IF NOT EXISTS ad_filter_mode VARCHAR(20) NOT NULL DEFAULT 'off';

DO $$ BEGIN
    ALTER TABLE telegram_channel_subscriptions
        ADD CONSTRAINT telegram_subscription_ad_filter_mode_check
        CHECK (ad_filter_mode IN ('off', 'conservative', 'aggressive'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_subscription_ad_rules_unique
    ON telegram_subscription_ad_rules(subscription_id, kind, action, pattern);
CREATE INDEX IF NOT EXISTS idx_tg_subscription_ad_rules_subscription
    ON telegram_subscription_ad_rules(subscription_id, enabled, created_at DESC);

DROP TRIGGER IF EXISTS telegram_subscription_ad_rules_updated_at ON telegram_subscription_ad_rules;
CREATE TRIGGER telegram_subscription_ad_rules_updated_at
    BEFORE UPDATE ON telegram_subscription_ad_rules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

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

CREATE INDEX IF NOT EXISTS idx_tg_subscription_ad_decisions_subscription
    ON telegram_subscription_ad_decisions(subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_subscription_ad_decisions_blocked
    ON telegram_subscription_ad_decisions(subscription_id, decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_subscription_ad_decisions_template
    ON telegram_subscription_ad_decisions(subscription_id, manual_label, created_at DESC)
    WHERE manual_label IS NOT NULL;

DROP TRIGGER IF EXISTS telegram_subscription_ad_decisions_updated_at ON telegram_subscription_ad_decisions;
CREATE TRIGGER telegram_subscription_ad_decisions_updated_at
    BEFORE UPDATE ON telegram_subscription_ad_decisions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
