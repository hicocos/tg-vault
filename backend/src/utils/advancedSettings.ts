export type DuplicateModeSetting = 'copy' | 'skip';
export type TelegramDownloadHistoryPolicySetting = 'errors_only' | 'all';

export interface AdvancedSettings {
    telegramDownloadWorkers: number;
    telegramFileConcurrency: number;
    telegramFileConcurrencyLimit: number;
    telegramEnabledAccounts: number;
    duplicateMode: DuplicateModeSetting;
    autoCleanupOrphans: boolean;
    skipTelegramPhotosInBatch: boolean;
    telegramDownloadHistoryPolicy: TelegramDownloadHistoryPolicySetting;
    highRisk: { telegramDownloadWorkers: boolean; telegramFileConcurrency: boolean };
}

export const DOWNLOAD_WORKER_OPTIONS = [4, 6, 8, 10, 12];

export function normalizeTelegramDownloadWorkers(value: unknown): number {
    const workers = Number(value);
    return DOWNLOAD_WORKER_OPTIONS.includes(workers) ? workers : 4;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function buildAdvancedSettings(input: {
    telegramDownloadWorkers: unknown;
    telegramFileConcurrency: unknown;
    telegramFileConcurrencyLimit: number;
    telegramEnabledAccounts: number;
    duplicateMode: unknown;
    autoCleanupOrphans: unknown;
    skipTelegramPhotosInBatch: unknown;
    telegramDownloadHistoryPolicy: unknown;
}): AdvancedSettings {
    const workers = normalizeTelegramDownloadWorkers(input.telegramDownloadWorkers);
    const fileConcurrency = Number(input.telegramFileConcurrency);
    const duplicateMode: DuplicateModeSetting = input.duplicateMode === 'skip' ? 'skip' : 'copy';
    const telegramDownloadHistoryPolicy: TelegramDownloadHistoryPolicySetting = input.telegramDownloadHistoryPolicy === 'all' ? 'all' : 'errors_only';
    return {
        telegramDownloadWorkers: workers,
        telegramFileConcurrency: Number.isInteger(fileConcurrency) && fileConcurrency >= 1 && fileConcurrency <= 10 ? fileConcurrency : 2,
        telegramFileConcurrencyLimit: input.telegramFileConcurrencyLimit,
        telegramEnabledAccounts: input.telegramEnabledAccounts,
        duplicateMode,
        autoCleanupOrphans: booleanValue(input.autoCleanupOrphans, true),
        skipTelegramPhotosInBatch: booleanValue(input.skipTelegramPhotosInBatch, false),
        telegramDownloadHistoryPolicy,
        highRisk: { telegramDownloadWorkers: workers >= 10, telegramFileConcurrency: fileConcurrency >= 4 },
    };
}

export function normalizeAdvancedSettingsPatch(input: Record<string, unknown>): Record<string, unknown> {
    const entries = Object.entries(input);
    if (entries.length !== 1) throw new Error('每次只允许修改一项高级设置');
    const [key, value] = entries[0];
    if (key === 'telegramDownloadWorkers') {
        const parsed = Number(value);
        if (!DOWNLOAD_WORKER_OPTIONS.includes(parsed)) throw new Error('telegramDownloadWorkers 必须是 4/6/8/10/12');
        return { telegramDownloadWorkers: parsed, highRisk: parsed >= 10 };
    }
    if (key === 'telegramFileConcurrency') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) throw new Error('telegramFileConcurrency 必须是 1–10 的整数');
        return { telegramFileConcurrency: parsed, highRisk: parsed >= 4 };
    }
    if (key === 'duplicateMode') {
        if (value !== 'copy' && value !== 'skip') throw new Error('duplicateMode 必须是 copy 或 skip');
        return { duplicateMode: value, highRisk: false };
    }
    if (key === 'autoCleanupOrphans') {
        if (typeof value !== 'boolean') throw new Error('autoCleanupOrphans 必须是布尔值');
        return { autoCleanupOrphans: value, highRisk: false };
    }
    if (key === 'skipTelegramPhotosInBatch') {
        if (typeof value !== 'boolean') throw new Error('skipTelegramPhotosInBatch 必须是布尔值');
        return { skipTelegramPhotosInBatch: value, highRisk: value };
    }
    if (key === 'telegramDownloadHistoryPolicy') {
        if (value !== 'errors_only' && value !== 'all') throw new Error('telegramDownloadHistoryPolicy 必须是 errors_only 或 all');
        return { telegramDownloadHistoryPolicy: value, highRisk: false };
    }
    throw new Error(`不支持的高级设置：${key}`);
}
