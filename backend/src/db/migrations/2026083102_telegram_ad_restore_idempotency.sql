ALTER TABLE telegram_background_jobs
    ADD COLUMN IF NOT EXISTS ad_decision_id UUID REFERENCES telegram_subscription_ad_decisions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_background_jobs_ad_decision
    ON telegram_background_jobs(ad_decision_id)
    WHERE ad_decision_id IS NOT NULL;

ALTER TABLE telegram_subscription_ad_decisions
    ADD COLUMN IF NOT EXISTS restore_status VARCHAR(20) NOT NULL DEFAULT 'not_requested';
ALTER TABLE telegram_subscription_ad_decisions
    ADD COLUMN IF NOT EXISTS restore_error TEXT;
ALTER TABLE telegram_subscription_ad_decisions
    ADD COLUMN IF NOT EXISTS restore_attempted_at TIMESTAMPTZ;

DO $$ BEGIN
    ALTER TABLE telegram_subscription_ad_decisions
        ADD CONSTRAINT telegram_subscription_ad_restore_status_check
        CHECK (restore_status IN ('not_requested', 'restoring', 'restored', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
