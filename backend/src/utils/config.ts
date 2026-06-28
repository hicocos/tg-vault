import dotenv from 'dotenv';
import { getOrCreatePersistentSecret } from './secretStore.js';

dotenv.config();

export const ACCESS_PASSWORD_HASH = process.env.ACCESS_PASSWORD_HASH || '';

function loadSessionSecret(): string {
    const secret = getOrCreatePersistentSecret('SESSION_SECRET', 'session_secret');
    if (ACCESS_PASSWORD_HASH && secret === ACCESS_PASSWORD_HASH) {
        throw new Error('SESSION_SECRET must be independent from ACCESS_PASSWORD_HASH. Remove the generated secret file or set SESSION_SECRET to a separate value.');
    }
    if (secret.length < 32) {
        throw new Error('SESSION_SECRET must be at least 32 characters long. Remove the generated secret file or set SESSION_SECRET to a value from: openssl rand -hex 32');
    }
    process.env.SESSION_SECRET = secret;
    return secret;
}

export const SESSION_SECRET = loadSessionSecret();
export const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000;
export const TELEGRAM_USER_API_ID = process.env.TELEGRAM_USER_API_ID || '';
export const TELEGRAM_USER_API_HASH = process.env.TELEGRAM_USER_API_HASH || '';
export const TELEGRAM_USER_SESSION_FILE = process.env.TELEGRAM_USER_SESSION_FILE || './data/telegram_user_session.txt';
export const TELEGRAM_DOWNLOAD_BRIDGE_CHAT_ID = process.env.TELEGRAM_DOWNLOAD_BRIDGE_CHAT_ID || '';
export const TELEGRAM_DOWNLOAD_BRIDGE_ENABLED = !!TELEGRAM_DOWNLOAD_BRIDGE_CHAT_ID;
export const TELEGRAM_DOWNLOAD_WORKERS = Math.max(1, Math.min(16, parseInt(process.env.TELEGRAM_DOWNLOAD_WORKERS || '4', 10) || 4));
export const TELEGRAM_USER_DOWNLOAD_ENABLED = !!TELEGRAM_USER_API_ID && !!TELEGRAM_USER_API_HASH;
