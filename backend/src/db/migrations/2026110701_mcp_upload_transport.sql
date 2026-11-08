ALTER TABLE mcp_uploads
    ADD COLUMN ticket_expires_at timestamptz,
    ADD COLUMN expected_sha256 text,
    ADD COLUMN content_sha256 text,
    ADD CONSTRAINT mcp_uploads_expected_sha256_check
        CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT mcp_uploads_content_sha256_check
        CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$');
