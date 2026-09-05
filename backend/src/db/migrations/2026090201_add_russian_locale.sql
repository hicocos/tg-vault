ALTER TABLE telegram_user_locales
    DROP CONSTRAINT IF EXISTS telegram_user_locales_locale_check;

ALTER TABLE telegram_user_locales
    ADD CONSTRAINT telegram_user_locales_locale_check
    CHECK (locale IN ('zh-CN', 'en', 'ru'));
