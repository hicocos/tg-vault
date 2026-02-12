import { Api } from 'telegram';
import { query } from '../db/index.js';
import checkDiskSpaceModule from 'check-disk-space';
import os from 'os';
import fs from 'fs';
import { formatBytes, getTypeEmoji } from '../utils/telegramUtils.js';
import { authenticatedUsers, passwordInputState, isAuthenticated } from './telegramState.js';
import { getDownloadQueueStats, getTaskStatus } from './telegramUpload.js';
import { storageManager } from './storage.js';

// ESM compatibility
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;

export async function handleStart(message: Api.Message, senderId: number): Promise<void> {
    if (isAuthenticated(senderId)) {
        await message.reply({
            message: ` 欢迎回来!\n\n您已通过验证，可以直接使用:\n\n📤 发送或转发任意文件上传（支持最大2GB）\n📊 /storage - 查看存储空间\n📋 /list - 查看最近上传\n❓ /help - 显示帮助`,
        });
    } else {
        passwordInputState.set(senderId, { password: '' });
    }
}

export async function handleHelp(message: Api.Message): Promise<void> {
    await message.reply({
        message: `📖 **FoomClous Bot 帮助**\n\n**命令:**\n├ /start - 开始/验证\n├ /storage - 查看存储空间\n├ /list [n] - 查看最近上传 (默认10)\n├ /tasks - 查看任务队列状态\n├ /delete <ID> - 删除文件\n└ /help - 显示帮助\n\n**上传文件:**\n直接发送或转发任意文件即可上传\n✨ 支持最大 **2GB** 文件！`,
    });
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
        const queueInfo = `\n\n**当前下载队列:**\n` +
            `├ 🔄 正在处理: ${queueStats.active}\n` +
            `└ ⏳ 等待中: ${queueStats.pending}`;

        const reply = `📊 **存储空间统计**\n\n` +
            `**服务器磁盘:**\n` +
            `├ 📦 总容量: ${formatBytes(diskSpace.size)}\n` +
            `├ 💾 已使用: ${formatBytes(diskSpace.size - diskSpace.free)} (${usedPercent}%)\n` +
            `└ 📂 可用: ${formatBytes(diskSpace.free)}\n\n` +
            `**FoomClous 存储:**\n` +
            `├ 📁 文件数量: ${fileCount}\n` +
            `└ 💾 占用空间: ${formatBytes(totalSize)}` +
            queueInfo;

        await message.reply({ message: reply });
    } catch (error) {
        console.error('🤖 获取存储统计失败:', error);
        await message.reply({ message: '❌ 获取存储统计失败' });
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
            await message.reply({ message: '📭 暂无上传的文件' });
            return;
        }

        let reply = `📋 **最近上传的文件** (${result.rows.length})\n\n`;

        result.rows.forEach((file: any, index: number) => {
            const typeEmoji = getTypeEmoji(file.type === 'image' ? 'image/' :
                file.type === 'video' ? 'video/' :
                    file.type === 'audio' ? 'audio/' : 'other');
            const size = formatBytes(parseInt(file.size));
            const date = new Date(file.created_at).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });

            // 截断过长的文件名
            let displayName = file.name;
            if (displayName.length > 25) {
                displayName = displayName.substring(0, 22) + '...';
            }

            reply += `${index + 1}. ${typeEmoji} ${displayName}\n`;
            reply += `   └ ${size} | ${date}\n`;
            if (file.folder) {
                reply += `   └ 📁 ${file.folder}\n`;
            }
            reply += `   └ ID: \`${file.id.substring(0, 8)}\`\n\n`;
        });

        reply += `\n💡 删除文件: /delete <ID前8位>`;

        await message.reply({ message: reply });
    } catch (error) {
        console.error('🤖 获取文件列表失败:', error);
        await message.reply({ message: '❌ 获取文件列表失败' });
    }
}

export async function handleDelete(message: Api.Message, args: string[]): Promise<void> {
    if (args.length === 0) {
        await message.reply({ message: '❌ 请提供至少 4 位文件 ID\n\n用法: /delete <ID前缀>\n示例: /delete a1b2c3d4' });
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
        if (file.source === 'onedrive') {
            try {
                const provider = storageManager.getProvider(`onedrive:${file.storage_account_id}`);
                await provider.deleteFile(file.path);
            } catch (err) {
                console.warn('🤖 OneDrive 文件物理删除失败或文件已不存在:', err);
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

        await message.reply({ message: `✅ 文件已删除\n\n📄 文件名: ${file.name}\n🗑️ ID: ${file.id}` });
    } catch (error) {
        console.error('🤖 删除文件失败:', error);
        await message.reply({ message: `❌ 删除文件失败: ${(error as Error).message}` });
    }
}

export async function handleTasks(message: Api.Message): Promise<void> {
    try {
        const status = getTaskStatus();
        const activeCount = status.active.length;
        const pendingCount = status.pending.length;
        const historyCount = status.history.length;

        if (activeCount === 0 && pendingCount === 0 && historyCount === 0) {
            await message.reply({ message: '📭 当前没有正在进行的任务，也没有历史记录。' });
            return;
        }

        let reply = `📋 **任务队列状态**\n`;
        reply += `🔄 进行中: ${activeCount} | ⏳ 等待中: ${pendingCount}\n\n`;

        if (activeCount > 0) {
            reply += `**🔄 正在处理:**\n`;
            status.active.forEach((task) => {
                reply += `• ${task.fileName}\n`;
                if (task.totalSize && task.downloadedSize) {
                    const progress = Math.round((task.downloadedSize / task.totalSize) * 100);
                    reply += `  └ ${progress}% (${formatBytes(task.downloadedSize)}/${formatBytes(task.totalSize)})\n`;
                } else {
                    reply += `  └ 正在下载/上传...\n`;
                }
            });
            reply += `\n`;
        }

        if (pendingCount > 0) {
            reply += `**⏳ 等待队列 (前 5 个):**\n`;
            status.pending.slice(0, 5).forEach((task, index) => {
                reply += `${index + 1}. ${task.fileName}\n`;
            });
            if (pendingCount > 5) {
                reply += `... 以及其他 ${pendingCount - 5} 个任务\n`;
            }
            reply += `\n`;
        }

        if (historyCount > 0) {
            reply += `**🕒 最近完成 (前 5 个):**\n`;
            status.history.slice(0, 5).forEach((task) => {
                const icon = task.status === 'success' ? '✅' : '❌';
                reply += `${icon} ${task.fileName}\n`;
                if (task.status === 'failed' && task.error) {
                    reply += `  └ 错误: ${task.error}\n`;
                }
            });
        }

        await message.reply({ message: reply });

    } catch (error) {
        console.error('🤖 获取任务列表失败:', error);
        await message.reply({ message: '❌ 获取任务列表失败' });
    }
}
