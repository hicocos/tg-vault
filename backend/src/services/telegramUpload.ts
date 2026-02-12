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
class DownloadQueue {
    private queue: DownloadTask[] = [];
    private active: DownloadTask[] = [];
    private history: DownloadTask[] = []; // 保留最近的历史记录
    private maxHistory = 50;
    private maxConcurrent = 2; // 用户要求并发限制为 2

    async add(fileName: string, execute: () => Promise<void>, totalSize?: number): Promise<void> {
        const id = uuidv4();
        return new Promise((resolve, reject) => {
            const task: DownloadTask = {
                id,
                fileName,
                status: 'pending',
                totalSize,
                downloadedSize: 0,
                execute: async () => {
                    // Move from queue to active
                    const taskIndex = this.queue.findIndex(t => t.id === id);
                    if (taskIndex > -1) {
                        this.queue.splice(taskIndex, 1);
                    }
                    this.active.push(task);
                    task.status = 'active';
                    task.startTime = Date.now();

                    try {
                        await execute();
                        task.status = 'success';
                        resolve();
                    } catch (error) {
                        task.status = 'failed';
                        task.error = (error as Error).message;
                        reject(error);
                    } finally {
                        task.endTime = Date.now();
                        // Move from active to history
                        const activeIndex = this.active.findIndex(t => t.id === id);
                        if (activeIndex > -1) {
                            this.active.splice(activeIndex, 1);
                        }
                        this.history.unshift(task);
                        if (this.history.length > this.maxHistory) {
                            this.history.pop();
                        }
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

        const task = this.queue[0]; // Don't shift here, let execute() move it
        if (task && task.status === 'pending') {
            // We initiate execution, but actual move happened inside the wrapper
            // Wait, if we don't shift here, how do we prevent double execution?
            // The wrapper modifies the arrays. But we need to make sure we don't call execute twice.
            // Actually, the previous implementation shifted here.
            // Let's stick to shifting here for simplicity, but we need to track it in 'active'

            // CORRECT APPROACH:
            // shift from queue, push to active, then execute.
        }

        // Let's refine the logic to avoid race conditions
        // The simple wrapper above defines the *task behavior*, but the *scheduling* is here.

        const nextTask = this.queue.shift();
        if (nextTask) {
            // We can't push to active here because the wrapper does it? 
            // No, the wrapper logic I wrote above is:
            // execute: async () => { ... this.active.push(task) ... }
            // This assumes execute is called. 

            // Let's adjust the wrapper logic to rely on the queue manager.
            console.log(`[Queue] 🚀 Processing task: ${nextTask.fileName}.`);
            nextTask.execute();
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
            active: this.active,
            pending: this.queue,
            history: this.history
        };
    }

    // Update progress method
    updateProgress(taskId: string, downloaded: number) {
        // Find in active
        const task = this.active.find(t => t.id === taskId);
        if (task) {
            task.downloadedSize = downloaded;
        }
    }
}

// Redefine class with correct logic
class BetterDownloadQueue {
    private queue: DownloadTask[] = [];
    private active: DownloadTask[] = [];
    private history: DownloadTask[] = [];
    private maxHistory = 50;
    private maxConcurrent = 2;

    async add(fileName: string, execute: () => Promise<void>, totalSize: number = 0): Promise<void> {
        const id = uuidv4();
        // Since execute is the wrapper, we don't return the promise of execute directly,
        // but we return a promise that resolves when the task finishes.

        // This is tricky because the original `add` returned a Promise that resolved when the execution finished.
        // We need to maintain that compatibility.

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
}

const downloadQueue = new BetterDownloadQueue();

let lastSilentNotificationTime = 0;
const SILENT_NOTIFICATION_COOLDOWN = 60000; // 1 minute

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
    garbageInfo?: {              // 垃圾缓存信息
        localPath?: string;      // 本地临时文件路径
        estimatedSize?: number;  // 估计的垃圾大小
    };
    cleanupId?: string;          // 清理任务ID
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

    // 如果还有文件在排队或上传中，显示全局排队信息，模仿单文件体验
    if (completed < total) {
        const stats = downloadQueue.getStats();
        // 只有当有排队任务或者队列繁忙时才显示提示
        if (stats.pending > 0 || stats.active >= 2) {
            message += `⏳ 已加入下载队列 (当前排队: ${stats.pending})\n💡 请耐心等待，Bot 将按顺序处理任务。\n\n`;
        }
    }

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
            case 'queued':
                fileIcon = '🕒';
                fileStatus = '排队中...';
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
    file.status = 'queued';

    file.status = 'queued';

    // 移除这里的初始状态更新，改为在 processBatchUpload 中统一更新一次
    // 这样可以确保 downloadQueue 已经包含了所有任务，pending 计数才准确

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
            const activeAccountId = storageManager.getActiveAccountId();

            await query(`
                INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [file.fileName, storedName, fileType, file.mimeType, actualSize, finalPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, folderName, activeAccountId]);

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

    // 将下载和保存逻辑封装为队列任务
    const queueTask = async () => {
        // 更新状态为上传中
        file.status = 'uploading';
        if (queue && queue.statusMsgId && queue.chatId) {
            await safeEditMessage(client, queue.chatId as Api.TypeEntityLike, {
                message: queue.statusMsgId,
                text: generateBatchStatusMessage(queue),
            });
        }

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
                await safeEditMessage(client, queue.chatId as Api.TypeEntityLike, {
                    message: queue.statusMsgId,
                    text: generateBatchStatusMessage(queue).replace(file.fileName, `${file.fileName} (重试中...)`),
                });
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

        // 如果文件最终失败，并且有垃圾信息，则添加到待清理列表并发送消息
        if (file.status === 'failed' && file.garbageInfo?.localPath && file.garbageInfo.estimatedSize) {
            try {
                const cleanupId = uuidv4();
                pendingCleanups.set(cleanupId, {
                    localPath: file.garbageInfo.localPath,
                    fileName: file.fileName,
                    size: file.garbageInfo.estimatedSize,
                });
                file.cleanupId = cleanupId;

                const garbageSize = formatBytes(file.garbageInfo.estimatedSize);

                // 发送清理按钮消息 (仅当有队列且在群组/会话中时)
                if (queue && queue.chatId) {
                    await client.sendMessage(queue.chatId as Api.TypeEntityLike, {
                        message: `❌ 文件上传失败: **${file.fileName}**\n📁 原因: ${file.error || '未知错误'}\n\n⚠️ 服务器产生了 ${garbageSize} 垃圾缓存\n点击下方按钮清理：`,
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
                }
            } catch (e) {
                console.error('🤖 发送清理按钮消息失败:', e);
            }
        }

        // 任务结束，更新最终状态
        if (queue && queue.statusMsgId && queue.chatId) {
            await safeEditMessage(client, queue.chatId as Api.TypeEntityLike, {
                message: queue.statusMsgId,
                text: generateBatchStatusMessage(queue),
            });
        }
    };

    // 加入队列并等待执行
    // 注意：不再 await downloadQueue.add，而是直接返回（因为是 Promise.all 调用）
    // 但是 downloadQueue.add 返回的是 Promise<void>，它会在 task 完成后 resolve。
    // 如果我们不 await 它，Promise.all 会立即完成吗？
    // 不，我们应该 await 它，因为 Promise.all 等待的是 processFileUpload 的 Promise。
    // 而 processFileUpload 的 Promise 是等待 downloadQueue.add 完成。
    // 但是 wait，如果我们 await downloadQueue.add，那么 processFileUpload 就会阻塞直到任务完成。
    // 这正是之前的问题！
    // 关键点：我们不应该 await downloadQueue.add 的结果（任务完成），
    // 而是应该只 await 将任务加入队列这个动作。
    // 但是 downloadQueue.add 的实现目前是返回 Promise，这个 Promise 是在 task resolve 时才 resolve。
    // 所以我们需要修改 downloadQueue.add 或者 processFileUpload 的调用方式。

    // 如果我们不 await downloadQueue.add，那么 processFileUpload 会立即返回。
    // 这样 Promise.all 也会立即返回。
    // 但是 processBatchUpload 末尾不需要等待所有任务完成吗？
    // 目前代码是不需要的，它只是发完所有请求就结束了，状态更新由回调负责。
    // 但是等等，downloadQueue.add 返回 Promise<void>，这个 Promise 是 task.execute() 完成后才 resolve 的。
    // 所以如果我们在 processFileUpload 里 await downloadQueue.add(file.fileName, queueTask)，
    // 那么 processFileUpload 就会阻塞直到任务完成。

    // 解决方案：
    // 在 processFileUpload 里，我们将任务加入队列，但不等待它完成。
    // 可是 downloadQueue.add 目前的设计是等待任务完成。
    // 让我们看看 downloadQueue.add 的实现：
    /*
    async add(fileName: string, execute: () => Promise<void>): Promise<void> {
        const id = uuidv4();
        return new Promise((resolve, reject) => {
            const task: DownloadTask = {
                 execute: async () => { try { await execute(); resolve(); } ... }
            };
            this.queue.push(task);
            this.processNext();
        });
    }
    */
    // 是的，它返回的 Promise 是绑在 task 上的。

    // 所以，我们在 processFileUpload 里面不能 await downloadQueue.add。
    // 我们应该让 processFileUpload 只是“提交”任务。

    downloadQueue.add(file.fileName, queueTask).catch(err => {
        console.error(`Unhandled error in download task for ${file.fileName}:`, err);
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
        const statusMsg = await safeReply(firstMessage, {
            message: generateBatchStatusMessage(queue)
        });
        if (statusMsg) {
            queue.statusMsgId = statusMsg.id;
        }
    } catch (e) {
        console.error('🤖 发送批量上传状态消息失败:', e);
    }

    // 使用 Promise.all 并行提交任务到队列
    // processFileUpload 内部不再 await downloadQueue.add，所以这里会很快完成
    await Promise.all(queue.files.map(file => processFileUpload(client, file, queue)));

    // 所有任务都加入队列后，统一发送一次状态更新
    // 此时 downloadQueue.getStats() 会返回正确的 pending 数量
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

    // 注意：由于 processFileUpload 现在不等待任务完成就返回，
    // 所以这里的代码会立即执行完。
    // 但是这是预期的，因为后续的状态更新是在 queueTask 回调中处理的。

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
            // 如果排队任务过多，通过控制台记录而不是给每一项都发回复来减少 Flood
            const stats = downloadQueue.getStats();

            // 阈值调整为 9
            if (stats.pending >= 9) {
                const now = Date.now();
                if (now - lastSilentNotificationTime > SILENT_NOTIFICATION_COOLDOWN) {
                    try {
                        await safeReply(message, {
                            message: `🤐 **检测到多文件上传，已切换到静默模式**\n\n当前排队任务: ${stats.pending} 个\nBot 将在后台继续处理所有文件，请耐心等待。\n\n💡 发送 /tasks 查看实时任务状态`
                        });
                        lastSilentNotificationTime = now;
                        console.log(`[Queue] 🤐 Sent Silent Mode notification.`);
                    } catch (e) {
                        console.error('🤖 发送静默模式通知失败:', e);
                    }
                }
                console.log(`[Queue] 🤐 High pending count (${stats.pending}), skipping initial status msg for ${finalFileName}`);
            } else {
                statusMsg = await safeReply(message, {
                    message: `⏳ 正在下载文件: ${finalFileName}\n${generateProgressBar(0, 1)}\n\n${typeEmoji} ${formatBytes(0)} / ${formatBytes(totalSize)}`
                }) as Api.Message;
            }
        } catch (e) {
            console.error('🤖 发送初始下载状态消息失败:', e);
        }

        if (!statusMsg) {
            console.log('🤖 无法发送进度消息，文件将静默下载');
        }

        // 显示排队状态（如果前面有任务）
        const stats = downloadQueue.getStats();
        if (statusMsg && (stats.active >= 2 || stats.pending > 0)) {
            await safeEditMessage(client, message.chatId!, {
                message: statusMsg.id,
                text: `⏳ 已加入下载队列 (当前排队: ${stats.pending})\n\n📄 文件: ${finalFileName}\n💡 请耐心等待，Bot 将按顺序处理任务。`
            });
        }

        let lastUpdateTime = 0;
        const updateInterval = 3000; // 增加到 3 秒更新一次

        const onProgress = async (downloaded: number, total: number) => {
            if (!statusMsg) return;
            const now = Date.now();
            if (now - lastUpdateTime < updateInterval) return;
            lastUpdateTime = now;

            await safeEditMessage(client, message.chatId!, {
                message: statusMsg.id,
                text: `⏳ 正在下载文件: ${finalFileName}\n${generateProgressBar(downloaded, total)}\n\n${typeEmoji} ${formatBytes(downloaded)} / ${formatBytes(total)}`,
            });
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
                    await safeEditMessage(client, message.chatId!, {
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

                const activeAccountId = storageManager.getActiveAccountId();

                await query(`
                    INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                `, [finalFileName, storedName, fileType, mimeType, actualSize, finalPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, null, activeAccountId]);

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

        // 将上传过程封装到队列任务中
        const singleUploadTask = async () => {
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
        };

        // 加入队列执行
        // 加入队列执行 (不等待，防止阻塞事件循环)
        downloadQueue.add(finalFileName, singleUploadTask).catch(err => {
            console.error(`🤖 单文件下载任务异常: ${finalFileName}`, err);
        });
    }
}
