import crypto from 'node:crypto';

export interface TelegramUserLoginAccount {
    userId: string;
    username: string | null;
    displayName: string | null;
}

export interface TelegramLoginCredentials {
    apiId: number;
    apiHash: string;
}

export type TelegramQrExportResult =
    | { kind: 'token'; token: Buffer; expiresAt: number }
    | { kind: 'authorized' }
    | { kind: 'password_required'; hint?: string | null };

export interface TelegramMultiAccountLoginClient {
    connect(): Promise<void>;
    sendCode(credentials: TelegramLoginCredentials, phone: string): Promise<{ phoneCodeHash: string; isCodeViaApp: boolean }>;
    signInCode(phone: string, phoneCodeHash: string, code: string): Promise<'authorized' | 'password_needed'>;
    signInPassword(password: string): Promise<void>;
    setQrLoginTokenHandler(handler: (() => void | Promise<void>) | null): void;
    exportQrLoginToken(): Promise<TelegramQrExportResult>;
    getMe(): Promise<{ id: unknown; username?: string; firstName?: string; lastName?: string }>;
    saveSession(): string;
    disconnect(): Promise<void>;
    destroy(): Promise<void>;
}

export type TelegramUserLoginFlowErrorCode =
    | 'INVALID_PHONE'
    | 'INVALID_CODE'
    | 'INVALID_PASSWORD'
    | 'FLOW_NOT_FOUND'
    | 'FLOW_EXPIRED'
    | 'TOO_MANY_ERRORS'
    | 'API_NOT_CONFIGURED'
    | 'TELEGRAM_ERROR';

export class TelegramUserLoginFlowError extends Error {
    constructor(public readonly code: TelegramUserLoginFlowErrorCode, message: string) {
        super(message);
        this.name = 'TelegramUserLoginFlowError';
    }
}

interface BaseFlow<C> {
    id: string;
    owner: string;
    credentials: TelegramLoginCredentials;
    expiresAt: number;
    errors: number;
    client: C | null;
    cleanupTimer: ReturnType<typeof setTimeout>;
}

interface PhoneFlow<C> extends BaseFlow<C> {
    kind: 'phone';
    phone: string;
    phoneCodeHash: string;
    step: 'code' | 'password';
}

export type TelegramQrLoginStatus = 'pending' | 'password_required' | 'complete' | 'error';

export interface TelegramQrLoginStatusResponse {
    flowId: string;
    status: TelegramQrLoginStatus;
    qrData: string | null;
    expiresAt: string;
    version: number;
    passwordHint?: string | null;
    account?: TelegramUserLoginAccount;
    error?: string;
}

interface QrFlow<C> extends BaseFlow<C> {
    kind: 'qr';
    status: TelegramQrLoginStatus;
    qrData: string | null;
    tokenExpiresAt: number | null;
    version: number;
    passwordHint: string | null;
    account: TelegramUserLoginAccount | null;
    error: string | null;
    operation: Promise<void>;
}

type LoginFlow<C> = PhoneFlow<C> | QrFlow<C>;

type AuthorizedCallback = (input: {
    session: string;
    credentials: TelegramLoginCredentials;
    account: TelegramUserLoginAccount;
}) => Promise<void>;

function telegramErrorName(error: unknown): string {
    if (!error || typeof error !== 'object') return '';
    return String((error as { errorMessage?: unknown }).errorMessage || (error as Error).message || '');
}

function normalizeAccount(me: { id: unknown; username?: string; firstName?: string; lastName?: string }): TelegramUserLoginAccount {
    const displayName = [me.firstName, me.lastName].filter(Boolean).join(' ').trim();
    return {
        userId: String(me.id ?? ''),
        username: me.username || null,
        displayName: displayName || null,
    };
}

/**
 * Ephemeral, admin-session-bound Telegram login coordinator.
 *
 * Login tokens, phone-code hashes and StringSessions live only in memory. The
 * injected callback is the integration seam for a multi-account repository and
 * client pool; it should upsert by account.userId and activate/reload that user.
 */
export class TelegramMultiAccountLoginFlows<C extends TelegramMultiAccountLoginClient> {
    private readonly flows = new Map<string, LoginFlow<C>>();
    private readonly ttlMs: number;
    private readonly maxErrors: number;
    private readonly now: () => number;

    constructor(private readonly deps: {
        credentials(): Promise<TelegramLoginCredentials | null>;
        createClient(credentials: TelegramLoginCredentials): C;
        onAuthorized: AuthorizedCallback;
        now?: () => number;
        ttlMs?: number;
        maxErrors?: number;
    }) {
        this.now = deps.now || Date.now;
        this.ttlMs = deps.ttlMs ?? 5 * 60_000;
        this.maxErrors = deps.maxErrors ?? 3;
    }

    /** Backward-compatible alias for the existing phone-login service API. */
    start(owner: string, rawPhone: string) {
        return this.startPhone(owner, rawPhone);
    }

    async startPhone(owner: string, rawPhone: string): Promise<{ flowId: string; delivery: 'app' | 'sms'; expiresAt: string }> {
        const phone = String(rawPhone || '').replace(/[\s()-]/g, '');
        if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
            throw new TelegramUserLoginFlowError('INVALID_PHONE', '请输入含国家区号的有效手机号');
        }
        await this.removeOwnerFlows(owner);
        const credentials = await this.requireCredentials();
        const client = this.deps.createClient(credentials);
        try {
            await client.connect();
            const sent = await client.sendCode(credentials, phone);
            const id = this.newFlowId();
            const expiresAt = this.now() + this.ttlMs;
            const flow: PhoneFlow<C> = {
                id,
                owner,
                credentials,
                expiresAt,
                errors: 0,
                client,
                cleanupTimer: this.scheduleCleanup(id, expiresAt),
                kind: 'phone',
                phone,
                phoneCodeHash: sent.phoneCodeHash,
                step: 'code',
            };
            this.flows.set(id, flow);
            return {
                flowId: id,
                delivery: sent.isCodeViaApp ? 'app' : 'sms',
                expiresAt: new Date(expiresAt).toISOString(),
            };
        } catch (error) {
            await this.closeClient(client);
            throw this.publicError(error);
        }
    }

    async startQr(owner: string): Promise<TelegramQrLoginStatusResponse> {
        await this.removeOwnerFlows(owner);
        const credentials = await this.requireCredentials();
        const client = this.deps.createClient(credentials);
        const id = this.newFlowId();
        const expiresAt = this.now() + this.ttlMs;
        const flow: QrFlow<C> = {
            id,
            owner,
            credentials,
            expiresAt,
            errors: 0,
            client,
            cleanupTimer: this.scheduleCleanup(id, expiresAt),
            kind: 'qr',
            status: 'pending',
            qrData: null,
            tokenExpiresAt: null,
            version: 0,
            passwordHint: null,
            account: null,
            error: null,
            operation: Promise.resolve(),
        };
        try {
            await client.connect();
            client.setQrLoginTokenHandler(async () => {
                try {
                    await this.advanceQr(flow);
                } catch (error) {
                    await this.failQr(flow, error);
                }
            });
            this.flows.set(id, flow);
            await this.advanceQr(flow);
            return this.qrResponse(flow);
        } catch (error) {
            this.flows.delete(id);
            clearTimeout(flow.cleanupTimer);
            client.setQrLoginTokenHandler(null);
            await this.closeClient(client);
            throw this.publicError(error);
        }
    }

    async refreshQr(owner: string, flowId: string): Promise<TelegramQrLoginStatusResponse> {
        const flow = await this.requireQrFlow(owner, flowId);
        if (flow.status !== 'pending') return this.qrResponse(flow);
        try {
            await this.advanceQr(flow);
        } catch (error) {
            await this.failQr(flow, error);
            throw this.publicError(error);
        }
        return this.qrResponse(flow);
    }

    async getQrStatus(owner: string, flowId: string): Promise<TelegramQrLoginStatusResponse> {
        return this.qrResponse(await this.requireQrFlow(owner, flowId));
    }

    async submitCode(owner: string, flowId: string, rawCode: string): Promise<
        { step: 'password_required' } | { step: 'complete'; account: TelegramUserLoginAccount }
    > {
        const flow = await this.requirePhoneFlow(owner, flowId, 'code');
        const code = String(rawCode || '').replace(/\s/g, '');
        if (!/^\d{5,6}$/.test(code)) {
            throw new TelegramUserLoginFlowError('INVALID_CODE', '请输入有效验证码');
        }
        try {
            const result = await this.requireClient(flow).signInCode(flow.phone, flow.phoneCodeHash, code);
            if (result === 'password_needed') {
                flow.step = 'password';
                return { step: 'password_required' };
            }
            return await this.completePhone(flow);
        } catch (error) {
            if (telegramErrorName(error).includes('SESSION_PASSWORD_NEEDED')) {
                flow.step = 'password';
                return { step: 'password_required' };
            }
            await this.recordError(flow);
            throw this.publicError(error, 'INVALID_CODE');
        }
    }

    async submitPassword(owner: string, flowId: string, password: string): Promise<
        { step: 'complete'; account: TelegramUserLoginAccount }
    > {
        const flow = await this.requireFlow(owner, flowId);
        if (!password) throw new TelegramUserLoginFlowError('INVALID_PASSWORD', '请输入两步验证密码');
        if (flow.kind === 'phone' && flow.step !== 'password') {
            throw new TelegramUserLoginFlowError('FLOW_NOT_FOUND', '登录步骤无效，请重新开始登录');
        }
        if (flow.kind === 'qr' && flow.status !== 'password_required') {
            throw new TelegramUserLoginFlowError('FLOW_NOT_FOUND', '登录步骤无效，请重新开始登录');
        }
        try {
            await this.requireClient(flow).signInPassword(password);
            if (flow.kind === 'phone') return await this.completePhone(flow);
            const account = await this.authorizeAndClose(flow);
            flow.status = 'complete';
            flow.account = account;
            flow.qrData = null;
            flow.tokenExpiresAt = null;
            flow.passwordHint = null;
            return { step: 'complete', account };
        } catch (error) {
            await this.recordError(flow);
            throw this.publicError(error, 'INVALID_PASSWORD');
        }
    }

    async cancel(owner: string, flowId: string): Promise<{ success: true }> {
        const flow = await this.requireFlow(owner, flowId);
        await this.deleteAndClose(flow);
        return { success: true };
    }

    private async advanceQr(flow: QrFlow<C>): Promise<void> {
        const previous = flow.operation;
        let release!: () => void;
        flow.operation = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            if (flow.status !== 'pending' || !this.flows.has(flow.id)) return;
            const result = await this.requireClient(flow).exportQrLoginToken();
            if (result.kind === 'token') {
                flow.qrData = `tg://login?token=${result.token.toString('base64url')}`;
                flow.tokenExpiresAt = Math.min(result.expiresAt, flow.expiresAt);
                flow.version += 1;
                return;
            }
            flow.qrData = null;
            flow.tokenExpiresAt = null;
            if (result.kind === 'password_required') {
                flow.status = 'password_required';
                flow.passwordHint = result.hint || null;
                return;
            }
            flow.account = await this.authorizeAndClose(flow);
            flow.status = 'complete';
        } finally {
            release();
        }
    }

    private async failQr(flow: QrFlow<C>, error: unknown): Promise<void> {
        if (!this.flows.has(flow.id) || flow.status === 'complete') return;
        flow.status = 'error';
        flow.qrData = null;
        flow.tokenExpiresAt = null;
        flow.error = this.publicError(error).message;
        await this.detachAndClose(flow);
    }

    private async completePhone(flow: PhoneFlow<C>): Promise<{ step: 'complete'; account: TelegramUserLoginAccount }> {
        try {
            const account = await this.authorize(flow);
            this.flows.delete(flow.id);
            clearTimeout(flow.cleanupTimer);
            return { step: 'complete', account };
        } finally {
            await this.detachAndClose(flow);
        }
    }

    private async authorizeAndClose(flow: LoginFlow<C>): Promise<TelegramUserLoginAccount> {
        try {
            return await this.authorize(flow);
        } finally {
            await this.detachAndClose(flow);
        }
    }

    private async authorize(flow: LoginFlow<C>): Promise<TelegramUserLoginAccount> {
        const client = this.requireClient(flow);
        const account = normalizeAccount(await client.getMe());
        if (!account.userId) throw new TelegramUserLoginFlowError('TELEGRAM_ERROR', 'Telegram 登录未返回用户身份');
        await this.deps.onAuthorized({ session: client.saveSession(), credentials: flow.credentials, account });
        return account;
    }

    private qrResponse(flow: QrFlow<C>): TelegramQrLoginStatusResponse {
        const response: TelegramQrLoginStatusResponse = {
            flowId: flow.id,
            status: flow.status,
            qrData: flow.status === 'pending' ? flow.qrData : null,
            expiresAt: new Date(flow.status === 'pending' && flow.tokenExpiresAt ? flow.tokenExpiresAt : flow.expiresAt).toISOString(),
            version: flow.version,
        };
        if (flow.status === 'password_required') response.passwordHint = flow.passwordHint;
        if (flow.status === 'complete' && flow.account) response.account = flow.account;
        if (flow.status === 'error' && flow.error) response.error = flow.error;
        return response;
    }

    private async requireFlow(owner: string, id: string): Promise<LoginFlow<C>> {
        const flow = this.flows.get(String(id || ''));
        if (!flow || flow.owner !== owner) {
            throw new TelegramUserLoginFlowError('FLOW_NOT_FOUND', '登录流程不存在，请重新开始登录');
        }
        if (flow.expiresAt <= this.now()) {
            await this.deleteAndClose(flow);
            throw new TelegramUserLoginFlowError('FLOW_EXPIRED', '登录流程已过期，请重新开始登录');
        }
        if (flow.errors >= this.maxErrors) {
            await this.deleteAndClose(flow);
            throw new TelegramUserLoginFlowError('TOO_MANY_ERRORS', '错误次数过多，请重新开始登录');
        }
        return flow;
    }

    private async requirePhoneFlow(owner: string, id: string, step: PhoneFlow<C>['step']): Promise<PhoneFlow<C>> {
        const flow = await this.requireFlow(owner, id);
        if (flow.kind !== 'phone' || flow.step !== step) {
            throw new TelegramUserLoginFlowError('FLOW_NOT_FOUND', '登录步骤无效，请重新开始登录');
        }
        return flow;
    }

    private async requireQrFlow(owner: string, id: string): Promise<QrFlow<C>> {
        const flow = await this.requireFlow(owner, id);
        if (flow.kind !== 'qr') {
            throw new TelegramUserLoginFlowError('FLOW_NOT_FOUND', '二维码登录流程不存在，请重新开始登录');
        }
        return flow;
    }

    private async recordError(flow: LoginFlow<C>): Promise<void> {
        flow.errors += 1;
        if (flow.errors >= this.maxErrors) await this.deleteAndClose(flow);
    }

    private async removeOwnerFlows(owner: string): Promise<void> {
        for (const flow of [...this.flows.values()]) {
            if (flow.owner === owner) await this.deleteAndClose(flow);
        }
    }

    private scheduleCleanup(id: string, expiresAt: number): ReturnType<typeof setTimeout> {
        const timer = setTimeout(() => {
            const flow = this.flows.get(id);
            if (flow) void this.deleteAndClose(flow);
        }, Math.max(1, expiresAt - this.now()));
        timer.unref?.();
        return timer;
    }

    private async deleteAndClose(flow: LoginFlow<C>): Promise<void> {
        this.flows.delete(flow.id);
        clearTimeout(flow.cleanupTimer);
        await this.detachAndClose(flow);
    }

    private async detachAndClose(flow: LoginFlow<C>): Promise<void> {
        const client = flow.client;
        flow.client = null;
        if (!client) return;
        if (flow.kind === 'qr') client.setQrLoginTokenHandler(null);
        await this.closeClient(client);
    }

    private requireClient(flow: LoginFlow<C>): C {
        if (!flow.client) throw new TelegramUserLoginFlowError('FLOW_NOT_FOUND', '登录流程已经结束');
        return flow.client;
    }

    private async requireCredentials(): Promise<TelegramLoginCredentials> {
        const credentials = await this.deps.credentials();
        if (!credentials?.apiId || !credentials.apiHash) {
            throw new TelegramUserLoginFlowError('API_NOT_CONFIGURED', '请先配置有效的 Telegram API ID 和 API Hash');
        }
        return credentials;
    }

    private newFlowId(): string {
        return crypto.randomBytes(24).toString('base64url');
    }

    private publicError(error: unknown, fallback: TelegramUserLoginFlowErrorCode = 'TELEGRAM_ERROR'): TelegramUserLoginFlowError {
        if (error instanceof TelegramUserLoginFlowError) return error;
        const name = telegramErrorName(error);
        if (/PHONE_CODE_(INVALID|EXPIRED|EMPTY)/.test(name)) {
            return new TelegramUserLoginFlowError('INVALID_CODE', '验证码无效或已过期');
        }
        if (/PASSWORD_HASH_INVALID/.test(name)) {
            return new TelegramUserLoginFlowError('INVALID_PASSWORD', '两步验证密码错误');
        }
        if (/PHONE_NUMBER_INVALID/.test(name)) {
            return new TelegramUserLoginFlowError('INVALID_PHONE', '手机号无效');
        }
        return new TelegramUserLoginFlowError(
            fallback,
            fallback === 'INVALID_PASSWORD'
                ? '两步验证密码错误'
                : fallback === 'INVALID_CODE'
                    ? '验证码无效或已过期'
                    : 'Telegram 登录失败，请稍后重试',
        );
    }

    private async closeClient(client: C): Promise<void> {
        try { await client.disconnect(); } catch { /* best effort */ }
        try { await client.destroy(); } catch { /* best effort */ }
    }
}
