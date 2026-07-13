import { Response } from 'express';
import { storageManager, StorageQuotaCooldownError, isStorageQuotaCooldownError, type StorageTargetSnapshot } from './storage.js';
import {
    getStorageAccountCooldown,
    describeStorageCooldownRecovery,
    STORAGE_COOLDOWN_REASON_DAILY_UPLOAD_LIMIT,
    type StorageAccountCooldown,
} from './storageCooldown.js';

export interface StorageCooldownHttpErrorBody {
    error: string;
    code: 'storage_account_cooling';
    provider: string;
    reason: string;
    retryAt: string;
}

export function formatStorageCooldownNotice(cooldownUntil: Date): string {
    return [
        '⏸️ Google Drive 今日上传额度已达上限',
        '',
        '当前任务已自动暂停，剩余文件不会丢失；无需点击“继续”。',
        describeStorageCooldownRecovery(cooldownUntil),
        '',
        `恢复时间：${cooldownUntil.toISOString()}`,
    ].join('\n');
}

export function buildStorageCooldownHttpError(error: StorageQuotaCooldownError): { status: number; body: StorageCooldownHttpErrorBody } {
    return {
        status: 429,
        body: {
            error: error.message || 'Google Drive 今日上传额度已达上限，请稍后重试。',
            code: 'storage_account_cooling',
            provider: error.provider,
            reason: error.reason,
            retryAt: error.cooldownUntil.toISOString(),
        },
    };
}

export function sendStorageCooldownHttpError(res: Response, error: StorageQuotaCooldownError): void {
    const payload = buildStorageCooldownHttpError(error);
    res.status(payload.status).json(payload.body);
}

export async function getStorageCooldown(target: StorageTargetSnapshot): Promise<StorageAccountCooldown | null> {
    if (target.provider.name !== 'google_drive' || !target.accountId) return null;
    return getStorageAccountCooldown(target.accountId, target.provider.name, STORAGE_COOLDOWN_REASON_DAILY_UPLOAD_LIMIT);
}

export async function getActiveStorageCooldown(): Promise<StorageAccountCooldown | null> {
    return getStorageCooldown(storageManager.getActiveTarget());
}

export async function assertStorageTargetWritable(target: StorageTargetSnapshot): Promise<void> {
    const cooldown = await getStorageCooldown(target);
    if (!cooldown) return;
    throw new StorageQuotaCooldownError('Google Drive 今日上传额度已达上限，请等待自动恢复后再上传，或临时切换其它存储源。', {
        provider: cooldown.provider,
        reason: cooldown.reason,
        storageAccountId: cooldown.storageAccountId,
        cooldownUntil: cooldown.cooldownUntil,
    });
}

export async function assertActiveStorageWritable(): Promise<void> {
    return assertStorageTargetWritable(storageManager.getActiveTarget());
}

export function isStorageCooldownError(error: unknown): error is StorageQuotaCooldownError {
    return isStorageQuotaCooldownError(error);
}
