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

// 用于追踪 Telegram FloodWait 的全局截止时间
let floodWaitUntil = 0;

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 安全编辑消息，捕获 FloodWaitError 并更新全局冷却状态
 */
async function safeEditMessage(client: TelegramClient, chatId: Api.TypeEntityLike, params: { message: number, text: string }) {
    if (Date.now() < floodWaitUntil) return null;

    try {
        return await client.editMessage(chatId, params);
    } catch (e: any) {
        if (e.errorMessage === 'FLOOD' || e.errorMessage?.includes('FLOOD_WAIT')) {
            const seconds = e.seconds || 30; // 默认冷却 30 秒
            floodWaitUntil = Date.now() + (seconds * 1000);
            console.warn(`[Telegram] ⚠️ 触发 FloodWait，冷却时间: ${seconds} 秒`);
        }
        return null;
    }
}

/**
 * 安全回复消息
 */
async function safeReply(message: Api.Message, params: { message: string, buttons?: any }) {
    if (Date.now() < floodWaitUntil) return null;

    try {
        return await message.reply(params);
    } catch (e: any) {
        if (e.errorMessage === 'FLOOD' || e.errorMessage?.includes('FLOOD_WAIT')) {
            const seconds = e.seconds || 30;
            floodWaitUntil = Date.now() + (seconds * 1000);
            console.warn(`[Telegram] ⚠️ 触发 FloodWait (Reply)，冷却时间: ${seconds} 秒`);
        }
        return null;
    }
}

// 下载任务接口
interface DownloadTask {
    id: string;
    execute: () => Promise<void>;
    fileName: string;
    status: 'pending' | 'active' | 'success' | 'failed';
    error?: string;
    startTime?: number;
    endTime?: number;
    totalSize?: number;
    downloadedSize?: number;
}

// 下载队列管理类
class BetterDownloadQueue {
    private queue: DownloadTask[] = [];
    private active: DownloadTask[] = [];
    private history: DownloadTask[] = [];
    private maxHistory = 50;
    private maxConcurrent = 2; // 用户要求并发限制为 2

    async add(fileName: string, execute: () => Promise<void>, totalSize: number = 0): Promise<void> {
        const id = uuidv4();
        return new Promise((resolve, reject) => {
            const task: DownloadTask = {
                id,
                fileName,
                status: 'pending',
                totalSize,
                downloadedSize: 0,
                // The actual execution logic
                execute: async () => {
                    task.status = 'active';
                    task.startTime = Date.now();
                    this.active.push(task);

                    try {
                        await execute();
                        task.status = 'success';
                        resolve();
                    } catch (error) {
                        task.status = 'failed';
                        task.error = (error instanceof Error) ? error.message : String(error);
                        reject(error);
                    } finally {
                        task.endTime = Date.now();
                        // Remove from active
                        const idx = this.active.findIndex(t => t.id === id);
                        if (idx !== -1) this.active.splice(idx, 1);

                        // Add to history
                        this.history.unshift(task);
                        if (this.history.length > this.maxHistory) this.history.pop();

                        this.processNext();
                    }
                }
            };

            this.queue.push(task);
            console.log(`[Queue] 📥 Task added: ${fileName}. Queue size: ${this.queue.length}`);
            this.processNext();
        });
    }

    private processNext() {
        if (this.active.length >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        const task = this.queue.shift();
        if (task) {
            console.log(`[Queue] 🚀 Processing task: ${task.fileName}. Active: ${this.active.length + 1}, Pending: ${this.queue.length}`);
            // Execute the wrapped function
            task.execute();
        }
    }

    getStats() {
        return {
            active: this.active.length,
            pending: this.queue.length,
            total: this.active.length + this.queue.length
        };
    }

    getDetailedStatus() {
        return {
            active: [...this.active],
            pending: [...this.queue],
            history: [...this.history]
        };
    }

    // Update progress method
    updateProgress(taskId: string, downloaded: number) {
        const task = this.active.find(t => t.id === taskId);
        if (task) {
            task.downloadedSize = downloaded;
        }
    }
}

const downloadQueue = new BetterDownloadQueue();

let lastSilentNotificationTime = 0;
const SILENT_NOTIFICATION_COOLDOWN = 60000; // 1 minute

// 用于追踪每个会话最后一条状态消息 ID 的映射
const lastStatusMessageIdMap = new Map<string, number>();

/**
 * 安全删除并追踪最后一条状态消息
 */
async function deleteLastStatusMessage(client: TelegramClient, chatId: Api.TypeEntityLike | undefined) {
    if (!chatId) return;
    const chatIdStr = chatId.toString();
    const lastMsgId = lastStatusMessageIdMap.get(chatIdStr);
    if (lastMsgId) {
        try {
            await client.deleteMessages(chatId, [lastMsgId], { revoke: true });
        } catch (e) {
            // 忽略删除失败的情况
        }
        lastStatusMessageIdMap.delete(chatIdStr);
    }
}

/**
 * 更新最后一条状态消息 ID
 */
function updateLastStatusMessageId(chatId: Api.TypeEntityLike | undefined, msgId: number | undefined) {
    if (!chatId || !msgId) return;
    lastStatusMessageIdMap.set(chatId.toString(), msgId);
}

// 导出获取队列统计信息的函数
export function getDownloadQueueStats() {
    return downloadQueue.getStats();
}

export function getTaskStatus() {
    return downloadQueue.getDetailedStatus();
}

// 多文件上传队列管理
interface FileUploadItem {
    fileName: string;
    mimeType: string;
    message: Api.Message;
    status: 'pending' | 'queued' | 'uploading' | 'success' | 'failed';
    size?: number;
    fileType?: string;
    error?: string;
    retried?: boolean;           // 是否已重试过
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
            fileName = fileNameAttr?.fileName || \`file_\${Date.now()}\`;
            mimeType = doc.mimeType || getMimeTypeFromFilename(fileName);

            // 如果是音频/视频但没有文件名属性，尝试根据类型生成
            if (fileName.startsWith('file_')) {
                const videoAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeVideo');
                const audioAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeAudio');
                if (videoAttr) fileName = \`video_\${Date.now()}.mp4\`;
                else if (audioAttr) fileName = \`audio_\${Date.now()}.mp3\`;
            }
        } else if (message.photo) {
            fileName = \`photo_\${Date.now()}.jpg\`;
            mimeType = 'image/jpeg';
        } else if (message.video) {
            const video = message.video as Api.Document;
            const fileNameAttr = video.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || \`video_\${Date.now()}.mp4\`;
            mimeType = video.mimeType || 'video/mp4';
        } else if (message.audio) {
            const audio = message.audio as Api.Document;
            const fileNameAttr = audio.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || \`audio_\${Date.now()}.mp3\`;
            mimeType = audio.mimeType || 'audio/mpeg';
        } else if (message.voice) {
            fileName = \`voice_\${Date.now()}.ogg\`;
            mimeType = 'audio/ogg';
        } else if (message.sticker) {
            fileName = \`sticker_\${Date.now()}.webp\`;
            mimeType = 'image/webp';
        } else {
            const media = message.media as any;
            if (media.document && media.document instanceof Api.Document) {
                const doc = media.document;
                const fileNameAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
                fileName = fileNameAttr?.fileName || \`file_\${Date.now()}\`;
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
    const storedName = \`\${uuidv4()}\${ext}\`;
    let saveDir = targetDir || UPLOAD_DIR;

    if (!fs.existsSync(saveDir)) {
        try {
            fs.mkdirSync(saveDir, { recursive: true });
        } catch (err) {
            console.error(\`🤖 创建下载目录失败: \${saveDir}\`, err);
            if (saveDir === UPLOAD_DIR) throw err;
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

    let message = \`\${statusIcon} **\${statusText}**\n\n\`;

    if (completed < total) {
        const stats = downloadQueue.getStats();
        if (stats.pending > 0 || stats.active >= 2) {
            message += \`⏳ 已加入下载队列 (当前排队: \${stats.pending})\n💡 请耐心等待，Bot 将按顺序处理任务。\n\n\`;
        }
    }

    if (queue.folderName) {
        message += \`📁 文件夹: \${queue.folderName}\n\`;
    }
    message += \`📊 进度: \${completed}/\${total}\n\`;
    message += \`\${generateProgressBar(completed, total)}\n\n\`;

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
            case 'queued':
                fileIcon = '🕒';
                fileStatus = '排队中...';
                break;
        }

        const typeEmoji = getTypeEmoji(file.mimeType);
        message += \`\${fileIcon} \${typeEmoji} \${file.fileName}\n\`;
        message += \`    └ \${fileStatus}\n\`;
    });

    return message;
}

// 处理单个文件上传（带重试机制）
async function processFileUpload(client: TelegramClient, file: FileUploadItem, queue?: MediaGroupQueue): Promise<void> {
    file.status = 'queued';

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

            // 生成缩略图和获取尺寸
            let thumbnailPath: string | null = null;
            let dimensions: { width?: number; height?: number } = {};
            try {
                thumbnailPath = await generateThumbnail(localFilePath, storedName, file.mimeType);
                dimensions = await getImageDimensions(localFilePath, file.mimeType);
            } catch (thumbErr) {
                console.warn('🤖 生成缩略图/获取尺寸失败，继续上传:', thumbErr);
            }

            const provider = storageManager.getProvider();
            let finalPath = localFilePath;
            let sourceRef = provider.name;

            if (provider.name !== 'local') {
                try {
                    finalPath = await provider.saveFile(localFilePath, storedName, file.mimeType);
                    if (fs.existsSync(localFilePath)) {
                        fs.unlinkSync(localFilePath);
                    }
                } catch (err) {
                    console.error('保存文件到存储提供商失败:', err);
                    throw err;
                }
            }

            const folderName = queue?.folderName || null;
            const activeAccountId = storageManager.getActiveAccountId();

            await query(\`
                INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            \`, [file.fileName, storedName, fileType, file.mimeType, actualSize, finalPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, folderName, activeAccountId]);

            file.status = 'success';
            file.size = actualSize;
            file.fileType = fileType;
            return true;

        } catch (error) {
            console.error('🤖 文件上传失败:', error);
            file.error = (error as Error).message;
            // 立即清理本地临时文件
            if (localFilePath && fs.existsSync(localFilePath)) {
                try {
                    fs.unlinkSync(localFilePath);
                    console.log(\`🤖 上传尝试失败，已自动清理本地垃圾缓存: \${localFilePath}\`);
                } catch (e) {
                    console.error('🤖 自动清理垃圾缓存失败:', e);
                }
            }
            return false;
        }
    };

    const queueTask = async () => {
        file.status = 'uploading';
        if (queue && queue.statusMsgId && queue.chatId) {
            await safeEditMessage(client, queue.chatId as Api.TypeEntityLike, {
                message: queue.statusMsgId,
                text: generateBatchStatusMessage(queue),
            });
        }

        const firstAttemptSuccess = await attemptUpload();

        if (!firstAttemptSuccess && !file.retried) {
            file.retried = true;
            file.status = 'uploading';
            file.error = undefined;

            if (queue && queue.statusMsgId && queue.chatId) {
                await safeEditMessage(client, queue.chatId as Api.TypeEntityLike, {
                    message: queue.statusMsgId,
                    text: generateBatchStatusMessage(queue).replace(file.fileName, \`\${file.fileName} (重试中...)\`),
                });
            }

            const retrySuccess = await attemptUpload();
            if (!retrySuccess) {
                file.status = 'failed';
            }
        } else if (!firstAttemptSuccess) {
            file.status = 'failed';
        }

        if (queue && queue.statusMsgId && queue.chatId) {
            await safeEditMessage(client, queue.chatId as Api.TypeEntityLike, {
                message: queue.statusMsgId,
                text: generateBatchStatusMessage(queue),
            });
        }
    };

    downloadQueue.add(file.fileName, queueTask).catch(err => {
        console.error(\`Unhandled error in download task for \${file.fileName}:\`, err);
    });
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
        folderName = \`batch_\${now.getFullYear()}\${String(now.getMonth() + 1).padStart(2, '0')}\${String(now.getDate()).padStart(2, '0')}_\${String(now.getHours()).padStart(2, '0')}\${String(now.getMinutes()).padStart(2, '0')}\${String(now.getSeconds()).padStart(2, '0')}\`;
    }

    let sanitizedFolderName = sanitizeFilename(folderName);
    let folderPath = path.join(UPLOAD_DIR, sanitizedFolderName);

    if (!fs.existsSync(folderPath)) {
        try {
            fs.mkdirSync(folderPath, { recursive: true });
        } catch (err) {
            console.error(\`🤖 创建批量上传文件夹失败: \${folderPath}\`, err);
            const fallbackFolderName = \`fallback_\${Date.now()}\`;
            const fallbackPath = path.join(UPLOAD_DIR, fallbackFolderName);
            try {
                if (!fs.existsSync(fallbackPath)) {
                    fs.mkdirSync(fallbackPath, { recursive: true });
                }
                sanitizedFolderName = fallbackFolderName;
                folderPath = fallbackPath;
            } catch (innerErr) {
                sanitizedFolderName = '';
                folderPath = UPLOAD_DIR;
            }
        }
    }

    queue.folderName = sanitizedFolderName;
    queue.folderPath = folderPath;

    try {
        const stats = downloadQueue.getStats();
        const totalPending = stats.pending + queue.files.length;

        if (totalPending >= 9) {
            const now = Date.now();
            if (now - lastSilentNotificationTime > SILENT_NOTIFICATION_COOLDOWN) {
                await safeReply(firstMessage, {
                    message: \`🤐 **检测到多文件上传，已切换到静默模式**\n\n当前排队任务: \${totalPending} 个\nBot 将在后台继续处理所有文件，请耐心等待。\n\n💡 发送 /tasks 查看实时任务状态\`
                });
                lastSilentNotificationTime = now;
            }
            await deleteLastStatusMessage(client, queue.chatId);
            const statusMsg = await safeReply(firstMessage, {
                message: generateBatchStatusMessage(queue)
            });
            if (statusMsg) {
                queue.statusMsgId = statusMsg.id;
                updateLastStatusMessageId(queue.chatId, statusMsg.id);
            }
        } else {
            await deleteLastStatusMessage(client, queue.chatId);
            const statusMsg = await safeReply(firstMessage, {
                message: generateBatchStatusMessage(queue)
            });
            if (statusMsg) {
                queue.statusMsgId = statusMsg.id;
                updateLastStatusMessageId(queue.chatId, statusMsg.id);
            }
        }
    } catch (e) {
        console.error('🤖 发送批量上传状态消息失败:', e);
    }

    await Promise.all(queue.files.map(file => processFileUpload(client, file, queue)));

    if (queue.statusMsgId && queue.chatId) {
        try {
            await safeEditMessage(client, queue.chatId as Api.TypeEntityLike, {
                message: queue.statusMsgId,
                text: generateBatchStatusMessage(queue),
            });
        } catch (e) {
            console.error('🤖 发送批量上传初始队列状态消息失败:', e);
        }
    }

    mediaGroupQueues.delete(mediaGroupId);
}

// 待清理垃圾缓存信息
interface PendingCleanupInfo {
    localPath?: string;
    fileName: string;
    size: number;
}
const pendingCleanups = new Map<string, PendingCleanupInfo>();

export async function handleCleanupCallback(cleanupId: string): Promise<{ success: boolean; message: string }> {
    const cleanupInfo = pendingCleanups.get(cleanupId);
    if (!cleanupInfo) {
        return { success: false, message: '该清理任务已过期或不存在' };
    }

    try {
        if (cleanupInfo.localPath && fs.existsSync(cleanupInfo.localPath)) {
            fs.unlinkSync(cleanupInfo.localPath);
        }
        pendingCleanups.delete(cleanupId);
        return {
            success: true,
            message: \`✅ 已清理 \${cleanupInfo.fileName} 的垃圾缓存 (\${formatBytes(cleanupInfo.size)})\`
        };
    } catch (error) {
        console.error('🤖 清理垃圾缓存失败:', error);
        return { success: false, message: \`清理失败: \${(error as Error).message}\` };
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
            if ((message.media as any).className === 'MessageMediaWebPage') return;
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
        let finalFileName = fileName;
        const caption = message.message || '';
        if (caption && caption.trim()) {
            const ext = path.extname(fileName);
            const sanitizedCaption = sanitizeFilename(caption.trim());
            if (!sanitizedCaption.toLowerCase().endsWith(ext.toLowerCase()) && ext) {
                finalFileName = \`\${sanitizedCaption}\${ext}\`;
            } else {
                finalFileName = sanitizedCaption;
            }
        }

        const typeEmoji = getTypeEmoji(mimeType);
        const totalSize = getEstimatedFileSize(message);

        let statusMsg: Api.Message | undefined;
        try {
            const stats = downloadQueue.getStats();
            if (stats.pending >= 9) {
                const now = Date.now();
                if (now - lastSilentNotificationTime > SILENT_NOTIFICATION_COOLDOWN) {
                    await safeReply(message, {
                        message: \`🤐 **检测到多文件上传，已切换到静默模式**\n\n当前排队任务: \${stats.pending} 个\nBot 将在后台继续处理所有文件，请耐心等待。\n\n💡 发送 /tasks 查看实时任务状态\`
                    });
                    lastSilentNotificationTime = now;
                }
            } else {
                await deleteLastStatusMessage(client, message.chatId!);
                statusMsg = await safeReply(message, {
                    message: \`⏳ 正在下载文件: \${finalFileName}\n\${generateProgressBar(0, 1)}\n\n\${typeEmoji} \${formatBytes(0)} / \${formatBytes(totalSize)}\`
                }) as Api.Message;
                if (statusMsg) {
                    updateLastStatusMessageId(message.chatId!, statusMsg.id);
                }
            }
        } catch (e) {
            console.error('🤖 发送初始下载状态消息失败:', e);
        }

        const stats = downloadQueue.getStats();
        if (statusMsg && (stats.active >= 2 || stats.pending > 0)) {
            await safeEditMessage(client, message.chatId!, {
                message: statusMsg.id,
                text: \`⏳ 已加入下载队列 (当前排队: \${stats.pending})\n\n📄 文件: \${finalFileName}\n💡 请耐心等待，Bot 将按顺序处理任务。\`
            });
        }

        let lastUpdateTime = 0;
        const updateInterval = 3000;
        const onProgress = async (downloaded: number, total: number) => {
            if (!statusMsg) return;
            const now = Date.now();
            if (now - lastUpdateTime < updateInterval) return;
            lastUpdateTime = now;
            await safeEditMessage(client, message.chatId!, {
                message: statusMsg.id,
                text: \`⏳ 正在下载文件: \${finalFileName}\n\${generateProgressBar(downloaded, total)}\n\n\${typeEmoji} \${formatBytes(downloaded)} / \${formatBytes(total)}\`,
            });
        };

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
                    await safeEditMessage(client, message.chatId!, {
                        message: statusMsg.id,
                        text: \`💾 正在保存文件...\n\${generateProgressBar(1, 1)}\n\n\${typeEmoji} \${finalFileName}\`,
                    });
                }

                let thumbnailPath: string | null = null;
                let dimensions: { width?: number; height?: number } = {};
                try {
                    thumbnailPath = await generateThumbnail(localFilePath, storedName, mimeType);
                    dimensions = await getImageDimensions(localFilePath, mimeType);
                } catch (thumbErr) {}

                const provider = storageManager.getProvider();
                let finalPath = localFilePath;
                let sourceRef = provider.name;

                if (provider.name !== 'local') {
                    try {
                        finalPath = await provider.saveFile(localFilePath, storedName, mimeType);
                        if (fs.existsSync(localFilePath)) {
                            fs.unlinkSync(localFilePath);
                        }
                        lastLocalPath = undefined;
                    } catch (err) {
                        lastError = (err as Error).message;
                        throw err;
                    }
                }

                const activeAccountId = storageManager.getActiveAccountId();
                await query(\`
                    INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                \`, [finalFileName, storedName, fileType, mimeType, actualSize, finalPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, null, activeAccountId]);

                if (statusMsg) {
                    await client.editMessage(message.chatId!, {
                        message: statusMsg.id,
                        text: \`✅ 文件上传成功!\n\${generateProgressBar(1, 1)}\n\n📄 文件名: \${finalFileName}\n📦 大小: \${formatBytes(actualSize)}\n🏷️ 类型: \${fileType}\n📍 存储: \${provider.name === 'onedrive' ? '☁️ OneDrive' : '💾 本地'}\`,
                    });
                }
                return true;
            } catch (error) {
                lastError = error instanceof Error ? error.message : '未知错误';
                if (localFilePath && fs.existsSync(localFilePath)) {
                    try {
                        fs.unlinkSync(localFilePath);
                    } catch (e) {}
                }
                lastLocalPath = undefined;
                return false;
            }
        };

        const singleUploadTask = async () => {
            let success = await attemptSingleUpload();
            if (!success && retryCount < maxRetries) {
                retryCount++;
                if (lastLocalPath && fs.existsSync(lastLocalPath)) {
                    try { fs.unlinkSync(lastLocalPath); } catch (e) {}
                }
                lastLocalPath = undefined;

                if (statusMsg) {
                    try {
                        await client.editMessage(message.chatId!, {
                            message: statusMsg.id,
                            text: \`🔄 上传失败，正在重试...\n\${generateProgressBar(0, 1)}\n\n\${typeEmoji} \${finalFileName}\`,
                        });
                    } catch (e) {}
                }
                success = await attemptSingleUpload();
            }

            if (!success) {
                if (statusMsg) {
                    await client.editMessage(message.chatId!, {
                        message: statusMsg.id,
                        text: \`❌ 上传失败: \${finalFileName}\n原因: \${lastError || '未知错误'}\`
                    }).catch(() => { });
                } else {
                    await safeReply(message, {
                        message: \`❌ 上传失败: \${finalFileName}\n原因: \${lastError || '未知错误'}\`
                    });
                }
            }
        };

        downloadQueue.add(finalFileName, singleUploadTask).catch(err => {
            console.error(\`🤖 单文件下载任务异常: \${finalFileName}\`, err);
        });
    }
}
