import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/index.js';
import { decryptStorageConfig, encryptStorageConfig } from '../utils/credentialCrypto.js';

export type OAuthProvider = 'onedrive' | 'google_drive';

type OAuthFlowDb = Pick<Pool | PoolClient, 'query'>;

export interface OAuthFlowConfig extends Record<string, unknown> {
    clientId: string;
    clientSecret?: string;
    name?: string;
}

export interface OAuthPendingFlow {
    provider: OAuthProvider;
    redirectUri: string;
    config: OAuthFlowConfig;
    flowNonce: string;
    expiresAt: Date;
}

export interface OAuthFlowStoreOptions {
    db?: OAuthFlowDb;
    ttlMs?: number;
    now?: () => number;
    stateFactory?: () => string;
    nonceFactory?: () => string;
}

export class OAuthFlowError extends Error {
    readonly code = 'OAUTH_FLOW_INVALID';

    constructor() {
        super('OAuth flow 不存在、已过期、已使用或不属于当前登录会话');
        this.name = 'OAuthFlowError';
    }
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function parsePendingConfig(value: unknown): OAuthFlowConfig {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return decryptStorageConfig((parsed || {}) as OAuthFlowConfig);
}

export class OAuthFlowStore {
    private readonly db: OAuthFlowDb;
    private readonly ttlMs: number;
    private readonly now: () => number;
    private readonly stateFactory: () => string;
    private readonly nonceFactory: () => string;
    private schemaPromise: Promise<void> | null = null;

    constructor(options: OAuthFlowStoreOptions = {}) {
        this.db = options.db ?? pool;
        this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
        this.now = options.now ?? (() => Date.now());
        this.stateFactory = options.stateFactory ?? (() => crypto.randomBytes(32).toString('base64url'));
        this.nonceFactory = options.nonceFactory ?? (() => crypto.randomBytes(24).toString('base64url'));
    }

    private async ensureSchema(): Promise<void> {
        if (!this.schemaPromise) {
            this.schemaPromise = (async () => {
                await this.db.query(`
                    CREATE TABLE IF NOT EXISTS oauth_pending_flows (
                        state_hash VARCHAR(64) PRIMARY KEY,
                        provider VARCHAR(32) NOT NULL,
                        auth_session_hash VARCHAR(64) NOT NULL,
                        redirect_uri TEXT NOT NULL,
                        pending_config JSONB NOT NULL,
                        flow_nonce VARCHAR(128) NOT NULL,
                        expires_at TIMESTAMPTZ NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                `);
                await this.db.query('CREATE INDEX IF NOT EXISTS idx_oauth_pending_flows_expiry ON oauth_pending_flows(expires_at)');
            })().catch(error => {
                this.schemaPromise = null;
                throw error;
            });
        }
        await this.schemaPromise;
    }

    async issue(input: {
        provider: OAuthProvider;
        authSessionToken: string;
        redirectUri: string;
        config: OAuthFlowConfig;
    }): Promise<{ state: string; flowNonce: string; expiresAt: Date }> {
        await this.ensureSchema();
        const state = this.stateFactory();
        const flowNonce = this.nonceFactory();
        const expiresAt = new Date(this.now() + this.ttlMs);
        const encryptedConfig = encryptStorageConfig({ ...input.config });
        await this.db.query('DELETE FROM oauth_pending_flows WHERE expires_at <= $1', [new Date(this.now())]);
        await this.db.query(
            `INSERT INTO oauth_pending_flows
                (state_hash, provider, auth_session_hash, redirect_uri, pending_config, flow_nonce, expires_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            [
                sha256(state),
                input.provider,
                sha256(input.authSessionToken),
                input.redirectUri,
                JSON.stringify(encryptedConfig),
                flowNonce,
                expiresAt,
            ],
        );
        return { state, flowNonce, expiresAt };
    }

    async consume(input: {
        state: string;
        provider: OAuthProvider;
        authSessionToken: string;
    }): Promise<OAuthPendingFlow> {
        await this.ensureSchema();
        const result = await this.db.query(
            `DELETE FROM oauth_pending_flows
             WHERE state_hash = $1
               AND provider = $2
               AND auth_session_hash = $3
               AND expires_at > $4
             RETURNING provider, redirect_uri, pending_config, flow_nonce, expires_at`,
            [sha256(input.state), input.provider, sha256(input.authSessionToken), new Date(this.now())],
        );
        if (result.rowCount !== 1 || !result.rows[0]) throw new OAuthFlowError();
        const row = result.rows[0];
        return {
            provider: row.provider,
            redirectUri: row.redirect_uri,
            config: parsePendingConfig(row.pending_config),
            flowNonce: row.flow_nonce,
            expiresAt: new Date(row.expires_at),
        };
    }
}

export const oauthFlowStore = new OAuthFlowStore();
