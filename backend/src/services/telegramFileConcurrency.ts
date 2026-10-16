import { query } from '../db/index.js';
import { getSetting, setSetting } from '../utils/settings.js';

const SETTING = 'telegram_file_download_concurrency';
let applyRuntime: ((value: number) => void) | undefined;
let updates: Promise<unknown> = Promise.resolve();

export interface FileConcurrencyCapacity {
    enabledAccounts: number;
    maxConcurrency: number;
}

export interface FileConcurrencySettings extends FileConcurrencyCapacity {
    current: number;
}

function updateFileConcurrency<T>(operation: () => Promise<T>): Promise<T> {
    const result = updates.then(operation);
    updates = result.catch(() => undefined);
    return result;
}

export function registerFileConcurrencyRuntime(apply: (value: number) => void): void {
    applyRuntime = apply;
}

export function normalizeFileDownloadConcurrency(value: unknown): number {
    const parsed = Number(value ?? 2);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : 2;
}

export async function getFileConcurrencyCapacity(): Promise<FileConcurrencyCapacity> {
    const result = await query('SELECT COUNT(*)::int AS count FROM telegram_user_accounts WHERE enabled = TRUE AND deleted_at IS NULL');
    const enabledAccounts = Number(result.rows[0].count);
    return { enabledAccounts, maxConcurrency: Math.min(10, Math.max(2, enabledAccounts * 2)) };
}

export class FileConcurrencyLimitError extends Error {
    readonly code = 'FILE_CONCURRENCY_LIMIT';
    constructor(readonly enabledAccounts: number, readonly maxConcurrency: number) {
        super(`已启用 ${enabledAccounts} 个 Telegram 用户账号，最多允许同时下载 ${maxConcurrency} 个文件；无账号时上限为 2，每个启用账号提供 2 个名额，最高 10。`);
    }
}

export function assertFileConcurrencyCapacity(value: number, capacity: FileConcurrencyCapacity): void {
    if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error('同时下载文件数必须是 1–10 的整数');
    if (value > capacity.maxConcurrency) throw new FileConcurrencyLimitError(capacity.enabledAccounts, capacity.maxConcurrency);
}

export function setFileDownloadConcurrency(value: number): Promise<number> {
    return updateFileConcurrency(async () => {
        const capacity = await getFileConcurrencyCapacity();
        assertFileConcurrencyCapacity(value, capacity);
        await setSetting(SETTING, String(value));
        applyRuntime?.(value);
        return value;
    });
}

/** Shrinking capacity stops new starts; existing transfers keep their slots until settlement. */
export function loadFileDownloadConcurrencySetting(): Promise<FileConcurrencySettings> {
    return updateFileConcurrency(async () => {
        const capacity = await getFileConcurrencyCapacity();
        const stored = await getSetting(SETTING, process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY || '2');
        const current = Math.min(normalizeFileDownloadConcurrency(stored), capacity.maxConcurrency);
        if (String(current) !== stored) await setSetting(SETTING, String(current));
        applyRuntime?.(current);
        return { current, ...capacity };
    });
}
