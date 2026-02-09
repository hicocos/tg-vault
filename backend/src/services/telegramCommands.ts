import { Api } from 'telegram';
import { query } from '../db/index.js';
import checkDiskSpaceModule from 'check-disk-space';
import os from 'os';
import fs from 'fs';
import { formatBytes, getTypeEmoji } from '../utils/telegramUtils.js';
import { authenticatedUsers, passwordInputState, isAuthenticated } from './telegramState.js';

// ESM compatibility
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;

export async function handleStart(message: Api.Message, senderId: number): Promise<void> {
    if (isAuthenticated(senderId)) {
        await message.reply({
            message: `👋 欢迎回来!\n\n您已通过验证，可以直接使用:\n\n📤 发送或转发任意文件上传（支持最大2GB）\n📊 /storage - 查看存储空间\n📋 /list - 查看最近上传\n❓ /help - 显示帮助`,
        });
    } else {
        passwordInputState.set(senderId, { password: '' });
        // The calling function will need to handle sending the keyboard as it requires the `generatePasswordKeyboard` function 
        // which might be better placed in utils or passed here.
        // For simplicity, we'll return a specific signal or just let the main loop handle the keyboard if this returns false/special value?
        // Actually, let's move `generatePasswordKeyboard` to utils/telegramUtils.ts or just export it.
    }
}

export async function handleHelp(message: Api.Message): Promise<void> {
    await message.reply({
        message: `📖 **FoomClous Bot 帮助**\n\n**命令:**\n├ /start - 开始/验证\n├ /storage - 查看存储空间\n├ /list [n] - 查看最近上传 (默认10)\n├ /delete <ID> - 删除文件\n└ /help - 显示帮助\n\n**上传文件:**\n直接发送或转发任意文件即可上传\n✨ 支持最大 **2GB** 文件！`,
    });
}

export async function handleStorage(message: Api.Message): Promise<void> {
    try {
        const diskPath = os.platform() === 'win32' ? 'C:' : '/';
        const diskSpace = await checkDiskSpace(diskPath);
        const result = await query(`SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size FROM files`);
        const foomclousStats = result.rows[0];
        const totalSize = parseInt(foomclousStats.total_size);
        const fileCount = parseInt(foomclousStats.file_count);
        const usedPercent = Math.round(((diskSpace.size - diskSpace.free) / diskSpace.size) * 100);

        const reply = `📊 **存储空间统计**\n\n` +
            `**服务器磁盘:**\n` +
            `├ 📦 总容量: ${formatBytes(diskSpace.size)}\n` +
            `├ 💾 已使用: ${formatBytes(diskSpace.size - diskSpace.free)} (${usedPercent}%)\n` +
            `└ 📂 可用: ${formatBytes(diskSpace.free)}\n\n` +
            `**FoomClous 存储:**\n` +
            `├ 📁 文件数量: ${fileCount}\n` +
            `└ 💾 占用空间: ${formatBytes(totalSize)}`;

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

        const result = await query(`
            SELECT id, name, type, size, folder, created_at 
            FROM files 
            ORDER BY created_at DESC 
            LIMIT $1
        `, [limit]);

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
        // 查找匹配的文件
        const result = await query(`
            SELECT id, name, path, thumbnail_path 
            FROM files 
            WHERE id::text LIKE $1
            LIMIT 1
        `, [fileIdPrefix + '%']);

        if (result.rows.length === 0) {
            await message.reply({ message: `❌ 未找到 ID 以 "${fileIdPrefix}" 开头的文件` });
            return;
        }

        const file = result.rows[0];

        // 删除实际文件
        if (file.path && fs.existsSync(file.path)) {
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
