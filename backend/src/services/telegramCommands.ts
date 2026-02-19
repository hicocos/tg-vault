import { Api } from 'telegram';
import { query } from '../db/index.js';
import checkDiskSpaceModule from 'check-disk-space';
import os from 'os';
import fs from 'fs';
import { formatBytes, getTypeEmoji } from '../utils/telegramUtils.js';
import {
    MSG,
    buildWelcomeBack,
    buildHelp,
    buildStorageReport,
    buildFileList,
    buildTasksReport,
    buildDeleteSuccess,
} from '../utils/telegramMessages.js';
import { authenticatedUsers, passwordInputState, isAuthenticated } from './telegramState.js';
import { getDownloadQueueStats, getTaskStatus } from './telegramUpload.js';
import { storageManager } from './storage.js';

// ESM compatibility
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;

export async function handleStart(message: Api.Message, senderId: number): Promise<void> {
    if (isAuthenticated(senderId)) {
        await message.reply({ message: buildWelcomeBack() });
    } else {
        passwordInputState.set(senderId, { password: '' });
    }
}

export async function handleHelp(message: Api.Message): Promise<void> {
    await message.reply({ message: buildHelp() });
}

export async function handleStorage(message: Api.Message): Promise<void> {
    try {
        const activeAccountId = storageManager.getActiveAccountId();
        const diskPath = os.platform() === 'win32' ? 'C:' : '/';
        const diskSpace = await checkDiskSpace(diskPath);

        // Fetch stats for the active account
        const result = await query(`
            SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size 
            FROM files 
            WHERE storage_account_id IS NOT DISTINCT FROM $1
        `, [activeAccountId]);
        const foomclousStats = result.rows[0];
        const totalSize = parseInt(foomclousStats.total_size);
        const fileCount = parseInt(foomclousStats.file_count);
        const usedPercent = Math.round(((diskSpace.size - diskSpace.free) / diskSpace.size) * 100);

        const queueStats = getDownloadQueueStats();

        const reply = buildStorageReport({
            diskTotal: diskSpace.size,
            diskFree: diskSpace.free,
            diskUsedPercent: usedPercent,
            fileCount,
            totalFileSize: totalSize,
            queueActive: queueStats.active,
            queuePending: queueStats.pending,
        });

        await message.reply({ message: reply });
    } catch (error) {
        console.error('🤖 获取存储统计失败:', error);
        await message.reply({ message: MSG.ERR_STORAGE });
    }
}

export async function handleList(message: Api.Message, args: string[]): Promise<void> {
    try {
        let limit = 10;
        if (args.length > 0) {
            const parsed = parseInt(args[0]);
            if (!isNaN(parsed) && parsed > 0 && parsed <= 50) {
                limit = parsed;
            }
        }

        const activeAccountId = storageManager.getActiveAccountId();
        const result = await query(`
            SELECT id, name, type, size, folder, created_at 
            FROM files 
            WHERE storage_account_id IS NOT DISTINCT FROM $2
            ORDER BY created_at DESC 
            LIMIT $1
        `, [limit, activeAccountId]);

        if (result.rows.length === 0) {
            await message.reply({ message: MSG.EMPTY_FILES });
            return;
        }

        const reply = buildFileList(result.rows, result.rows.length);
        await message.reply({ message: reply });
    } catch (error) {
        console.error('🤖 获取文件列表失败:', error);
        await message.reply({ message: MSG.ERR_FILE_LIST });
    }
}

export async function handleDelete(message: Api.Message, args: string[]): Promise<void> {
    if (args.length === 0) {
        await message.reply({
            message: '❌ 请提供至少 4 位文件 ID\n\n用法: /delete <ID前缀>\n示例: /delete a1b2c3d4'
        });
        return;
    }

    const fileIdPrefix = args[0].trim();
    if (fileIdPrefix.length < 4) {
        await message.reply({ message: '❌ 请提供至少 4 位文件 ID' });
        return;
    }

    try {
        const activeAccountId = storageManager.getActiveAccountId();
        // 查找匹配的文件
        const result = await query(`
            SELECT id, name, path, thumbnail_path, source, storage_account_id 
            FROM files 
            WHERE id::text LIKE $1 AND storage_account_id IS NOT DISTINCT FROM $2
            LIMIT 1
        `, [fileIdPrefix + '%', activeAccountId]);

        if (result.rows.length === 0) {
            await message.reply({ message: `❌ 未找到 ID 以 "${fileIdPrefix}" 开头的文件` });
            return;
        }

        const file = result.rows[0];

        // 删除实际文件
        const cloudSources = ['onedrive', 'aliyun_oss', 's3', 'webdav', 'google_drive'];
        if (cloudSources.includes(file.source)) {
            try {
                const provider = storageManager.getProvider(`${file.source}:${file.storage_account_id}`);
                await provider.deleteFile(file.path);
            } catch (err) {
                console.warn(`🤖 ${file.source} 文件物理删除失败或文件已不存在:`, err);
            }
        } else if (file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }

        // 删除缩略图
        if (file.thumbnail_path && fs.existsSync(file.thumbnail_path)) {
            fs.unlinkSync(file.thumbnail_path);
        }

        // 从数据库删除记录
        await query(`DELETE FROM files WHERE id = $1`, [file.id]);

        await message.reply({ message: buildDeleteSuccess(file.name, file.id) });
    } catch (error) {
        console.error('🤖 删除文件失败:', error);
        await message.reply({ message: `${MSG.ERR_DELETE}: ${(error as Error).message}` });
    }
}

export async function handleTasks(message: Api.Message): Promise<void> {
    try {
        const status = getTaskStatus();
        const activeCount = status.active.length;
        const pendingCount = status.pending.length;
        const historyCount = status.history.length;

        if (activeCount === 0 && pendingCount === 0 && historyCount === 0) {
            await message.reply({ message: MSG.EMPTY_TASKS });
            return;
        }

        const reply = buildTasksReport(status.active, status.pending, status.history);
        await message.reply({ message: reply });

    } catch (error) {
        console.error('🤖 获取任务列表失败:', error);
        await message.reply({ message: MSG.ERR_TASKS });
    }
}
