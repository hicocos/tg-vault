/**
 * 孤儿文件清理服务
 * 
 * 扫描 uploads 目录，删除不在数据库中的"孤儿文件"
 * 解决进程崩溃/重启导致的文件残留问题
 */

import fs from 'fs';
import path from 'path';
import { query } from '../db/index.js';
import { getRelativeStoragePath, safeUnlink } from '../utils/localPath.js';

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
const THUMBNAIL_DIR = path.resolve(process.env.THUMBNAIL_DIR || './data/thumbnails');
const YTDLP_WORK_DIR = path.resolve(process.env.YTDLP_WORK_DIR || path.join(UPLOAD_DIR, 'ytdlp'));
const ORPHAN_MIN_AGE_MS = Math.max(60_000, parseInt(process.env.ORPHAN_CLEANUP_MIN_AGE_MS || '600000', 10) || 600_000);

export function isReservedTransientUploadPath(filePath: string, reservedDirs: string[] = [YTDLP_WORK_DIR]): boolean {
    const resolvedPath = path.resolve(filePath);
    return reservedDirs.some(directory => {
        const resolvedDirectory = path.resolve(directory);
        return resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${path.sep}`);
    });
}

export function isAutoCleanupEnabled(): boolean {
    return ['1', 'true', 'yes', 'on'].includes((process.env.AUTO_CLEANUP_ORPHANS || 'true').toLowerCase());
}

// 清理统计结果
export interface CleanupStats {
    deletedCount: number;
    freedBytes: number;
    freedSpace: string;  // 人类可读格式
    deletedFiles: string[];  // 删除的文件列表
}

// 格式化字节数为人类可读格式
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 递归获取目录下所有文件
export function getAllFiles(
    dirPath: string,
    arrayOfFiles: { name: string; path: string; size: number }[] = [],
    reservedDirs: string[] = [YTDLP_WORK_DIR],
): { name: string; path: string; size: number }[] {
    if (isReservedTransientUploadPath(dirPath, reservedDirs)) {
        return arrayOfFiles;
    }
    if (!fs.existsSync(dirPath)) {
        return arrayOfFiles;
    }

    try {
        const files = fs.readdirSync(dirPath);

        for (const file of files) {
            const fullPath = path.join(dirPath, file);
            try {
                const stat = fs.lstatSync(fullPath);
                if (stat.isSymbolicLink()) {
                    continue;
                }
                if (stat.isDirectory()) {
                    if (!isReservedTransientUploadPath(fullPath, reservedDirs)) {
                        getAllFiles(fullPath, arrayOfFiles, reservedDirs);
                    }
                } else if (!isReservedTransientUploadPath(fullPath, reservedDirs)) {
                    arrayOfFiles.push({
                        name: file,
                        path: fullPath,
                        size: stat.size
                    });
                }
            } catch (e) {
                console.warn(`🧹 无法读取文件状态: ${fullPath}`, e);
            }
        }
    } catch (e) {
        console.error(`🧹 无法读取目录: ${dirPath}`, e);
    }

    return arrayOfFiles;
}

// 删除空文件夹（递归）
function removeEmptyDirectories(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;

    try {
        const files = fs.readdirSync(dirPath);

        // 先递归处理子目录
        for (const file of files) {
            const fullPath = path.join(dirPath, file);
            try {
                if (isReservedTransientUploadPath(fullPath)) continue;
                const stat = fs.lstatSync(fullPath);
                if (stat.isSymbolicLink()) continue;
                if (stat.isDirectory()) {
                    removeEmptyDirectories(fullPath);
                }
            } catch (e) { /* ignore */ }
        }

        // 再检查当前目录是否为空
        const remainingFiles = fs.readdirSync(dirPath);
        if (remainingFiles.length === 0 && dirPath !== UPLOAD_DIR) {
            fs.rmdirSync(dirPath);
            console.log(`🧹 删除空文件夹: ${dirPath}`);
        }
    } catch (e) {
        console.warn(`🧹 删除空文件夹失败: ${dirPath}`, e);
    }
}

/**
 * 清理孤儿文件
 * 扫描 uploads 目录，删除不在数据库中的文件
 */
export async function cleanupOrphanFiles(): Promise<CleanupStats> {
    const stats: CleanupStats = {
        deletedCount: 0,
        freedBytes: 0,
        freedSpace: '0 B',
        deletedFiles: []
    };

    console.log('🧹 开始扫描孤儿文件...');

    try {
        // 1. 从数据库获取所有本地已注册文件的相对存储路径
        const dbResult = await query(`
            SELECT stored_name, folder, path
            FROM files
            WHERE source = 'local'
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

        // 2. 扫描 uploads 目录下所有文件
        const diskFiles = getAllFiles(UPLOAD_DIR);
        console.log(`🧹 磁盘上文件数: ${diskFiles.length}`);

        // 3. 找出孤儿文件并删除
        for (const file of diskFiles) {
            const relativePath = getRelativeStoragePath(UPLOAD_DIR, file.path);
            if (relativePath && !dbFileSet.has(relativePath)) {
                const ageMs = Date.now() - fs.statSync(file.path).mtimeMs;
                if (ageMs < ORPHAN_MIN_AGE_MS) continue;
                try {
                    await safeUnlink(file.path, UPLOAD_DIR);
                    stats.deletedCount++;
                    stats.freedBytes += file.size;
                    stats.deletedFiles.push(relativePath);
                    console.log(`🧹 删除孤儿文件: ${file.path} (${formatBytes(file.size)})`);
                } catch (e) {
                    console.error(`🧹 删除文件失败: ${file.path}`, e);
                }
            }
        }

        // 4. 删除空文件夹
        removeEmptyDirectories(UPLOAD_DIR);

        stats.freedSpace = formatBytes(stats.freedBytes);

        if (stats.deletedCount > 0) {
            console.log(`🧹 清理完成: 删除 ${stats.deletedCount} 个孤儿文件，释放 ${stats.freedSpace}`);
        } else {
            console.log('🧹 扫描完成: 没有发现孤儿文件');
        }

    } catch (error) {
        console.error('🧹 孤儿文件清理失败:', error);
        throw error;
    }

    return stats;
}

// 定期清理定时器
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * 启动定期清理任务
 * 默认每小时执行一次
 */
export function startPeriodicCleanup(intervalMs: number = 60 * 60 * 1000): void {
    if (!isAutoCleanupEnabled()) {
        console.log('🧹 自动孤儿文件清理已关闭 (AUTO_CLEANUP_ORPHANS=false)');
        return;
    }

    if (cleanupInterval) {
        clearInterval(cleanupInterval);
    }

    cleanupInterval = setInterval(async () => {
        console.log('🧹 执行定期孤儿文件清理...');
        try {
            const stats = await cleanupOrphanFiles();
            if (stats.deletedCount > 0) {
                console.log(`🧹 定期清理完成: 删除 ${stats.deletedCount} 个文件，释放 ${stats.freedSpace}`);
            }
        } catch (e) {
            console.error('🧹 定期清理失败:', e);
        }
    }, intervalMs);

    console.log(`🧹 已启动定期清理任务 (间隔: ${intervalMs / 1000 / 60} 分钟)`);
}

/**
 * 停止定期清理任务
 */
export function stopPeriodicCleanup(): void {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
        console.log('🧹 已停止定期清理任务');
    }
}
