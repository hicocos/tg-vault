import fs from 'node:fs';
import path from 'node:path';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { getEffectiveTelegramBotConfig } from './telegramBotConfig.js';
import { TelegramUserWebLoginFlows, type TelegramUserLoginAccount, type TelegramUserLoginClient } from './telegramUserWebLogin.js';
import { deleteSettings, getSetting, setSetting, setSettings } from '../utils/settings.js';
import { recordTelegramUserClientFailure, recordTelegramUserClientReady } from './telegramUserClientStatus.js';
import { telegramAccountRepository } from './telegramAccountRepository.js';
import {
    deleteTelegramUserAccount,
    listTelegramUserAccounts,
    telegramUserClientPool,
    upsertTelegramUserAccount,
} from './telegramUserClientPool.js';
import { initializeTelegramMultiAccountRuntime } from './telegramMultiAccountRuntime.js';

export const TELEGRAM_USER_SESSION_SETTING = 'telegram_user_session';
const TELEGRAM_USER_ENABLED_SETTING = 'telegram_user_download_enabled';
const TELEGRAM_USER_ID_SETTING = 'telegram_user_id';
const TELEGRAM_USER_USERNAME_SETTING = 'telegram_user_username';

let userClient: TelegramClient | null = null;
let userSessionFilePath = '';

export async function getTelegramUserCredentials(): Promise<{ apiId: number; apiHash: string } | null> {
    const effective = await getEffectiveTelegramBotConfig();
    if (effective.credentials) return { apiId: effective.credentials.apiId, apiHash: effective.credentials.apiHash };
    const apiId = Number.parseInt(process.env.TELEGRAM_API_ID || '0', 10);
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    return apiId && apiHash ? { apiId, apiHash } : null;
}

function getSessionFilePath(): string {
    return process.env.TELEGRAM_USER_SESSION_FILE || './data/telegram_user_session.txt';
}

async function stopLegacyClient(): Promise<void> {
    const current = userClient;
    userClient = null;
    if (current) {
        try { await current.disconnect(); } catch { /* best effort */ }
        try { await current.destroy(); } catch { /* best effort */ }
    }
}

export async function migrateLegacyTelegramUserSession(): Promise<string> {
    const stored = await getSetting<string>(TELEGRAM_USER_SESSION_SETTING, '');
    if (stored) return stored;
    userSessionFilePath = getSessionFilePath();
    if (!fs.existsSync(userSessionFilePath)) return '';
    const legacy = fs.readFileSync(userSessionFilePath, 'utf8').trim();
    if (!legacy) return '';
    await setSetting(TELEGRAM_USER_SESSION_SETTING, legacy);
    return legacy;
}

function makeClient(session: string, credentials: { apiId: number; apiHash: string }): TelegramClient {
    return new TelegramClient(new StringSession(session), credentials.apiId, credentials.apiHash, {
        connectionRetries: 15,
        retryDelay: 2000,
        useWSS: false,
        deviceModel: 'TG Vault User Downloader',
        systemVersion: '1.0.0',
        appVersion: '1.0.0',
        floodSleepThreshold: 120,
    });
}

export async function initTelegramUserClient(credentials?: { apiId: number; apiHash: string }): Promise<void> {
    await stopLegacyClient();
    const resolved = credentials || await getTelegramUserCredentials();
    if (!resolved) {
        recordTelegramUserClientFailure('not_configured', '未配置 Telegram API');
        return;
    }
    const sessionString = await migrateLegacyTelegramUserSession();
    if (!sessionString) {
        recordTelegramUserClientFailure('not_configured', '未配置 Telegram 用户账号 session');
        return;
    }
    await initializeTelegramMultiAccountRuntime(resolved);
    const pooledClient = telegramUserClientPool.getDefaultClient();
    if (pooledClient) {
        const me = await pooledClient.getMe();
        recordTelegramUserClientReady({ userId: String((me as any)?.id || ''), username: (me as any)?.username || null });
        const legacyPath = getSessionFilePath();
        if (fs.existsSync(legacyPath)) fs.rmSync(legacyPath, { force: true });
        return;
    }
    if (!sessionString) {
        recordTelegramUserClientFailure('missing_session', '尚未登录 Telegram 用户账号');
        return;
    }
    if ((await getSetting(TELEGRAM_USER_ENABLED_SETTING, 'false')) !== 'true') {
        recordTelegramUserClientFailure('disabled', '');
        return;
    }
    const client = makeClient(sessionString, resolved);
    try {
        await client.connect();
        if (!(await client.checkAuthorization())) throw new Error('SESSION_EXPIRED');
        userClient = client;
        const saved = client.session.save() as unknown as string;
        if (saved !== sessionString) await setSetting(TELEGRAM_USER_SESSION_SETTING, saved);
        const me = await client.getMe();
        recordTelegramUserClientReady({ userId: String((me as any)?.id || ''), username: (me as any)?.username || null });
        const legacyPath = getSessionFilePath();
        if (fs.existsSync(legacyPath)) fs.rmSync(legacyPath, { force: true });
    } catch (error) {
        try { await client.disconnect(); } catch { /* best effort */ }
        try { await client.destroy(); } catch { /* best effort */ }
        recordTelegramUserClientFailure(String((error as Error).message).includes('EXPIRED') ? 'expired' : 'error', 'Telegram 用户账号连接失败');
    }
}

export async function restoreEnabledTelegramUserAccountsAfterRestart(): Promise<void> {
    // Persisted `enabled` state is the durable result of an explicit login or
    // enable action. Bot credentials alone must never activate user sessions.
    await telegramAccountRepository.migrateLegacySystemSettings();
    const enabledAccounts = await telegramAccountRepository.listEnabledAccounts();
    if (enabledAccounts.length === 0) return;
    const credentials = await getTelegramUserCredentials();
    if (!credentials) {
        recordTelegramUserClientFailure('not_configured', '未配置 Telegram API');
        return;
    }
    await initializeTelegramMultiAccountRuntime(credentials);
    const pooledClient = telegramUserClientPool.getDefaultClient();
    if (!pooledClient) {
        recordTelegramUserClientFailure('error', '已启用的 Telegram 用户账号连接失败');
        return;
    }
    const me = await pooledClient.getMe();
    recordTelegramUserClientReady({ userId: String((me as any)?.id || ''), username: (me as any)?.username || null });
}

export async function activateTelegramUserAccount(accountId: string): Promise<void> {
    const credentials = await getTelegramUserCredentials();
    if (!credentials) throw new Error('未配置 Telegram API');
    await telegramUserClientPool.activateAccount(accountId, 'explicit_enable', credentials);
    if (!telegramUserClientPool.getAccountClient(accountId)) throw new Error('Telegram 用户账号连接失败');
}

async function persistAndActivate(session: string, account: TelegramUserLoginAccount): Promise<void> {
    await setSettings([
        [TELEGRAM_USER_SESSION_SETTING, session],
        [TELEGRAM_USER_ENABLED_SETTING, 'true'],
        [TELEGRAM_USER_ID_SETTING, account.userId],
        [TELEGRAM_USER_USERNAME_SETTING, account.username || ''],
    ]);
    await upsertTelegramUserAccount({
        telegramUserId: account.userId,
        username: account.username,
        displayName: account.displayName,
        session,
        enabled: true,
        isLegacy: true,
    });
    await initTelegramUserClient();
}

class GramJsWebLoginClient implements TelegramUserLoginClient {
    constructor(private readonly client: TelegramClient, private readonly credentials: { apiId: number; apiHash: string }) {}
    async connect(): Promise<void> { await this.client.connect(); }
    sendCode(credentials: { apiId: number; apiHash: string }, phone: string) { return this.client.sendCode(credentials, phone); }
    async signInCode(phone: string, phoneCodeHash: string, code: string): Promise<'authorized' | 'password_needed'> {
        try {
            await this.client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
            return 'authorized';
        } catch (error) {
            const name = String((error as any)?.errorMessage || (error as Error).message || '');
            if (name.includes('SESSION_PASSWORD_NEEDED')) return 'password_needed';
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
    async getMe() { return await this.client.getMe() as any; }
    saveSession() { return this.client.session.save() as unknown as string; }
    disconnect() { return this.client.disconnect(); }
    destroy() { return this.client.destroy(); }
}

export const telegramUserWebLogin = new TelegramUserWebLoginFlows<GramJsWebLoginClient>({
    credentials: getTelegramUserCredentials,
    createClient: credentials => new GramJsWebLoginClient(makeClient('', credentials), credentials),
    persistAndActivate,
});

export async function getTelegramUserAccountStatus(): Promise<{
    configured: boolean; enabled: boolean; connected: boolean; account: TelegramUserLoginAccount | null;
}> {
    const session = await migrateLegacyTelegramUserSession();
    const enabled = (await getSetting(TELEGRAM_USER_ENABLED_SETTING, 'false')) === 'true';
    const userId = await getSetting<string>(TELEGRAM_USER_ID_SETTING, '');
    const username = await getSetting<string>(TELEGRAM_USER_USERNAME_SETTING, '');
    return {
        configured: Boolean(session), enabled, connected: isTelegramUserClientReady(),
        account: userId ? { userId, username: username || null, displayName: null } : null,
    };
}

export async function disableTelegramUserAccount(): Promise<void> {
    await setSetting(TELEGRAM_USER_ENABLED_SETTING, 'false');
    for (const account of await listTelegramUserAccounts()) {
        if (account.isLegacy) {
            await telegramAccountRepository.setEnabled(account.id, false);
            await telegramUserClientPool.deactivateAccount(account.id);
        }
    }
    await stopLegacyClient();
    recordTelegramUserClientFailure('disabled', '');
}

export async function enableTelegramUserAccount(): Promise<void> {
    await setSetting(TELEGRAM_USER_ENABLED_SETTING, 'true');
    for (const account of await listTelegramUserAccounts()) {
        if (account.isLegacy) await telegramAccountRepository.setEnabled(account.id, true);
    }
    await initTelegramUserClient();
}

export async function unlinkTelegramUserAccount(): Promise<void> {
    await stopLegacyClient();
    for (const account of await listTelegramUserAccounts()) {
        if (account.isLegacy) await deleteTelegramUserAccount(account.id);
    }
    await deleteSettings([TELEGRAM_USER_SESSION_SETTING, TELEGRAM_USER_ENABLED_SETTING, TELEGRAM_USER_ID_SETTING, TELEGRAM_USER_USERNAME_SETTING]);
    const legacyPath = getSessionFilePath();
    if (fs.existsSync(legacyPath)) fs.rmSync(legacyPath, { force: true });
    recordTelegramUserClientFailure('missing_session', '尚未登录 Telegram 用户账号');
}

export function getTelegramUserClient(): TelegramClient | null { return telegramUserClientPool.getDefaultClient() || userClient; }
export function isTelegramUserClientReady(): boolean { return Boolean(getTelegramUserClient()?.connected); }
export function getTelegramUserSessionFilePath(): string { return userSessionFilePath || path.resolve(getSessionFilePath()); }
