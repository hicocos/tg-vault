CREATE TABLE mcp_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    permissions text[] NOT NULL,
    storage_ids text[] NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

CREATE TABLE mcp_requests (
    client_id uuid NOT NULL REFERENCES mcp_clients(id),
    request_id text NOT NULL,
    tool text NOT NULL,
    storage_id text NOT NULL,
    input_hash text NOT NULL,
    status text NOT NULL CHECK (status IN ('running','completed','failed','interrupted')),
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, request_id)
);

CREATE TABLE mcp_confirmations (
    token_hash text PRIMARY KEY,
    client_id uuid NOT NULL REFERENCES mcp_clients(id),
    tool text NOT NULL,
    storage_id text NOT NULL,
    input_hash text NOT NULL,
    preview_hash text NOT NULL,
    expires_at timestamptz NOT NULL
);

CREATE TABLE mcp_media_links (
    token_hash text PRIMARY KEY,
    client_id uuid NOT NULL REFERENCES mcp_clients(id),
    file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    storage_id text NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('download','preview','thumbnail')),
    expires_at timestamptz NOT NULL
);

CREATE TABLE mcp_audit (
    id bigserial PRIMARY KEY,
    client_id uuid REFERENCES mcp_clients(id),
    tool text NOT NULL,
    storage_id text,
    status text NOT NULL,
    code text,
    duration_ms integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_audit_created_idx ON mcp_audit (created_at DESC, id DESC);
CREATE INDEX mcp_audit_client_idx ON mcp_audit (client_id, created_at DESC);
CREATE INDEX mcp_confirmations_expiry_idx ON mcp_confirmations (expires_at);
CREATE INDEX mcp_media_links_expiry_idx ON mcp_media_links (expires_at);

CREATE TABLE mcp_uploads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES mcp_clients(id),
    request_id text NOT NULL,
    storage_id text NOT NULL,
    filename text NOT NULL,
    mime_type text NOT NULL,
    size bigint NOT NULL CHECK (size >= 0),
    folder text,
    token_hash text NOT NULL,
    status text NOT NULL,
    received_bytes bigint NOT NULL DEFAULT 0,
    transferred_bytes bigint NOT NULL DEFAULT 0,
    stored_path text,
    stored_name text,
    resolved_folder text,
    result jsonb,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (client_id, request_id)
);
CREATE INDEX mcp_uploads_client_idx ON mcp_uploads (client_id, storage_id, created_at DESC);
CREATE TABLE mcp_file_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES mcp_clients(id),
    request_id text NOT NULL,
    storage_id text NOT NULL,
    operation text NOT NULL,
    items jsonb NOT NULL,
    results jsonb NOT NULL DEFAULT '[]',
    status text NOT NULL,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (client_id, request_id)
);
CREATE INDEX mcp_file_batches_client_idx ON mcp_file_batches (client_id, storage_id, created_at DESC);
CREATE UNIQUE INDEX telegram_jobs_mcp_request_idx
    ON telegram_background_jobs ((params->>'mcpClientId'), (params->>'mcpRequestId'))
    WHERE params ? 'mcpClientId';
