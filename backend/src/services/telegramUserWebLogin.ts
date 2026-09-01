import crypto from 'node:crypto';

export interface TelegramUserLoginAccount {
    userId: string;
    username: string | null;
    displayName: string | null;
}

export interface TelegramUserLoginClient {
    connect(): Promise<void>;
    sendCode(credentials: { apiId: number; apiHash: string }, phone: string): Promise<{ phoneCodeHash: string; isCodeViaApp: boolean }>;
    signInCode(phone: string, phoneCodeHash: string, code: string): Promise<'authorized' | 'password_needed'>;
    signInPassword(password: string): Promise<void>;
    getMe(): Promise<{ id: unknown; username?: string; firstName?: string; lastName?: string }>;
    saveSession(): string;
    disconnect(): Promise<void>;
    destroy(): Promise<void>;
}

interface Flow<C> {
    id: string;
    owner: string;
    phone: string;
    phoneCodeHash: string;
    expiresAt: number;
    errors: number;
    step: 'code' | 'password';
    client: C;
    credentials: { apiId: number; apiHash: string };
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

function telegramErrorName(error: unknown): string {
    if (!error || typeof error !== 'object') return '';
    return String((error as { errorMessage?: unknown }).errorMessage || (error as Error).message || '');
}

function normalizeAccount(me: { id: unknown; username?: string; firstName?: string; lastName?: string }): TelegramUserLoginAccount {
    const displayName = [me.firstName, me.lastName].filter(Boolean).join(' ').trim();
    return { userId: String(me.id ?? ''), username: me.username || null, displayName: displayName || null };
}

export class TelegramUserWebLoginFlows<C extends TelegramUserLoginClient> {
    private readonly flows = new Map<string, Flow<C>>();
    private readonly ttlMs: number;
    private readonly maxErrors: number;
    private readonly now: () => number;

    constructor(private readonly deps: {
        credentials(): Promise<{ apiId: number; apiHash: string } | null>;
        createClient(credentials: { apiId: number; apiHash: string }): C;
        persistAndActivate(session: string, account: TelegramUserLoginAccount, credentials: { apiId: number; apiHash: string }): Promise<void>;
        now?: () => number;
        ttlMs?: number;
        maxErrors?: number;
    }) {
        this.now = deps.now || Date.now;
        this.ttlMs = deps.ttlMs ?? 5 * 60_000;
        this.maxErrors = deps.maxErrors ?? 3;
    }

    async start(owner: string, rawPhone: string): Promise<{ flowId: string; delivery: 'app' | 'sms'; expiresAt: string }> {
        const phone = String(rawPhone || '').replace(/[\s()-]/g, '');
        if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new TelegramUserLoginFlowError('INVALID_PHONE', '请输入含国家区号的有效手机号');
        await this.removeOwnerFlows(owner);
        const credentials = await this.deps.credentials();
        if (!credentials?.apiId || !credentials.apiHash) throw new TelegramUserLoginFlowError('API_NOT_CONFIGURED', '请先配置有效的 Telegram API ID 和 API Hash');
        const client = this.deps.createClient(credentials);
        try {
            await client.connect();
            const sent = await client.sendCode(credentials, phone);
            const flowId = crypto.randomBytes(24).toString('base64url');
            const expiresAt = this.now() + this.ttlMs;
            this.flows.set(flowId, { id: flowId, owner, phone, phoneCodeHash: sent.phoneCodeHash, expiresAt, errors: 0, step: 'code', client, credentials });
            return { flowId, delivery: sent.isCodeViaApp ? 'app' : 'sms', expiresAt: new Date(expiresAt).toISOString() };
        } catch (error) {
            await this.closeClient(client);
            throw this.publicError(error);
        }
    }

    async submitCode(owner: string, flowId: string, rawCode: string): Promise<{ step: 'password_required' } | { step: 'complete'; account: TelegramUserLoginAccount }> {
        const flow = await this.requireFlow(owner, flowId, 'code');
        const code = String(rawCode || '').replace(/\s/g, '');
        if (!/^\d{5,6}$/.test(code)) throw new TelegramUserLoginFlowError('INVALID_CODE', '请输入有效验证码');
        try {
            const result = await flow.client.signInCode(flow.phone, flow.phoneCodeHash, code);
            if (result === 'password_needed') {
                flow.step = 'password';
                return { step: 'password_required' };
            }
            return await this.complete(flow);
        } catch (error) {
            if (telegramErrorName(error).includes('SESSION_PASSWORD_NEEDED')) {
                flow.step = 'password';
                return { step: 'password_required' };
            }
            await this.recordError(flow);
            throw this.publicError(error, 'INVALID_CODE');
        }
    }

    async submitPassword(owner: string, flowId: string, password: string): Promise<{ step: 'complete'; account: TelegramUserLoginAccount }> {
        const flow = await this.requireFlow(owner, flowId, 'password');
        if (!password) throw new TelegramUserLoginFlowError('INVALID_PASSWORD', '请输入两步验证密码');
        try {
            await flow.client.signInPassword(password);
            return await this.complete(flow);
        } catch (error) {
            await this.recordError(flow);
            throw this.publicError(error, 'INVALID_PASSWORD');
        }
    }

    private async removeOwnerFlows(owner: string): Promise<void> {
        const owned = [...this.flows.values()].filter(flow => flow.owner === owner);
        for (const flow of owned) {
            this.flows.delete(flow.id);
            await this.closeClient(flow.client);
        }
    }

    private async complete(flow: Flow<C>): Promise<{ step: 'complete'; account: TelegramUserLoginAccount }> {
        try {
            const account = normalizeAccount(await flow.client.getMe());
            await this.deps.persistAndActivate(flow.client.saveSession(), account, flow.credentials);
            this.flows.delete(flow.id);
            return { step: 'complete', account };
        } finally {
            await this.closeClient(flow.client);
        }
    }

    private async requireFlow(owner: string, id: string, step: Flow<C>['step']): Promise<Flow<C>> {
        const flow = this.flows.get(id);
        if (!flow || flow.owner !== owner) throw new TelegramUserLoginFlowError('FLOW_NOT_FOUND', '登录流程不存在，请重新发送验证码');
        if (flow.expiresAt <= this.now()) {
            this.flows.delete(id);
            await this.closeClient(flow.client);
            throw new TelegramUserLoginFlowError('FLOW_EXPIRED', '登录流程已过期，请重新发送验证码');
        }
        if (flow.errors >= this.maxErrors) {
            this.flows.delete(id);
            await this.closeClient(flow.client);
            throw new TelegramUserLoginFlowError('TOO_MANY_ERRORS', '错误次数过多，请重新开始登录');
        }
        if (flow.step !== step) throw new TelegramUserLoginFlowError('FLOW_NOT_FOUND', '登录步骤无效，请重新开始登录');
        return flow;
    }

    private async recordError(flow: Flow<C>): Promise<void> {
        flow.errors += 1;
    }

    private publicError(error: unknown, fallback: TelegramUserLoginFlowErrorCode = 'TELEGRAM_ERROR'): TelegramUserLoginFlowError {
        if (error instanceof TelegramUserLoginFlowError) return error;
        const name = telegramErrorName(error);
        if (/PHONE_CODE_(INVALID|EXPIRED|EMPTY)/.test(name)) return new TelegramUserLoginFlowError('INVALID_CODE', '验证码无效或已过期');
        if (/PASSWORD_HASH_INVALID/.test(name)) return new TelegramUserLoginFlowError('INVALID_PASSWORD', '两步验证密码错误');
        if (/PHONE_NUMBER_INVALID/.test(name)) return new TelegramUserLoginFlowError('INVALID_PHONE', '手机号无效');
        return new TelegramUserLoginFlowError(fallback, fallback === 'INVALID_PASSWORD' ? '两步验证密码错误' : fallback === 'INVALID_CODE' ? '验证码无效或已过期' : 'Telegram 登录失败，请稍后重试');
    }

    private async closeClient(client: C): Promise<void> {
        try { await client.disconnect(); } catch { /* best effort */ }
        try { await client.destroy(); } catch { /* best effort */ }
    }
}
