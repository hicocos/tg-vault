import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Raw } from 'telegram/events/index.js';
import { getEffectiveTelegramBotConfig } from './telegramBotConfig.js';
import {
    TelegramMultiAccountLoginFlows,
    type TelegramLoginCredentials,
    type TelegramMultiAccountLoginClient,
    type TelegramQrExportResult,
    type TelegramUserLoginAccount,
} from './telegramMultiAccountLoginFlows.js';

export interface TelegramAuthorizedAccountAdapter {
    upsertByTelegramUserId(input: {
        session: string;
        credentials: TelegramLoginCredentials;
        account: TelegramUserLoginAccount;
    }): Promise<void>;
}

let adapter: TelegramAuthorizedAccountAdapter | null = null;

/**
 * The future multi-account repository/pool registers one thin adapter here.
 * Keeping this module independent prevents the login routes from importing a
 * pool API that may not exist yet.
 */
export function registerTelegramMultiAccountAuthorizedAdapter(next: TelegramAuthorizedAccountAdapter | null): void {
    adapter = next;
}

async function getCredentials(): Promise<TelegramLoginCredentials | null> {
    const effective = await getEffectiveTelegramBotConfig();
    if (effective.credentials) {
        return { apiId: effective.credentials.apiId, apiHash: effective.credentials.apiHash };
    }
    const apiId = Number.parseInt(process.env.TELEGRAM_API_ID || '0', 10);
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    return apiId && apiHash ? { apiId, apiHash } : null;
}

function makeClient(credentials: TelegramLoginCredentials): TelegramClient {
    return new TelegramClient(new StringSession(''), credentials.apiId, credentials.apiHash, {
        connectionRetries: 15,
        retryDelay: 2000,
        useWSS: false,
        deviceModel: 'TG Vault Multi-Account Login',
        systemVersion: '1.0.0',
        appVersion: '1.0.0',
        floodSleepThreshold: 120,
    });
}

class GramJsMultiAccountLoginClient implements TelegramMultiAccountLoginClient {
    private qrHandler: (() => void | Promise<void>) | null = null;
    private readonly qrEvent = new Raw({ types: [Api.UpdateLoginToken] });

    constructor(
        private readonly client: TelegramClient,
        private readonly credentials: TelegramLoginCredentials,
    ) {}

    async connect(): Promise<void> { await this.client.connect(); }

    sendCode(credentials: TelegramLoginCredentials, phone: string) {
        return this.client.sendCode(credentials, phone);
    }

    async signInCode(phone: string, phoneCodeHash: string, code: string): Promise<'authorized' | 'password_needed'> {
        try {
            await this.client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
            return 'authorized';
        } catch (error) {
            if (this.errorName(error).includes('SESSION_PASSWORD_NEEDED')) return 'password_needed';
            throw error;
        }
    }

    async signInPassword(password: string): Promise<void> {
        let captured: unknown;
        await this.client.signInWithPassword(this.credentials, {
            password: async () => password,
            onError: async error => { captured = error; return true; },
        }).catch(error => { throw captured || error; });
    }

    setQrLoginTokenHandler(handler: (() => void | Promise<void>) | null): void {
        if (this.qrHandler) this.client.removeEventHandler(this.qrHandler, this.qrEvent);
        this.qrHandler = handler;
        if (handler) this.client.addEventHandler(handler, this.qrEvent);
    }

    async exportQrLoginToken(): Promise<TelegramQrExportResult> {
        let result: Api.auth.TypeLoginToken;
        try {
            result = await this.client.invoke(new Api.auth.ExportLoginToken({
                apiId: this.credentials.apiId,
                apiHash: this.credentials.apiHash,
                exceptIds: [],
            }));
        } catch (error) {
            if (this.errorName(error).includes('SESSION_PASSWORD_NEEDED')) {
                return { kind: 'password_required' };
            }
            throw error;
        }
        if (result instanceof Api.auth.LoginToken) {
            return {
                kind: 'token',
                token: Buffer.from(result.token),
                expiresAt: Number(result.expires) * 1000,
            };
        }
        let imported: Api.auth.TypeLoginToken = result;
        if (result instanceof Api.auth.LoginTokenMigrateTo) {
            await this.client._switchDC(result.dcId);
            imported = await this.client.invoke(new Api.auth.ImportLoginToken({ token: result.token })) as Api.auth.TypeLoginToken;
        }
        if (imported instanceof Api.auth.LoginTokenSuccess) return { kind: 'authorized' };
        if (imported instanceof Api.auth.LoginToken) {
            return {
                kind: 'token',
                token: Buffer.from(imported.token),
                expiresAt: Number(imported.expires) * 1000,
            };
        }
        throw new Error('TELEGRAM_QR_LOGIN_UNEXPECTED_RESPONSE');
    }

    async getMe() { return await this.client.getMe() as any; }
    saveSession(): string { return this.client.session.save() as unknown as string; }
    disconnect(): Promise<void> { return this.client.disconnect(); }
    destroy(): Promise<void> { return this.client.destroy(); }

    private errorName(error: unknown): string {
        if (!error || typeof error !== 'object') return '';
        return String((error as { errorMessage?: unknown }).errorMessage || (error as Error).message || '');
    }
}

async function onAuthorized(input: { session: string; credentials: TelegramLoginCredentials; account: TelegramUserLoginAccount }): Promise<void> {
    if (!adapter) {
        throw new Error('Telegram 多账号仓库尚未注册，无法保存登录账号');
    }
    await adapter.upsertByTelegramUserId(input);
}

export const telegramMultiAccountLoginFlows = new TelegramMultiAccountLoginFlows<GramJsMultiAccountLoginClient>({
    credentials: getCredentials,
    createClient: credentials => new GramJsMultiAccountLoginClient(makeClient(credentials), credentials),
    onAuthorized,
});
