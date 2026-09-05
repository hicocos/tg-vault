CREATE TABLE IF NOT EXISTS telegram_user_locales (
    user_id BIGINT PRIMARY KEY,
    locale VARCHAR(10) NOT NULL DEFAULT 'zh-CN' CHECK (locale IN ('zh-CN', 'en')),
    explicit BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO telegram_user_locales (user_id, locale, explicit)
SELECT user_id, 'zh-CN', FALSE FROM telegram_auth
ON CONFLICT (user_id) DO NOTHING;

DROP TRIGGER IF EXISTS telegram_user_locales_updated_at ON telegram_user_locales;
CREATE TRIGGER telegram_user_locales_updated_at
    BEFORE UPDATE ON telegram_user_locales
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
