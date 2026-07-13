import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryResult } from 'pg';
import { OAuthFlowStore, OAuthFlowError } from './oauthFlowStore.js';

type Row = {
    state_hash: string;
    provider: string;
    auth_session_hash: string;
    redirect_uri: string;
    pending_config: Record<string, unknown>;
    flow_nonce: string;
    expires_at: Date;
};

class FakeOAuthDb {
    readonly rows = new Map<string, Row>();

    async query(text: string, params: unknown[] = []): Promise<QueryResult<any>> {
        if (/CREATE TABLE|CREATE INDEX|DELETE FROM oauth_pending_flows\s+WHERE expires_at/i.test(text)) {
            return { rows: [], rowCount: 0 } as unknown as QueryResult<any>;
        }
        if (/INSERT INTO oauth_pending_flows/i.test(text)) {
            const [stateHash, provider, authSessionHash, redirectUri, pendingConfig, flowNonce, expiresAt] = params;
            this.rows.set(String(stateHash), {
                state_hash: String(stateHash),
                provider: String(provider),
                auth_session_hash: String(authSessionHash),
                redirect_uri: String(redirectUri),
                pending_config: JSON.parse(String(pendingConfig)),
                flow_nonce: String(flowNonce),
                expires_at: new Date(String(expiresAt)),
            });
            return { rows: [], rowCount: 1 } as unknown as QueryResult<any>;
        }
        if (/DELETE FROM oauth_pending_flows[\s\S]*RETURNING/i.test(text)) {
            const [stateHash, provider, authSessionHash, now] = params;
            const row = this.rows.get(String(stateHash));
            if (!row
                || row.provider !== provider
                || row.auth_session_hash !== authSessionHash
                || row.expires_at.getTime() <= new Date(String(now)).getTime()) {
                return { rows: [], rowCount: 0 } as unknown as QueryResult<any>;
            }
            this.rows.delete(String(stateHash));
            return { rows: [row], rowCount: 1 } as unknown as QueryResult<any>;
        }
        throw new Error(`Unexpected SQL: ${text}`);
    }
}

process.env.STORAGE_CREDENTIALS_SECRET = process.env.STORAGE_CREDENTIALS_SECRET || 'oauth-flow-test-storage-secret-32-bytes-minimum';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'oauth-flow-test-session-secret-independent';

function createStore(db: FakeOAuthDb, now: { value: number }, states: string[], nonces: string[]) {
    return new OAuthFlowStore({
        db: db as any,
        ttlMs: 60_000,
        now: () => now.value,
        stateFactory: () => states.shift()!,
        nonceFactory: () => nonces.shift()!,
    });
}

test('concurrent OAuth tabs retain separate immutable provider config and redirect URI', async () => {
    const db = new FakeOAuthDb();
    const now = { value: Date.parse('2026-07-13T00:00:00.000Z') };
    const store = createStore(db, now, ['state-a', 'state-b'], ['nonce-a', 'nonce-b']);

    const flowA = await store.issue({
        provider: 'onedrive',
        authSessionToken: 'session-a',
        redirectUri: 'https://api.example.test/api/storage/onedrive/callback',
        config: { clientId: 'client-a', clientSecret: 'secret-a', name: 'Account A', tenantId: 'tenant-a' },
    });
    const flowB = await store.issue({
        provider: 'onedrive',
        authSessionToken: 'session-a',
        redirectUri: 'https://api.example.test/api/storage/onedrive/callback',
        config: { clientId: 'client-b', clientSecret: 'secret-b', name: 'Account B', tenantId: 'tenant-b' },
    });

    assert.notEqual(flowA.state, flowB.state);
    const consumedB = await store.consume({ state: flowB.state, provider: 'onedrive', authSessionToken: 'session-a' });
    const consumedA = await store.consume({ state: flowA.state, provider: 'onedrive', authSessionToken: 'session-a' });
    assert.deepEqual(consumedB.config, { clientId: 'client-b', clientSecret: 'secret-b', name: 'Account B', tenantId: 'tenant-b' });
    assert.deepEqual(consumedA.config, { clientId: 'client-a', clientSecret: 'secret-a', name: 'Account A', tenantId: 'tenant-a' });
    assert.equal(consumedA.redirectUri, 'https://api.example.test/api/storage/onedrive/callback');
});

test('OAuth flow rejects wrong session without consuming the owner flow', async () => {
    const db = new FakeOAuthDb();
    const now = { value: Date.parse('2026-07-13T00:00:00.000Z') };
    const store = createStore(db, now, ['state-owner'], ['nonce-owner']);
    const flow = await store.issue({
        provider: 'google_drive',
        authSessionToken: 'owner-session',
        redirectUri: 'https://api.example.test/api/storage/google-drive/callback',
        config: { clientId: 'client', clientSecret: 'secret' },
    });

    await assert.rejects(
        store.consume({ state: flow.state, provider: 'google_drive', authSessionToken: 'other-session' }),
        (error: unknown) => error instanceof OAuthFlowError && error.code === 'OAUTH_FLOW_INVALID',
    );
    const consumed = await store.consume({ state: flow.state, provider: 'google_drive', authSessionToken: 'owner-session' });
    assert.equal(consumed.flowNonce, 'nonce-owner');
});

test('OAuth flow is one-time and expired flows are rejected', async () => {
    const db = new FakeOAuthDb();
    const now = { value: Date.parse('2026-07-13T00:00:00.000Z') };
    const store = createStore(db, now, ['state-replay', 'state-expired'], ['nonce-replay', 'nonce-expired']);
    const replay = await store.issue({
        provider: 'onedrive',
        authSessionToken: 'session',
        redirectUri: 'https://api.example.test/api/storage/onedrive/callback',
        config: { clientId: 'client' },
    });
    await store.consume({ state: replay.state, provider: 'onedrive', authSessionToken: 'session' });
    await assert.rejects(
        store.consume({ state: replay.state, provider: 'onedrive', authSessionToken: 'session' }),
        (error: unknown) => error instanceof OAuthFlowError && error.code === 'OAUTH_FLOW_INVALID',
    );

    const expired = await store.issue({
        provider: 'google_drive',
        authSessionToken: 'session',
        redirectUri: 'https://api.example.test/api/storage/google-drive/callback',
        config: { clientId: 'client', clientSecret: 'secret' },
    });
    now.value += 60_001;
    await assert.rejects(
        store.consume({ state: expired.state, provider: 'google_drive', authSessionToken: 'session' }),
        (error: unknown) => error instanceof OAuthFlowError && error.code === 'OAUTH_FLOW_INVALID',
    );
});
