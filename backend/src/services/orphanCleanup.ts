/**
 * 孤儿文件清理服务
 *
 * 以异步流式方式扫描 uploads，删除未被数据库索引且超过保护期的文件。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/index.js';
import { getRelativeStoragePath, safeUnlink } from '../utils/localPath.js';
import { formatBytes } from '../utils/fileMetadata.js';
import { getSetting } from '../utils/settings.js';

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
const ORPHAN_MIN_AGE_MS = Math.max(60_000, parseInt(process.env.ORPHAN_CLEANUP_MIN_AGE_MS || '600000', 10) || 600_000);
const YIELD_EVERY = Math.max(25, parseInt(process.env.ORPHAN_CLEANUP_YIELD_EVERY || '250', 10) || 250);

export interface ScannedFile {
    name: string;
    path: string;
    size: number;
    mtimeMs: number;
}

export function isReservedTransientUploadPath(filePath: string, reservedDirs: string[] = []): boolean {
    const resolvedPath = path.resolve(filePath);
    return reservedDirs.some(directory => {
        const resolvedDirectory = path.resolve(directory);
        return resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${path.sep}`);
    });
}

export function isAutoCleanupEnabled(): boolean {
    return ['1', 'true', 'yes', 'on'].includes((process.env.AUTO_CLEANUP_ORPHANS || 'true').toLowerCase());
}

export async function applyPersistedOrphanCleanupSetting(): Promise<boolean> {
    const configured = await getSetting('auto_cleanup_orphans', process.env.AUTO_CLEANUP_ORPHANS || 'true');
    const enabled = ['1', 'true', 'yes', 'on'].includes(String(configured ?? 'true').toLowerCase());
    process.env.AUTO_CLEANUP_ORPHANS = String(enabled);
    return enabled;
}

export interface CleanupStats {
    deletedCount: number;
    freedBytes: number;
    freedSpace: string;
    deletedFiles: string[];
}

async function yieldToEventLoop(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

/**
 * Streams files without following symlinks or entering reserved transient workspaces.
 * Read/stat races are logged and skipped rather than aborting the maintenance run.
 */
export async function* walkFiles(
    dirPath: string,
    reservedDirs: string[] = [],
    state: { visited: number } = { visited: 0 },
): AsyncGenerator<ScannedFile> {
    if (isReservedTransientUploadPath(dirPath, reservedDirs)) return;

    let directory;
    try {
        directory = await fs.opendir(dirPath);
    } catch (error: any) {
        if (error?.code !== 'ENOENT') console.warn(`🧹 无法读取目录: ${dirPath}`, error);
        return;
    }

    try {
        for await (const entry of directory) {
            const fullPath = path.join(dirPath, entry.name);
            if (isReservedTransientUploadPath(fullPath, reservedDirs)) continue;
            try {
                const stat = await fs.lstat(fullPath);
                if (stat.isSymbolicLink()) continue;
                if (stat.isDirectory()) {
                    yield* walkFiles(fullPath, reservedDirs, state);
                } else if (stat.isFile()) {
                    yield { name: entry.name, path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
                }
            } catch (error: any) {
                if (error?.code !== 'ENOENT') console.warn(`🧹 无法读取文件状态: ${fullPath}`, error);
            }
            state.visited += 1;
            if (state.visited % YIELD_EVERY === 0) await yieldToEventLoop();
        }
    } catch (error: any) {
        if (error?.code !== 'ENOENT') console.warn(`🧹 扫描目录失败: ${dirPath}`, error);
    }
}

/** Compatibility helper for callers/tests that need a materialized snapshot. */
export async function getAllFiles(dirPath: string, reservedDirs: string[] = []): Promise<ScannedFile[]> {
    const files: ScannedFile[] = [];
    for await (const file of walkFiles(dirPath, reservedDirs)) files.push(file);
    return files;
}

async function removeEmptyDirectories(dirPath: string, reservedDirs: string[] = []): Promise<void> {
    if (isReservedTransientUploadPath(dirPath, reservedDirs)) return;
    let entries;
    try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error: any) {
        if (error?.code !== 'ENOENT') console.warn(`🧹 无法读取待清理目录: ${dirPath}`, error);
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (isReservedTransientUploadPath(fullPath, reservedDirs) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await removeEmptyDirectories(fullPath, reservedDirs);
    }

    if (path.resolve(dirPath) === UPLOAD_DIR) return;
    try {
        const remaining = await fs.readdir(dirPath);
        if (remaining.length === 0) {
            await fs.rmdir(dirPath);
            console.log(`🧹 删除空文件夹: ${dirPath}`);
        }
    } catch (error: any) {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) console.warn(`🧹 删除空文件夹失败: ${dirPath}`, error);
    }
}

async function runCleanup(): Promise<CleanupStats> {
    const stats: CleanupStats = { deletedCount: 0, freedBytes: 0, freedSpace: '0 B', deletedFiles: [] };
    console.log('🧹 开始扫描孤儿文件...');

    const dbResult = await query(`
        SELECT stored_name, folder, path
        FROM files
        WHERE storage_account_id IS NULL
          AND mime_type IS DISTINCT FROM 'application/x-directory'
    `);
    const dbFileSet = new Set<string>();
    for (const row of dbResult.rows) {
        if (row.path) {
            const relativePath = getRelativeStoragePath(UPLOAD_DIR, row.path);
            if (relativePath) dbFileSet.add(relativePath);
        }
        if (row.stored_name) {
            const key = [row.folder, row.stored_name].filter(Boolean).join('/');
            if (key) dbFileSet.add(key);
        }
    }
    console.log(`🧹 数据库中已注册文件数: ${dbFileSet.size}`);

    let scannedCount = 0;
    const now = Date.now();
    for await (const file of walkFiles(UPLOAD_DIR)) {
        scannedCount += 1;
        const relativePath = getRelativeStoragePath(UPLOAD_DIR, file.path);
        if (!relativePath || dbFileSet.has(relativePath) || now - file.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
        try {
            await safeUnlink(file.path, UPLOAD_DIR);
            stats.deletedCount += 1;
            stats.freedBytes += file.size;
            stats.deletedFiles.push(relativePath);
            console.log(`🧹 删除孤儿文件: ${file.path} (${formatBytes(file.size)})`);
        } catch (error) {
            console.error(`🧹 删除文件失败: ${file.path}`, error);
        }
    }
    console.log(`🧹 磁盘上文件数: ${scannedCount}`);

    await removeEmptyDirectories(UPLOAD_DIR);
    stats.freedSpace = formatBytes(stats.freedBytes);
    console.log(stats.deletedCount > 0
        ? `🧹 清理完成: 删除 ${stats.deletedCount} 个孤儿文件，释放 ${stats.freedSpace}`
        : '🧹 扫描完成: 没有发现孤儿文件');
    return stats;
}

let cleanupInFlight: Promise<CleanupStats> | null = null;

/** Concurrent triggers share one run so periodic/manual cleanup never overlaps. */
export function cleanupOrphanFiles(): Promise<CleanupStats> {
    if (cleanupInFlight) return cleanupInFlight;
    cleanupInFlight = runCleanup()
        .catch(error => {
            console.error('🧹 孤儿文件清理失败:', error);
            throw error;
        })
        .finally(() => { cleanupInFlight = null; });
    return cleanupInFlight;
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function startPeriodicCleanup(intervalMs: number = 60 * 60 * 1000): void {
    if (!isAutoCleanupEnabled()) {
        console.log('🧹 自动孤儿文件清理已关闭 (AUTO_CLEANUP_ORPHANS=false)');
        return;
    }
    if (cleanupInterval) clearInterval(cleanupInterval);
    cleanupInterval = setInterval(() => {
        console.log('🧹 执行定期孤儿文件清理...');
        void cleanupOrphanFiles().then(stats => {
            if (stats.deletedCount > 0) console.log(`🧹 定期清理完成: 删除 ${stats.deletedCount} 个文件，释放 ${stats.freedSpace}`);
        }).catch(error => console.error('🧹 定期清理失败:', error));
    }, intervalMs);
    cleanupInterval.unref?.();
    console.log(`🧹 已启动定期清理任务 (间隔: ${intervalMs / 1000 / 60} 分钟)`);
}

export function stopPeriodicCleanup(): void {
    if (!cleanupInterval) return;
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('🧹 已停止定期清理任务');
}
