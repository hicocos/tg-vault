ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS file_filter_mode TEXT NOT NULL DEFAULT 'all';
ALTER TABLE telegram_channel_subscriptions ADD COLUMN IF NOT EXISTS file_filter_types TEXT[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
    ALTER TABLE telegram_channel_subscriptions ADD CONSTRAINT telegram_subscription_file_filter_mode_check
        CHECK (file_filter_mode IN ('all', 'include', 'exclude'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE telegram_channel_subscriptions ADD CONSTRAINT telegram_subscription_file_filter_types_check
        CHECK (file_filter_types <@ ARRAY['images', 'raw-images', 'videos', 'audio', 'archives', 'apps',
            'text', 'word-docs', 'pdfs', 'spreadsheets', 'presentations', 'ebooks',
            'code', 'fonts', 'design', 'torrents', 'documents', 'other']::text[]
            AND array_position(file_filter_types, NULL) IS NULL
            AND ((file_filter_mode = 'all' AND cardinality(file_filter_types) = 0)
                OR (file_filter_mode IN ('include', 'exclude') AND cardinality(file_filter_types) > 0)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
