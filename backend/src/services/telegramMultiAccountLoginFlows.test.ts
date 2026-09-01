import assert from 'node:assert/strict';
import test from 'node:test';
import {
    TelegramMultiAccountLoginFlows,
    TelegramUserLoginFlowError,
    type TelegramMultiAccountLoginClient,
    type TelegramQrExportResult,
} from './telegramMultiAccountLoginFlows.js';

type QrHandler = () => void | Promise<void>;

class FakeClient implements TelegramMultiAccountLoginClient {
    disconnects = 0;
    destroys = 0;
    qrHandler: QrHandler | null = null;
    qrResults: TelegramQrExportResult[] = [];
    phoneCodeResult: 'authorized' | 'password_needed' = 'authorized';
    passwordError: Error | null = null;
    me = { id: '42', username: 'vault_owner', firstName: 'Vault', lastName: 'Owner' };

    async connect(): Promise<void> {}
    async sendCode(_credentials: unknown, phone: string) {
        assert.equal(phone, '+8613800138000');
        return { phoneCodeHash: 'server-only-hash', isCodeViaApp: true };
    }
    async signInCode(_phone: string, hash: string, code: string) {
        assert.equal(hash, 'server-only-hash');
        if (code === '00000') throw new Error('PHONE_CODE_INVALID');
        return this.phoneCodeResult;
    }
    async signInPassword(_password: string): Promise<void> {
        if (this.passwordError) throw this.passwordError;
    }
    setQrLoginTokenHandler(handler: QrHandler | null): void { this.qrHandler = handler; }
    async exportQrLoginToken(): Promise<TelegramQrExportResult> {
        const next = this.qrResults.shift();
        if (!next) throw new Error('NO_QR_RESULT');
        return next;
    }
    async emitQrUpdate(): Promise<void> { await this.qrHandler?.(); }
    async getMe() { return this.me; }
    saveSession(): string { return `SECRET_SESSION_${this.me.id}`; }
    async disconnect(): Promise<void> { this.disconnects += 1; }
    async destroy(): Promise<void> { this.destroys += 1; }
}

function fixture() {
    let now = Date.parse('2026-08-29T00:00:00.000Z');
    const clients: FakeClient[] = [];
    const authorized: Array<{ session: string; userId: string; apiId: number; apiHash: string }> = [];
    const flows = new TelegramMultiAccountLoginFlows<FakeClient>({
        now: () => now,
        ttlMs: 5 * 60_000,
        maxErrors: 3,
        credentials: async () => ({ apiId: 123, apiHash: 'a'.repeat(32) }),
        createClient: () => {
            const client = new FakeClient();
            client.qrResults.push({
                kind: 'token',
                token: Buffer.from('initial-token'),
                expiresAt: now + 60_000,
            });
            clients.push(client);
            return client;
        },
        onAuthorized: async ({ session, credentials, account }) => {
            // A repository/pool adapter upserts by Telegram identity; repeat login is valid.
            const existing = authorized.find(item => item.userId === account.userId);
            if (existing) {
                existing.session = session;
                existing.apiId = credentials.apiId;
                existing.apiHash = credentials.apiHash;
            } else {
                authorized.push({ session, userId: account.userId, apiId: credentials.apiId, apiHash: credentials.apiHash });
            }
        },
    });
    return { flows, clients, authorized, advance(ms: number) { now += ms; } };
}

test('phone login is session-bound and authorizes through an injected userId upsert callback', async () => {
    const fx = fixture();
    const first = await fx.flows.startPhone('admin-session-a', '+86 138 0013 8000');
    assert.deepEqual(Object.keys(first).sort(), ['delivery', 'expiresAt', 'flowId']);
    assert.equal(JSON.stringify(first).includes('server-only-hash'), false);

    await assert.rejects(
        fx.flows.submitCode('admin-session-b', first.flowId, '12345'),
        (error: unknown) => error instanceof TelegramUserLoginFlowError && error.code === 'FLOW_NOT_FOUND',
    );
    const completed = await fx.flows.submitCode('admin-session-a', first.flowId, '12345');
    assert.deepEqual(completed, {
        step: 'complete',
        account: { userId: '42', username: 'vault_owner', displayName: 'Vault Owner' },
    });
    assert.equal(JSON.stringify(completed).includes('SECRET_SESSION'), false);

    const repeated = await fx.flows.startPhone('admin-session-a', '+8613800138000');
    await fx.flows.submitCode('admin-session-a', repeated.flowId, '12345');
    assert.deepEqual(fx.authorized, [{
        userId: '42',
        session: 'SECRET_SESSION_42',
        apiId: 123,
        apiHash: 'a'.repeat(32),
    }]);
});

test('QR start/refresh returns only a base64url tg login URI and increments version', async () => {
    const fx = fixture();
    const started = await fx.flows.startQr('admin-session-a');
    const client = fx.clients[0];
    assert.deepEqual(started, {
        flowId: started.flowId,
        status: 'pending',
        qrData: `tg://login?token=${Buffer.from('initial-token').toString('base64url')}`,
        expiresAt: '2026-08-29T00:01:00.000Z',
        version: 1,
    });
    assert.equal(JSON.stringify(started).includes('SECRET_SESSION'), false);

    client.qrResults.push({ kind: 'token', token: Buffer.from('new-token'), expiresAt: Date.parse('2026-08-29T00:02:00.000Z') });
    const refreshed = await fx.flows.refreshQr('admin-session-a', started.flowId);
    assert.equal(refreshed.version, 2);
    assert.equal(refreshed.qrData, `tg://login?token=${Buffer.from('new-token').toString('base64url')}`);
    await assert.rejects(
        fx.flows.getQrStatus('admin-session-b', started.flowId),
        (error: unknown) => error instanceof TelegramUserLoginFlowError && error.code === 'FLOW_NOT_FOUND',
    );
});

test('QR scan can require 2FA, then upserts the authorized account and cleans the temporary client', async () => {
    const fx = fixture();
    const started = await fx.flows.startQr('admin-session-a');
    const client = fx.clients[0];

    client.qrResults.push({ kind: 'password_required', hint: 'pet' });
    await client.emitQrUpdate();
    assert.deepEqual(await fx.flows.getQrStatus('admin-session-a', started.flowId), {
        flowId: started.flowId,
        status: 'password_required',
        qrData: null,
        expiresAt: '2026-08-29T00:05:00.000Z',
        version: 1,
        passwordHint: 'pet',
    });

    const completed = await fx.flows.submitPassword('admin-session-a', started.flowId, 'correct horse');
    assert.equal(completed.step, 'complete');
    const status = await fx.flows.getQrStatus('admin-session-a', started.flowId);
    assert.equal(status.status, 'complete');
    assert.deepEqual(status.account, { userId: '42', username: 'vault_owner', displayName: 'Vault Owner' });
    assert.deepEqual(fx.authorized, [{
        userId: '42',
        session: 'SECRET_SESSION_42',
        apiId: 123,
        apiHash: 'a'.repeat(32),
    }]);
    assert.equal(client.qrHandler, null);
    assert.equal(client.disconnects, 1);
    assert.equal(client.destroys, 1);
});

test('expired and cancelled QR flows cannot be reused and always close temporary clients', async () => {
    const fx = fixture();
    const first = await fx.flows.startQr('admin-session-a');
    fx.advance(5 * 60_000 + 1);
    await assert.rejects(
        fx.flows.getQrStatus('admin-session-a', first.flowId),
        (error: unknown) => error instanceof TelegramUserLoginFlowError && error.code === 'FLOW_EXPIRED',
    );
    assert.equal(fx.clients[0].disconnects, 1);

    const second = await fx.flows.startQr('admin-session-a');
    assert.deepEqual(await fx.flows.cancel('admin-session-a', second.flowId), { success: true });
    assert.equal(fx.clients[1].qrHandler, null);
    assert.equal(fx.clients[1].disconnects, 1);
    await assert.rejects(fx.flows.getQrStatus('admin-session-a', second.flowId));
});
