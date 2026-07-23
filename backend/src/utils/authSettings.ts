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

export async function changeWebPasswordAndRevokeSessions(currentPassword: string, newPassword: string): Promise<void> {
    const validationError = validateWebPassword(newPassword);
    if (validationError) throw new Error(validationError);
    if (currentPassword === newPassword) throw new Error('新密码不能与当前密码相同');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('tg-vault:web-password-change'))`);
        const current = await client.query('SELECT value FROM system_settings WHERE key = $1 FOR UPDATE', [WEB_PASSWORD_KEY]);
        const storedHash = String(current.rows[0]?.value || '');
        if (!verifySecret(currentPassword, storedHash)) throw new Error('当前密码不正确');
        await client.query(
            `UPDATE system_settings SET value = $2, updated_at = NOW() WHERE key = $1`,
            [WEB_PASSWORD_KEY, hashSecret(newPassword)],
        );
        await client.query('DELETE FROM web_sessions');
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

export function parseTelegramAllowedUserIds(value: string | null | undefined): number[] {
    if (!value) return [];
    return [...new Set(String(value)
        .split(/[\s,]+/)
        .map(item => Number(item.trim()))
        .filter(item => Number.isSafeInteger(item) && item > 0))].sort((a, b) => a - b);
}

export function serializeTelegramAllowedUserIds(userIds: number[]): string {
    return parseTelegramAllowedUserIds(userIds.join(',')).join(',');
}

export function shouldAutoAllowFirstTelegramUser(allowedUsers: number[], authenticatedUserCount: number): boolean {
    return allowedUsers.length === 0 && authenticatedUserCount === 0;
}

export async function getStoredTelegramAllowedUsers(): Promise<number[]> {
    const stored = await getSetting<string>(TELEGRAM_ALLOWED_USERS_KEY, '');
    return parseTelegramAllowedUserIds(stored || '');
}

export async function getConfiguredTelegramAllowedUsers(): Promise<number[]> {
    const envUsers = parseTelegramAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS || '');
    if (envUsers.length > 0) return envUsers;
    return getStoredTelegramAllowedUsers();
}

export async function countAuthenticatedTelegramUsers(): Promise<number> {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM telegram_auth');
    return Number(result.rows[0]?.count || 0);
}

export async function setTelegramAllowedUsers(userIds: number[]): Promise<number[]> {
    const users = parseTelegramAllowedUserIds(userIds.join(','));
    await setSetting(TELEGRAM_ALLOWED_USERS_KEY, users.join(','));
    return users;
}

export async function addTelegramAllowedUser(userId: number): Promise<number[]> {
    const users = await getStoredTelegramAllowedUsers();
    if (!users.includes(userId)) users.push(userId);
    return setTelegramAllowedUsers(users);
}
