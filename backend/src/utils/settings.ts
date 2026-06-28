import { query } from '../db/index.js';
import { decryptSettingValue, encryptSettingValue } from './credentialCrypto.js';

/**
 * 获取系统设置
 */
export async function getSetting<T = string>(key: string, defaultValue?: T): Promise<T | null> {
    try {
        const res = await query('SELECT value FROM system_settings WHERE key = $1', [key]);
        if (res.rowCount === 0) {
            return defaultValue ?? null;
        }
        return decryptSettingValue(key, res.rows[0].value) as T;
    } catch (e) {
        console.error(`获取设置 ${key} 失败:`, e);
        return defaultValue ?? null;
    }
}

/**
 * 保存系统设置
 */
export async function setSetting(key: string, value: string): Promise<void> {
    try {
        await query(
            'INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
            [key, encryptSettingValue(key, value)]
        );
    } catch (e) {
        console.error(`保存设置 ${key} 失败:`, e);
        throw e;
    }
}
