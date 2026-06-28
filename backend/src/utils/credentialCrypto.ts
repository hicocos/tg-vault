import crypto from 'crypto';
import { getExistingPersistentSecret, getOrCreatePersistentSecret } from './secretStore.js';

const ENCRYPTION_PREFIX = 'enc:v1:';

const SENSITIVE_CONFIG_KEYS = new Set([
    'clientSecret',
    'refreshToken',
    'accessKeySecret',
    'password',
]);

const SENSITIVE_SETTING_KEYS = new Set([
    'onedrive_client_secret',
    'onedrive_refresh_token',
    'google_drive_client_secret',
    'google_drive_refresh_token',
]);

function getCredentialSecret(): string {
    const secret = getOrCreatePersistentSecret('STORAGE_CREDENTIALS_SECRET', 'storage_credentials_secret');
    if (secret.length < 32) {
        throw new Error('STORAGE_CREDENTIALS_SECRET must be at least 32 characters long. Remove the generated secret file or set STORAGE_CREDENTIALS_SECRET to a value from: openssl rand -hex 32');
    }
    const sessionSecret = process.env.SESSION_SECRET || getExistingPersistentSecret('session_secret');
    if (sessionSecret && secret === sessionSecret) {
        throw new Error('STORAGE_CREDENTIALS_SECRET must be independent from SESSION_SECRET. Remove the generated secret file or set a separate value.');
    }
    process.env.STORAGE_CREDENTIALS_SECRET = secret;
    return secret;
}

function getKey(): Buffer {
    return crypto.createHash('sha256').update(getCredentialSecret()).digest();
}

export function isEncryptedCredential(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
}

export function encryptCredential(value: string): string {
    if (!value || isEncryptedCredential(value)) return value;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENCRYPTION_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptCredential(value: string): string {
    if (!isEncryptedCredential(value)) return value;
    const [, , ivText, tagText, cipherText] = value.split(':');
    if (!ivText || !tagText || !cipherText) {
        throw new Error('Invalid encrypted credential format');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
        decipher.update(Buffer.from(cipherText, 'base64url')),
        decipher.final(),
    ]).toString('utf8');
}

export function isSensitiveSettingKey(key: string): boolean {
    return SENSITIVE_SETTING_KEYS.has(key);
}

export function encryptSettingValue(key: string, value: string): string {
    return isSensitiveSettingKey(key) ? encryptCredential(value) : value;
}

export function decryptSettingValue(key: string, value: string): string {
    return isSensitiveSettingKey(key) ? decryptCredential(value) : value;
}

export function encryptStorageConfig<T extends Record<string, any>>(config: T): T {
    const encrypted: Record<string, any> = { ...config };
    for (const key of Object.keys(encrypted)) {
        if (SENSITIVE_CONFIG_KEYS.has(key) && typeof encrypted[key] === 'string' && encrypted[key]) {
            encrypted[key] = encryptCredential(encrypted[key]);
        }
    }
    return encrypted as T;
}

export function decryptStorageConfig<T extends Record<string, any>>(config: T): T {
    const decrypted: Record<string, any> = { ...config };
    for (const key of Object.keys(decrypted)) {
        if (SENSITIVE_CONFIG_KEYS.has(key) && typeof decrypted[key] === 'string' && decrypted[key]) {
            decrypted[key] = decryptCredential(decrypted[key]);
        }
    }
    return decrypted as T;
}

export function storageConfigNeedsEncryption(config: Record<string, any>): boolean {
    return Object.entries(config).some(([key, value]) => (
        SENSITIVE_CONFIG_KEYS.has(key)
        && typeof value === 'string'
        && value.length > 0
        && !isEncryptedCredential(value)
    ));
}
