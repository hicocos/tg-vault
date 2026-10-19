import dotenv from 'dotenv';
import { getOrCreatePersistentSecret } from './secretStore.js';
import { normalizeTelegramDownloadWorkers } from './advancedSettings.js';

dotenv.config();

function loadSessionSecret(): string {
    const secret = getOrCreatePersistentSecret('SESSION_SECRET', 'session_secret');
    if (secret.length < 32) {
        throw new Error('SESSION_SECRET must be at least 32 characters long. Remove the generated secret file or set SESSION_SECRET to a value from: openssl rand -hex 32');
    }
    process.env.SESSION_SECRET = secret;
    return secret;
}

export const SESSION_SECRET = loadSessionSecret();
export const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000;
export const TELEGRAM_API_ID = process.env.TELEGRAM_API_ID || '';
export const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || '';
export const TELEGRAM_USER_SESSION_FILE = process.env.TELEGRAM_USER_SESSION_FILE || './data/telegram_user_session.txt';
export const TELEGRAM_DOWNLOAD_WORKERS = normalizeTelegramDownloadWorkers(process.env.TELEGRAM_DOWNLOAD_WORKERS);
export const TELEGRAM_USER_DOWNLOAD_ENABLED = !!TELEGRAM_API_ID && !!TELEGRAM_API_HASH;
