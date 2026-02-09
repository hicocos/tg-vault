import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

export const ACCESS_PASSWORD_HASH = process.env.ACCESS_PASSWORD_HASH || '';
export const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
export const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000;
