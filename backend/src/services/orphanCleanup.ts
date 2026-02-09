/**
 * 孤儿文件清理服务
 * 
 * 扫描 uploads 目录，删除不在数据库中的"孤儿文件"
 * 解决进程崩溃/重启导致的文件残留问题
 */

import fs from 'fs';
import path from 'path';
import { query } from '../db/index.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR || './data/thumbnails';

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
function getAllFiles(dirPath: string, arrayOfFiles: { name: string; path: string; size: number }[] = []): { name: string; path: string; size: number }[] {
    if (!fs.existsSync(dirPath)) {
        return arrayOfFiles;
    }

    try {
        const files = fs.readdirSync(dirPath);

        for (const file of files) {
            const fullPath = path.join(dirPath, file);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    getAllFiles(fullPath, arrayOfFiles);
                } else {
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
                if (fs.statSync(fullPath).isDirectory()) {
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
        // 1. 从数据库获取所有已注册的 stored_name
        const dbResult = await query('SELECT stored_name FROM files');
        const dbFileSet = new Set<string>(dbResult.rows.map((row: any) => row.stored_name));

        console.log(`🧹 数据库中已注册文件数: ${dbFileSet.size}`);

        // 2. 扫描 uploads 目录下所有文件
        const diskFiles = getAllFiles(UPLOAD_DIR);
        console.log(`🧹 磁盘上文件数: ${diskFiles.length}`);

        // 3. 找出孤儿文件并删除
        for (const file of diskFiles) {
            // 检查文件名是否在数据库中
            if (!dbFileSet.has(file.name)) {
                try {
                    fs.unlinkSync(file.path);
                    stats.deletedCount++;
                    stats.freedBytes += file.size;
                    stats.deletedFiles.push(file.name);
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
