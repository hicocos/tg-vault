export type DuplicateModeSetting = 'copy' | 'skip';

export interface AdvancedSettings {
    telegramDownloadWorkers: number;
    telegramFileConcurrency: number;
    duplicateMode: DuplicateModeSetting;
    autoCleanupOrphans: boolean;
    highRisk: { telegramDownloadWorkers: boolean; telegramFileConcurrency: boolean };
}

const WORKERS = new Set([4, 8, 12, 16]);
const FILE_CONCURRENCY = new Set([1, 2, 3, 4]);

function booleanValue(value: unknown, fallback: boolean): boolean {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function buildAdvancedSettings(input: {
    telegramDownloadWorkers: unknown;
    telegramFileConcurrency: unknown;
    duplicateMode: unknown;
    autoCleanupOrphans: unknown;
}): AdvancedSettings {
    const workers = Number(input.telegramDownloadWorkers);
    const fileConcurrency = Number(input.telegramFileConcurrency);
    const duplicateMode: DuplicateModeSetting = input.duplicateMode === 'skip' ? 'skip' : 'copy';
    return {
        telegramDownloadWorkers: WORKERS.has(workers) ? workers : 4,
        telegramFileConcurrency: FILE_CONCURRENCY.has(fileConcurrency) ? fileConcurrency : 2,
        duplicateMode,
        autoCleanupOrphans: booleanValue(input.autoCleanupOrphans, true),
        highRisk: { telegramDownloadWorkers: workers >= 12, telegramFileConcurrency: fileConcurrency >= 4 },
    };
}

export function normalizeAdvancedSettingsPatch(input: Record<string, unknown>): Record<string, unknown> {
    const entries = Object.entries(input);
    if (entries.length !== 1) throw new Error('每次只允许修改一项高级设置');
    const [key, value] = entries[0];
    if (key === 'telegramDownloadWorkers') {
        const parsed = Number(value);
        if (!WORKERS.has(parsed)) throw new Error('telegramDownloadWorkers 必须是 4/8/12/16');
        return { telegramDownloadWorkers: parsed, highRisk: parsed >= 12 };
    }
    if (key === 'telegramFileConcurrency') {
        const parsed = Number(value);
        if (!FILE_CONCURRENCY.has(parsed)) throw new Error('telegramFileConcurrency 必须是 1/2/3/4');
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
    throw new Error(`不支持的高级设置：${key}`);
}
