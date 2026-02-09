import { TelegramClient, Api } from 'telegram';
import { NewMessageEvent } from 'telegram/events/index.js';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/index.js';
import { generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';
import { storageManager } from '../services/storage.js';
import { isAuthenticated } from './telegramState.js';
import { formatBytes, getTypeEmoji, getFileType, getMimeTypeFromFilename, sanitizeFilename } from '../utils/telegramUtils.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';

// 多文件上传队列管理
interface FileUploadItem {
    fileName: string;
    mimeType: string;
    message: Api.Message;
    status: 'pending' | 'uploading' | 'success' | 'failed';
    size?: number;
    fileType?: string;
    error?: string;
    retried?: boolean;           // 是否已重试过
    garbageInfo?: {              // 垃圾缓存信息
        localPath?: string;      // 本地临时文件路径
        estimatedSize?: number;  // 估计的垃圾大小
    };
}

interface MediaGroupQueue {
    chatId: Api.TypeEntityLike | undefined;
    statusMsgId?: number;
    files: FileUploadItem[];
    processingStarted: boolean;
    createdAt: number;
    folderName?: string;  // 多文件上传的文件夹名称（来自消息 caption）
    folderPath?: string;  // 实际创建的文件夹路径
}

// 多文件上传队列 (key: mediaGroupId)
const mediaGroupQueues = new Map<string, MediaGroupQueue>();

// 多文件上传处理延迟（毫秒），等待所有文件消息到达
const MEDIA_GROUP_DELAY = 1500;

// 获取文件预估大小
function getEstimatedFileSize(message: Api.Message): number {
    if (message.document) {
        return Number((message.document as Api.Document).size) || 0;
    }
    if (message.video) {
        return Number((message.video as Api.Document).size) || 0;
    }
    if (message.audio) {
        return Number((message.audio as Api.Document).size) || 0;
    }
    if (message.photo) {
        return 1024 * 1024; // 1MB estimate for photos
    }
    return 0;
}

// 生成进度条
function generateProgressBar(completed: number, total: number, barLength: number = 15): string {
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    const filledLength = Math.round((completed / total) * barLength);
    const emptyLength = barLength - filledLength;

    const filledBar = '▓'.repeat(filledLength);
    const emptyBar = '░'.repeat(emptyLength);

    return `${filledBar}${emptyBar} ${percentage}%`;
}

// 提取文件信息
function extractFileInfo(message: Api.Message): { fileName: string; mimeType: string } | null {
    if (!message.media) return null;

    let fileName = 'unknown';
    let mimeType = 'application/octet-stream';

    try {
        if (message.document) {
            const doc = message.document as Api.Document;
            const fileNameAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || `file_${Date.now()}`;
            mimeType = doc.mimeType || getMimeTypeFromFilename(fileName);

            // 如果是音频/视频但没有文件名属性，尝试根据类型生成
            if (fileName.startsWith('file_')) {
                const videoAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeVideo');
                const audioAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeAudio');
                if (videoAttr) fileName = `video_${Date.now()}.mp4`;
                else if (audioAttr) fileName = `audio_${Date.now()}.mp3`;
            }
        } else if (message.photo) {
            fileName = `photo_${Date.now()}.jpg`;
            mimeType = 'image/jpeg';
        } else if (message.video) {
            const video = message.video as Api.Document;
            const fileNameAttr = video.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || `video_${Date.now()}.mp4`;
            mimeType = video.mimeType || 'video/mp4';
        } else if (message.audio) {
            const audio = message.audio as Api.Document;
            const fileNameAttr = audio.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || `audio_${Date.now()}.mp3`;
            mimeType = audio.mimeType || 'audio/mpeg';
        } else if (message.voice) {
            fileName = `voice_${Date.now()}.ogg`;
            mimeType = 'audio/ogg';
        } else if (message.sticker) {
            fileName = `sticker_${Date.now()}.webp`;
            mimeType = 'image/webp';
        } else {
            // 尝试直接从 media 中提取 document (某些转发场景可能 Getter 失效)
            const media = message.media as any;
            if (media.document && media.document instanceof Api.Document) {
                const doc = media.document;
                const fileNameAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
                fileName = fileNameAttr?.fileName || `file_${Date.now()}`;
                mimeType = doc.mimeType || getMimeTypeFromFilename(fileName);
            } else {
                return null;
            }
        }
    } catch (e) {
        console.error('🤖 提取文件信息出错:', e);
        return null;
    }

    return { fileName: sanitizeFilename(fileName), mimeType };
}

// 下载并保存文件
async function downloadAndSaveFile(
    client: TelegramClient,
    message: Api.Message,
    fileName: string,
    targetDir?: string,
    onProgress?: (downloaded: number, total: number) => void
): Promise<{ filePath: string; actualSize: number; storedName: string } | null> {
    const ext = path.extname(fileName) || '';
    const storedName = `${uuidv4()}${ext}`;
    let saveDir = targetDir || UPLOAD_DIR;

    if (!fs.existsSync(saveDir)) {
        try {
            fs.mkdirSync(saveDir, { recursive: true });
        } catch (err) {
            console.error(`🤖 创建下载目录失败: ${saveDir}`, err);
            // 如果是 UPLOAD_DIR 失败，可能权限有问题
            if (saveDir === UPLOAD_DIR) throw err;
            // 如果是子目录失败，退回到 UPLOAD_DIR
            console.warn(`🤖 退回到默认上传目录: ${UPLOAD_DIR}`);
            saveDir = UPLOAD_DIR;
        }
    }

    const filePath = path.join(saveDir, storedName);

    const totalSize = getEstimatedFileSize(message);
    let downloadedSize = 0;

    try {
        const writeStream = fs.createWriteStream(filePath);

        for await (const chunk of client.iterDownload({
            file: message.media!,
            requestSize: 512 * 1024,
        })) {
            writeStream.write(chunk);
            downloadedSize += chunk.length;

            if (onProgress && totalSize > 0) {
                onProgress(downloadedSize, totalSize);
            }
        }

        writeStream.end();

        await new Promise<void>((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        const stats = fs.statSync(filePath);
        return { filePath, actualSize: stats.size, storedName };
    } catch (error) {
        console.error('🤖 下载文件失败:', error);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return null;
    }
}

// 生成批量上传状态消息
function generateBatchStatusMessage(queue: MediaGroupQueue): string {
    const total = queue.files.length;
    const completed = queue.files.filter(f => f.status === 'success' || f.status === 'failed').length;
    const successful = queue.files.filter(f => f.status === 'success').length;
    const failed = queue.files.filter(f => f.status === 'failed').length;

    let statusIcon = '⏳';
    let statusText = '正在处理多文件上传...';

    if (completed === total) {
        if (failed === 0) {
            statusIcon = '✅';
            statusText = '多文件上传完成!';
        } else if (successful === 0) {
            statusIcon = '❌';
            statusText = '多文件上传失败!';
        } else {
            statusIcon = '⚠️';
            statusText = '多文件上传部分完成';
        }
    }

    let message = `${statusIcon} **${statusText}**\n\n`;

    if (queue.folderName) {
        message += `📁 文件夹: ${queue.folderName}\n`;
    }
    message += `📊 进度: ${completed}/${total}\n`;
    message += `${generateProgressBar(completed, total)}\n\n`;

    queue.files.forEach((file) => {
        let fileIcon = '⏳';
        let fileStatus = '等待中';

        switch (file.status) {
            case 'uploading':
                fileIcon = '🔄';
                fileStatus = '上传中...';
                break;
            case 'success':
                fileIcon = '✅';
                fileStatus = formatBytes(file.size || 0);
                break;
            case 'failed':
                fileIcon = '❌';
                fileStatus = file.error || '失败';
                break;
            case 'pending':
                fileIcon = '⏳';
                fileStatus = '等待中';
                break;
        }

        const typeEmoji = getTypeEmoji(file.mimeType);
        message += `${fileIcon} ${typeEmoji} ${file.fileName}\n`;
        message += `    └ ${fileStatus}\n`;
    });

    return message;
}

// 处理单个文件上传（带重试机制）
async function processFileUpload(client: TelegramClient, file: FileUploadItem, queue?: MediaGroupQueue): Promise<void> {
    file.status = 'uploading';

    if (queue && queue.statusMsgId && queue.chatId) {
        try {
            await client.editMessage(queue.chatId as Api.TypeEntityLike, {
                message: queue.statusMsgId,
                text: generateBatchStatusMessage(queue),
            });
        } catch (e) { /* ignore */ }
    }

    const attemptUpload = async (): Promise<boolean> => {
        let localFilePath: string | undefined;
        let storedName: string | undefined;

        try {
            const targetDir = queue?.folderPath;
            const result = await downloadAndSaveFile(client, file.message, file.fileName, targetDir);
            if (!result) {
                file.error = '下载失败';
                return false;
            }

            localFilePath = result.filePath;
            storedName = result.storedName;
            const actualSize = result.actualSize;
            const fileType = getFileType(file.mimeType);

            // 生成缩略图和获取尺寸（失败不应阻止上传）
            let thumbnailPath: string | null = null;
            let dimensions: { width?: number; height?: number } = {};
            try {
                thumbnailPath = await generateThumbnail(localFilePath, storedName, file.mimeType);
                dimensions = await getImageDimensions(localFilePath, file.mimeType);
            } catch (thumbErr) {
                console.warn('🤖 生成缩略图/获取尺寸失败，继续上传:', thumbErr);
                // 缩略图失败不应阻止文件上传
            }

            const provider = storageManager.getProvider();
            let finalPath = localFilePath;
            let sourceRef = provider.name;

            if (provider.name !== 'local') {
                try {
                    finalPath = await provider.saveFile(localFilePath, storedName, file.mimeType);
                    // 上传成功后删除本地临时文件
                    if (fs.existsSync(localFilePath)) {
                        fs.unlinkSync(localFilePath);
                    }
                } catch (err) {
                    console.error('保存文件到存储提供商失败:', err);
                    // 记录垃圾信息（本地文件还存在）
                    file.garbageInfo = {
                        localPath: localFilePath,
                        estimatedSize: actualSize,
                    };
                    throw err;
                }
            }

            const folderName = queue?.folderName || null;

            await query(`
                INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [file.fileName, storedName, fileType, file.mimeType, actualSize, finalPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, folderName]);

            file.status = 'success';
            file.size = actualSize;
            file.fileType = fileType;
            return true;

        } catch (error) {
            console.error('🤖 文件上传失败:', error);
            file.error = (error as Error).message;

            // 如果还没记录垃圾信息，尝试清理本地临时文件
            if (localFilePath && fs.existsSync(localFilePath)) {
                const stats = fs.statSync(localFilePath);
                file.garbageInfo = {
                    localPath: localFilePath,
                    estimatedSize: stats.size,
                };
            }
            return false;
        }
    };

    // 第一次尝试
    const firstAttemptSuccess = await attemptUpload();

    if (!firstAttemptSuccess && !file.retried) {
        // 自动重试一次
        console.log(`🤖 文件 ${file.fileName} 上传失败，正在清理垃圾缓存并重试...`);

        // 清理垃圾缓存
        if (file.garbageInfo?.localPath && fs.existsSync(file.garbageInfo.localPath)) {
            try {
                fs.unlinkSync(file.garbageInfo.localPath);
                console.log(`🤖 已清理本地临时文件: ${file.garbageInfo.localPath}`);
            } catch (e) {
                console.error('🤖 清理本地临时文件失败:', e);
            }
        }
        file.garbageInfo = undefined;
        file.retried = true;
        file.status = 'uploading';
        file.error = undefined;

        // 更新状态消息显示"正在重试"
        if (queue && queue.statusMsgId && queue.chatId) {
            try {
                await client.editMessage(queue.chatId as Api.TypeEntityLike, {
                    message: queue.statusMsgId,
                    text: generateBatchStatusMessage(queue).replace(file.fileName, `${file.fileName} (重试中...)`),
                });
            } catch (e) { /* ignore */ }
        }

        // 重试
        const retrySuccess = await attemptUpload();
        if (!retrySuccess) {
            file.status = 'failed';
            console.log(`🤖 文件 ${file.fileName} 重试仍然失败`);
        }
    } else if (!firstAttemptSuccess) {
        file.status = 'failed';
    }
}

// 处理批量文件上传队列
async function processBatchUpload(client: TelegramClient, mediaGroupId: string): Promise<void> {
    const queue = mediaGroupQueues.get(mediaGroupId);
    if (!queue || queue.processingStarted) return;

    queue.processingStarted = true;

    const firstMessage = queue.files[0]?.message;
    if (!firstMessage) return;

    let folderName = '';
    for (const file of queue.files) {
        const caption = file.message.message || file.message.text || '';
        if (caption && caption.trim()) {
            folderName = caption.trim();
            break;
        }
    }

    if (!folderName) {
        const now = new Date();
        folderName = `batch_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    }

    let sanitizedFolderName = sanitizeFilename(folderName);
    let folderPath = path.join(UPLOAD_DIR, sanitizedFolderName);

    if (!fs.existsSync(folderPath)) {
        try {
            fs.mkdirSync(folderPath, { recursive: true });
        } catch (err) {
            console.error(`🤖 创建批量上传文件夹失败: ${folderPath}`, err);
            const fallbackFolderName = `fallback_${Date.now()}`;
            const fallbackPath = path.join(UPLOAD_DIR, fallbackFolderName);
            console.warn(`🤖 使用备用文件夹: ${fallbackFolderName}`);

            try {
                if (!fs.existsSync(fallbackPath)) {
                    fs.mkdirSync(fallbackPath, { recursive: true });
                }
                sanitizedFolderName = fallbackFolderName;
                folderPath = fallbackPath;
            } catch (innerErr) {
                console.error(`🤖 创建备用文件夹也失败了: ${fallbackPath}`, innerErr);
                // 如果备用也失败，退回到根上传目录
                sanitizedFolderName = '';
                folderPath = UPLOAD_DIR;
            }
        }
    }

    queue.folderName = sanitizedFolderName;
    queue.folderPath = folderPath;

    try {
        const statusMsg = await firstMessage.reply({
            message: generateBatchStatusMessage(queue)
        });
        if (statusMsg) {
            queue.statusMsgId = statusMsg.id;
        }
    } catch (e) {
        console.error('🤖 发送批量上传状态消息失败:', e);
    }

    for (const file of queue.files) {
        await processFileUpload(client, file, queue);

        if (queue.statusMsgId && queue.chatId) {
            try {
                await client.editMessage(queue.chatId as Api.TypeEntityLike, {
                    message: queue.statusMsgId,
                    text: generateBatchStatusMessage(queue),
                });
            } catch (e) { /* ignore */ }
        }
    }

    // 对于有垃圾缓存的失败文件，发送清理按钮消息
    const failedFilesWithGarbage = queue.files.filter(f => f.status === 'failed' && f.garbageInfo?.estimatedSize);
    for (const failedFile of failedFilesWithGarbage) {
        try {
            const garbageSize = formatBytes(failedFile.garbageInfo!.estimatedSize!);
            const cleanupId = `cleanup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // 存储清理信息供回调使用
            pendingCleanups.set(cleanupId, {
                localPath: failedFile.garbageInfo!.localPath,
                fileName: failedFile.fileName,
                size: failedFile.garbageInfo!.estimatedSize!,
            });

            await client.sendMessage(queue.chatId as Api.TypeEntityLike, {
                message: `❌ 文件上传失败: **${failedFile.fileName}**\n📁 原因: ${failedFile.error || '未知错误'}\n\n⚠️ 服务器产生了 ${garbageSize} 垃圾缓存\n点击下方按钮清理：`,
                buttons: new Api.ReplyInlineMarkup({
                    rows: [
                        new Api.KeyboardButtonRow({
                            buttons: [
                                new Api.KeyboardButtonCallback({
                                    text: `🗑️ 清理缓存 (${garbageSize})`,
                                    data: Buffer.from(cleanupId)
                                })
                            ]
                        })
                    ]
                })
            });
        } catch (e) {
            console.error('🤖 发送清理按钮消息失败:', e);
        }
    }

    mediaGroupQueues.delete(mediaGroupId);
}

// 待清理垃圾缓存信息 (key: cleanupId)
interface PendingCleanupInfo {
    localPath?: string;
    fileName: string;
    size: number;
}
const pendingCleanups = new Map<string, PendingCleanupInfo>();

// 导出清理函数供 telegramBot.ts 使用
export async function handleCleanupCallback(cleanupId: string): Promise<{ success: boolean; message: string }> {
    const cleanupInfo = pendingCleanups.get(cleanupId);
    if (!cleanupInfo) {
        return { success: false, message: '该清理任务已过期或不存在' };
    }

    try {
        // 清理本地文件
        if (cleanupInfo.localPath && fs.existsSync(cleanupInfo.localPath)) {
            fs.unlinkSync(cleanupInfo.localPath);
            console.log(`🤖 已清理本地垃圾缓存: ${cleanupInfo.localPath}`);
        }

        pendingCleanups.delete(cleanupId);
        return {
            success: true,
            message: `✅ 已清理 ${cleanupInfo.fileName} 的垃圾缓存 (${formatBytes(cleanupInfo.size)})`
        };
    } catch (error) {
        console.error('🤖 清理垃圾缓存失败:', error);
        return { success: false, message: `清理失败: ${(error as Error).message}` };
    }
}

// Main handler for file uploads
export async function handleFileUpload(client: TelegramClient, event: NewMessageEvent): Promise<void> {
    const message = event.message;
    const senderId = message.senderId?.toJSNumber();
    if (!senderId) return;

    if (!isAuthenticated(senderId)) {
        await message.reply({ message: '🔐 请先发送 /start 验证密码后再上传文件' });
        return;
    }

    const fileInfo = extractFileInfo(message);
    if (!fileInfo) {
        if (message.media) {
            console.log('🤖 无法从媒体消息中提取文件信息:', (message.media as any).className);
            // 如果是网页预览等不重要的媒体，静默忽略
            if ((message.media as any).className === 'MessageMediaWebPage') {
                return;
            }
            await message.reply({ message: '⚠️ 抱歉，暂不支持或无法识别此类媒体格式进行上传。' });
        }
        return;
    }

    const { fileName, mimeType } = fileInfo;
    const mediaGroupId = (message as any).groupedId?.toString();

    if (mediaGroupId) {
        let queue = mediaGroupQueues.get(mediaGroupId);
        if (!queue) {
            queue = {
                chatId: message.chatId,
                files: [],
                processingStarted: false,
                createdAt: Date.now(),
            };
            mediaGroupQueues.set(mediaGroupId, queue);

            setTimeout(() => {
                processBatchUpload(client, mediaGroupId);
            }, MEDIA_GROUP_DELAY);
        }

        queue.files.push({
            fileName,
            mimeType,
            message,
            status: 'pending',
        });
    } else {
        // 单文件上传：如果有消息文字，则作为文件名
        let finalFileName = fileName;
        const caption = message.message || '';
        if (caption && caption.trim()) {
            const ext = path.extname(fileName);
            const sanitizedCaption = sanitizeFilename(caption.trim());
            // 如果文件名中没有扩展名且原文件有，则加上
            if (!sanitizedCaption.toLowerCase().endsWith(ext.toLowerCase()) && ext) {
                finalFileName = `${sanitizedCaption}${ext}`;
            } else {
                finalFileName = sanitizedCaption;
            }
            console.log(`🤖 单文件上传: 使用消息文字作为文件名: ${finalFileName} (原名: ${fileName})`);
        }

        const typeEmoji = getTypeEmoji(mimeType);
        const totalSize = getEstimatedFileSize(message);

        let statusMsg: Api.Message | undefined;
        try {
            statusMsg = await message.reply({
                message: `⏳ 正在下载文件: ${finalFileName}\n${generateProgressBar(0, 1)}\n\n${typeEmoji} ${formatBytes(0)} / ${formatBytes(totalSize)}`
            }) as Api.Message;
        } catch (e) {
            console.error('🤖 发送初始下载状态消息失败:', e);
            // 尝试直接发送新消息作为兜底
            try {
                statusMsg = await client.sendMessage(message.chatId!, {
                    message: `⏳ 正在处理文件 (回复失败): ${finalFileName}`,
                    replyTo: message.id
                });
            } catch (innerE) {
                console.error('🤖 兜底发送消息失败:', innerE);
                // 如果还失败，只能强行继续
            }
        }

        if (!statusMsg) {
            console.log('🤖 无法发送进度消息，文件将静默下载');
        }

        let lastUpdateTime = 0;
        const updateInterval = 1000;

        const onProgress = async (downloaded: number, total: number) => {
            if (!statusMsg) return;
            const now = Date.now();
            if (now - lastUpdateTime < updateInterval) return;
            lastUpdateTime = now;

            try {
                await client.editMessage(message.chatId!, {
                    message: statusMsg.id,
                    text: `⏳ 正在下载文件: ${finalFileName}\n${generateProgressBar(downloaded, total)}\n\n${typeEmoji} ${formatBytes(downloaded)} / ${formatBytes(total)}`,
                });
            } catch (e) { /* ignore */ }
        };

        // 单文件上传的重试逻辑
        let retryCount = 0;
        const maxRetries = 1;
        let lastLocalPath: string | undefined;
        let lastError: string | undefined;

        const attemptSingleUpload = async (): Promise<boolean> => {
            let localFilePath: string | undefined;

            try {
                const result = await downloadAndSaveFile(client, message, fileName, undefined, onProgress);

                if (!result) {
                    lastError = '下载失败';
                    return false;
                }

                localFilePath = result.filePath;
                lastLocalPath = localFilePath;
                const { actualSize, storedName } = result;
                const fileType = getFileType(mimeType);

                if (statusMsg) {
                    await client.editMessage(message.chatId!, {
                        message: statusMsg.id,
                        text: `💾 正在保存文件...\n${generateProgressBar(1, 1)}\n\n${typeEmoji} ${finalFileName}`,
                    });
                }

                // 生成缩略图和获取尺寸（失败不应阻止上传）
                let thumbnailPath: string | null = null;
                let dimensions: { width?: number; height?: number } = {};
                try {
                    thumbnailPath = await generateThumbnail(localFilePath, storedName, mimeType);
                    dimensions = await getImageDimensions(localFilePath, mimeType);
                } catch (thumbErr) {
                    console.warn('🤖 单文件上传: 生成缩略图/获取尺寸失败，继续上传:', thumbErr);
                }

                const provider = storageManager.getProvider();
                let finalPath = localFilePath;
                let sourceRef = provider.name;

                if (provider.name !== 'local') {
                    try {
                        finalPath = await provider.saveFile(localFilePath, storedName, mimeType);
                        if (fs.existsSync(localFilePath)) {
                            fs.unlinkSync(localFilePath);
                        }
                        lastLocalPath = undefined; // 上传成功，清除垃圾引用
                    } catch (err) {
                        console.error('🤖 单文件上传: 保存到存储提供商失败:', err);
                        lastError = (err as Error).message;
                        throw err;
                    }
                }

                await query(`
                    INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                `, [finalFileName, storedName, fileType, mimeType, actualSize, finalPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, null]);

                const storageLabel = provider.name === 'onedrive' ? '☁️ OneDrive' : '💾 本地';
                if (statusMsg) {
                    await client.editMessage(message.chatId!, {
                        message: statusMsg.id,
                        text: `✅ 文件上传成功!\n${generateProgressBar(1, 1)}\n\n📄 文件名: ${finalFileName}\n📦 大小: ${formatBytes(actualSize)}\n🏷️ 类型: ${fileType}\n📍 存储: ${storageLabel}`,
                    });
                }
                return true;

            } catch (error) {
                console.error('🤖 上传文件失败:', error);
                lastError = error instanceof Error ? error.message : '未知错误';
                if (localFilePath && fs.existsSync(localFilePath)) {
                    lastLocalPath = localFilePath;
                }
                return false;
            }
        };

        // 第一次尝试
        let success = await attemptSingleUpload();

        // 如果失败，清理垃圾缓存并重试
        if (!success && retryCount < maxRetries) {
            retryCount++;
            console.log(`🤖 单文件 ${finalFileName} 上传失败，正在清理并重试 (${retryCount}/${maxRetries})...`);

            if (lastLocalPath && fs.existsSync(lastLocalPath)) {
                try {
                    fs.unlinkSync(lastLocalPath);
                    console.log(`🤖 已清理本地临时文件: ${lastLocalPath}`);
                } catch (e) {
                    console.error('🤖 清理本地临时文件失败:', e);
                }
            }
            lastLocalPath = undefined;

            if (statusMsg) {
                try {
                    await client.editMessage(message.chatId!, {
                        message: statusMsg.id,
                        text: `🔄 上传失败，正在重试...\n${generateProgressBar(0, 1)}\n\n${typeEmoji} ${finalFileName}`,
                    });
                } catch (e) { /* ignore */ }
            }

            success = await attemptSingleUpload();
        }

        // 最终失败处理
        if (!success) {
            if (statusMsg) {
                await client.editMessage(message.chatId!, {
                    message: statusMsg.id,
                    text: `❌ 上传失败: ${finalFileName}\n原因: ${lastError || '未知错误'}`
                }).catch(() => { });
            }

            // 如果有垃圾缓存，发送清理按钮
            if (lastLocalPath && fs.existsSync(lastLocalPath)) {
                try {
                    const stats = fs.statSync(lastLocalPath);
                    const garbageSize = formatBytes(stats.size);
                    const cleanupId = `cleanup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                    pendingCleanups.set(cleanupId, {
                        localPath: lastLocalPath,
                        fileName: finalFileName,
                        size: stats.size,
                    });

                    await client.sendMessage(message.chatId!, {
                        message: `⚠️ 文件 **${finalFileName}** 上传失败\n服务器产生了 ${garbageSize} 垃圾缓存\n点击下方按钮清理：`,
                        buttons: new Api.ReplyInlineMarkup({
                            rows: [
                                new Api.KeyboardButtonRow({
                                    buttons: [
                                        new Api.KeyboardButtonCallback({
                                            text: `🗑️ 清理缓存 (${garbageSize})`,
                                            data: Buffer.from(cleanupId)
                                        })
                                    ]
                                })
                            ]
                        })
                    });
                } catch (e) {
                    console.error('🤖 发送清理按钮消息失败:', e);
                }
            }
        }
    }
}
