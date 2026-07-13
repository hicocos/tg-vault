import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/index.js';
import { getSetting, setSetting } from './settings.js';

const WEB_PASSWORD_KEY = 'admin_password_hash';
const TELEGRAM_PIN_KEY = 'telegram_pin_hash';
const TELEGRAM_ALLOWED_USERS_KEY = 'telegram_allowed_user_ids';
const SCRYPT_PREFIX = 'scrypt:v1';

function hashSecret(secret: string): string {
    const salt = crypto.randomBytes(16).toString('base64url');
    const derived = crypto.scryptSync(secret, salt, 64).toString('base64url');
    return `${SCRYPT_PREFIX}:${salt}:${derived}`;
}

function safeEqualText(a: string, b: string): boolean {
    try {
        const left = Buffer.from(a);
        const right = Buffer.from(b);
        return left.length === right.length && crypto.timingSafeEqual(left, right);
    } catch {
        return false;
    }
}

function verifySecret(secret: string, stored: string): boolean {
    if (!stored) return false;

    if (stored.startsWith(`${SCRYPT_PREFIX}:`)) {
        const [, , salt, expected] = stored.split(':');
        if (!salt || !expected) return false;
        const actual = crypto.scryptSync(secret, salt, 64).toString('base64url');
        return safeEqualText(actual, expected);
    }

    // Legacy compatibility: older database records may store SHA-256 hex.
    if (/^[a-f0-9]{64}$/i.test(stored)) {
        const actual = crypto.createHash('sha256').update(secret).digest('hex');
        return safeEqualText(actual, stored.toLowerCase());
    }

    return false;
}

export async function getStoredWebPasswordHash(): Promise<string> {
    const stored = await getSetting<string>(WEB_PASSWORD_KEY, '');
    return stored || '';
}

export async function isInitialSetupRequired(): Promise<boolean> {
    return !(await getStoredWebPasswordHash());
}

export async function verifyWebPassword(password: string): Promise<boolean> {
    return verifySecret(password, await getStoredWebPasswordHash());
}

export async function verifyTelegramPin(pin: string): Promise<boolean> {
    const stored = await getSetting<string>(TELEGRAM_PIN_KEY, '');
    if (stored) return verifySecret(pin, stored);

    // Migration fallback for old deployments that used the web password in Bot.
    return verifySecret(pin, await getStoredWebPasswordHash());
}

export function validateWebPassword(password: unknown): string | null {
    if (typeof password !== 'string' || password.length < 8) {
        return '网页管理员密码至少需要 8 位';
    }
    if (password.length > 256) {
        return '网页管理员密码过长';
    }
    return null;
}

export function validateTelegramPin(pin: unknown): string | null {
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
        return 'Telegram Bot 密码必须是 4 位数字';
    }
    return null;
}

type SetupQueryClient = Pick<PoolClient, 'query'>;

export async function createInitialAdminCredentialsWithClient(client: SetupQueryClient, webPassword: string, telegramPin: string): Promise<void> {
    const webError = validateWebPassword(webPassword);
    if (webError) throw new Error(webError);

    const pinError = validateTelegramPin(telegramPin);
    if (pinError) throw new Error(pinError);

    if (webPassword === telegramPin) {
        throw new Error('网页密码不能与 Telegram Bot 4 位密码相同');
    }

    await client.query(`SELECT pg_advisory_xact_lock(hashtext('tg-vault:initial-admin-setup'))`);
    const existing = await client.query('SELECT value FROM system_settings WHERE key = $1 FOR UPDATE', [WEB_PASSWORD_KEY]);
    if ((existing.rowCount || 0) > 0 && existing.rows[0]?.value) {
        throw new Error('管理员密码已创建，不能重复初始化');
    }
    await client.query(
        'INSERT INTO system_settings (key, value) VALUES ($1, $2)',
        [WEB_PASSWORD_KEY, hashSecret(webPassword)],
    );
    await client.query(
        'INSERT INTO system_settings (key, value) VALUES ($1, $2)',
        [TELEGRAM_PIN_KEY, hashSecret(telegramPin)],
    );
}

export async function createInitialAdminCredentials(webPassword: string, telegramPin: string): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await createInitialAdminCredentialsWithClient(client, webPassword, telegramPin);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

function parseUserIds(value: string | null | undefined): number[] {
    if (!value) return [];
    return [...new Set(String(value)
        .split(',')
        .map(item => Number(item.trim()))
        .filter(item => Number.isSafeInteger(item) && item > 0))];
}

export async function getConfiguredTelegramAllowedUsers(): Promise<number[]> {
    const envUsers = parseUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS || '');
    if (envUsers.length > 0) return envUsers;
    const stored = await getSetting<string>(TELEGRAM_ALLOWED_USERS_KEY, '');
    return parseUserIds(stored || '');
}

export async function addTelegramAllowedUser(userId: number): Promise<number[]> {
    const users = await getConfiguredTelegramAllowedUsers();
    if (!users.includes(userId)) users.push(userId);
    await setSetting(TELEGRAM_ALLOWED_USERS_KEY, users.join(','));
    return users;
}
