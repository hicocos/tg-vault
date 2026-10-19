import { query } from '../db/index.js';

export const STORAGE_COOLDOWN_REASON_DAILY_UPLOAD_LIMIT = 'daily_upload_limit';
export const DEFAULT_STORAGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface StorageAccountCooldown {
    storageAccountId: string;
    provider: string;
    reason: string;
    cooldownUntil: Date;
    lastError?: string | null;
}

export async function markStorageAccountCooldown(
    storageAccountId: string | null | undefined,
    provider: string,
    reason: string,
    cooldownUntil: Date,
    error?: string | null,
): Promise<void> {
    if (!storageAccountId) return;
    await query(
        `INSERT INTO storage_account_cooldowns (storage_account_id, provider, reason, cooldown_until, last_error, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (storage_account_id, provider, reason)
         DO UPDATE SET cooldown_until = EXCLUDED.cooldown_until, last_error = EXCLUDED.last_error, updated_at = NOW()`,
        [storageAccountId, provider, reason, cooldownUntil, error || null],
    );
}

export async function getStorageAccountCooldown(
    storageAccountId: string | null | undefined,
    provider: string,
    reason = STORAGE_COOLDOWN_REASON_DAILY_UPLOAD_LIMIT,
): Promise<StorageAccountCooldown | null> {
    if (!storageAccountId) return null;
    const result = await query(
        `SELECT storage_account_id, provider, reason, cooldown_until, last_error
         FROM storage_account_cooldowns
         WHERE storage_account_id = $1
           AND provider = $2
           AND reason = $3
           AND cooldown_until > NOW()
         LIMIT 1`,
        [storageAccountId, provider, reason],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
        storageAccountId: row.storage_account_id,
        provider: row.provider,
        reason: row.reason,
        cooldownUntil: new Date(row.cooldown_until),
        lastError: row.last_error,
    };
}

export async function isStorageAccountCooling(storageAccountId: string | null | undefined, provider: string): Promise<boolean> {
    return Boolean(await getStorageAccountCooldown(storageAccountId, provider));
}

export async function clearExpiredStorageCooldowns(): Promise<number> {
    const result = await query(`DELETE FROM storage_account_cooldowns WHERE cooldown_until <= NOW()`);
    return result.rowCount || 0;
}

export function describeStorageCooldownRecovery(cooldownUntil: Date): string {
    return `系统会在 ${cooldownUntil.toISOString()} 后重新检查；如果限制已解除，将自动继续，否则会更新冷却时间并继续等待。`;
}
