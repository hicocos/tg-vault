import { TelegramClient, Api } from 'telegram';
import { NewMessageEvent } from 'telegram/events/index.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bigInt from 'big-integer';
import { query } from '../db/index.js';
import { generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';
import { storageManager } from '../services/storage.js';
import { getTelegramUserClient, isTelegramUserClientReady } from './telegramUserClient.js';
import { getSetting } from '../utils/settings.js';
import { isAuthenticated } from './telegramState.js';
import { formatBytes, getTypeEmoji, getFileType, getMimeTypeFromFilename, sanitizeFilename } from '../utils/telegramUtils.js';
import {
    MSG,
    buildUploadSuccess,
    buildUploadFail,
    buildDownloadProgress,
    buildSavingFile,
    buildQueuedMessage,
    buildRetryMessage,
    buildDuplicateSkipped,
    buildSilentModeNotice,
    buildSilentAllTasksComplete,
    buildBatchStatus,
    buildConsolidatedStatus,
    type BatchFile,
    type ConsolidatedUploadFile,
    type ConsolidatedBatchEntry,
} from '../utils/telegramMessages.js';
import { getUniqueStoredName } from '../utils/fileUtils.js';
import { buildStorageFolderWithRules, getStoragePathRules, getTelegramBatchFolderName, getTelegramChatName, isOpaqueTelegramIdentifier } from '../utils/storagePath.js';
import { findDuplicateFile, getDuplicateMode } from '../utils/duplicatePolicy.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const DEFAULT_TELEGRAM_DOWNLOAD_WORKERS = Math.max(1, Math.min(16, parseInt(process.env.TELEGRAM_DOWNLOAD_WORKERS || '4', 10) || 4));
const TELEGRAM_DOWNLOAD_PART_SIZE = 512 * 1024;

function clampDownloadWorkers(value: unknown): number {
    const parsed = parseInt(String(value ?? DEFAULT_TELEGRAM_DOWNLOAD_WORKERS), 10);
    const normalized = [4, 8, 12, 16].includes(parsed) ? parsed : DEFAULT_TELEGRAM_DOWNLOAD_WORKERS;
    return Math.max(1, Math.min(16, normalized));
}

async function getTelegramDownloadWorkers(): Promise<number> {
    const storedValue = await getSetting('telegram_download_workers', String(DEFAULT_TELEGRAM_DOWNLOAD_WORKERS));
    return clampDownloadWorkers(storedValue);
}

// 用于追踪 Telegram FloodWait 的全局截止时间
let floodWaitUntil = 0;
const bridgedMessageCache = new Map<string, Api.Message>();

async function getFirstUserVisibleMediaMessage(
    userClient: TelegramClient,
    sourceEntity: Api.TypeEntityLike,
    sourceMessageId: number,
): Promise<Api.Message | undefined> {
    try {
        const [userVisibleMessage] = await userClient.getMessages(sourceEntity, { ids: sourceMessageId });
        return userVisibleMessage?.media ? userVisibleMessage : undefined;
    } catch (error) {
        console.warn('🤖 用户账号读取 Telegram 媒体消息失败:', error);
        return undefined;
    }
}

async function resolveDownloadSource(botClient: TelegramClient, message: Api.Message): Promise<{ client: TelegramClient; message: Api.Message }> {
    const userDownloadEnabled = (await getSetting('telegram_user_download_enabled', 'false')) === 'true';
    if (!userDownloadEnabled) {
        return { client: botClient, message };
    }

    const userClient = getTelegramUserClient();
    if (!userClient || !isTelegramUserClientReady()) {
        throw new Error('Telegram 用户账号下载已开启，但 user session 未就绪');
    }

    const bridgeChatId = process.env.TELEGRAM_DOWNLOAD_BRIDGE_CHAT_ID;
    if (bridgeChatId) {
        let sourceMessageId = message.id;
        const originalChatId = message.chatId?.toString();

        if (originalChatId !== bridgeChatId) {
            const cacheKey = `${originalChatId || 'unknown'}:${message.id}`;
            let bridgedMessage = bridgedMessageCache.get(cacheKey);

            if (!bridgedMessage) {
                const forwardedMessages = await botClient.forwardMessages(bridgeChatId, { messages: message, fromPeer: message.inputChat! });
                bridgedMessage = forwardedMessages?.[0];
                if (!bridgedMessage?.id) {
                    throw new Error('已配置桥接聊天，但 bot 未能把文件转发到桥接聊天；请确认 bot 在桥接群/频道内且有发消息权限');
                }
                bridgedMessageCache.set(cacheKey, bridgedMessage);
            }

            sourceMessageId = bridgedMessage.id;
        }

        const bridgeMessage = await getFirstUserVisibleMediaMessage(userClient, bridgeChatId, sourceMessageId);
        if (bridgeMessage) {
            return { client: userClient, message: bridgeMessage };
        }

        throw new Error('Telegram 用户账号无法读取桥接聊天里的媒体消息，请确认 bot 和用户账号都在桥接群/频道中，bot 有发消息权限，用户账号能看到桥接聊天');
    }

    const fwdFrom = message.fwdFrom as any;
    const forwardedSourcePeer = fwdFrom?.savedFromPeer || fwdFrom?.fromId;
    const forwardedSourceMessageId = fwdFrom?.savedFromMsgId || fwdFrom?.channelPost;
    if (forwardedSourcePeer && forwardedSourceMessageId) {
        const forwardedSourceMessage = await getFirstUserVisibleMediaMessage(userClient, forwardedSourcePeer as any, forwardedSourceMessageId);
        if (forwardedSourceMessage) {
            console.log(`🤖 使用用户账号从转发来源读取媒体: msg=${forwardedSourceMessageId}`);
            return { client: userClient, message: forwardedSourceMessage };
        }
    }

    const botMe = await botClient.getMe();
    const botUsername = (botMe as any)?.username;
    const botEntity = botUsername ? `@${botUsername}` : (botMe as any)?.id;
    if (botEntity) {
        const botDialogMessage = await getFirstUserVisibleMediaMessage(userClient, botEntity, message.id);
        if (botDialogMessage) {
            return { client: userClient, message: botDialogMessage };
        }
    }

    console.warn('🤖 用户账号无法读取该媒体消息，回退到 bot 会话下载；大于 bot 限制的文件可能仍会失败。');
    return { client: botClient, message };
}

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 安全编辑消息，捕获 FloodWaitError 并更新全局冷却状态
 */
async function safeEditMessage(client: TelegramClient, chatId: Api.TypeEntityLike, params: any) {
    if (Date.now() < floodWaitUntil) return null;

    try {
        const result = await client.editMessage(chatId, params);
        if (process.env.TG_STATUS_DEBUG === '1') {
            const chatIdStr = chatId.toString();
            const isSilent = silentSessionMap.has(chatIdStr);
            console.log(`[TG][status] edit chat=${chatIdStr} msg=${params?.message} silent=${isSilent}`);
        }
        return result;
    } catch (e: any) {
        if (e.errorMessage === 'FLOOD' || e.errorMessage?.includes('FLOOD_WAIT')) {
            const seconds = e.seconds || 30; // 默认冷却 30 秒
            floodWaitUntil = Date.now() + (seconds * 1000);
            console.warn(`[Telegram] ⚠️ 触发 FloodWait，冷却时间: ${seconds} 秒`);
        }
        return null;
    }
}

const silentNoticePromiseMap = new Map<string, Promise<any>>();

async function ensureSilentNotice(client: TelegramClient, chatId: Api.TypeEntityLike, fileCount: number, replyToMsg?: Api.Message) {
    const chatIdStr = chatId.toString();
    const silentSessionActive = silentSessionMap.has(chatIdStr);
    if (!silentSessionActive) return;

    // 已有静默通知消息
    const silentMsgId = silentNoticeMessageIdMap.get(chatIdStr);
    if (silentMsgId) {
        if (!replyToMsg) return; // 内部刷新 → 跳过，节省 API 调用
        // 用户发送了新消息 → 删除旧通知，在新消息下方重新发送
        try {
            await client.deleteMessages(chatId, [silentMsgId], { revoke: true });
        } catch (e) { }
        silentNoticeMessageIdMap.delete(chatIdStr);
    }

    // 防止静默模式提示被重复发送的并发锁
    if (silentNoticePromiseMap.has(chatIdStr)) {
        try { await silentNoticePromiseMap.get(chatIdStr); } catch (e) { }
        // 等待完成后再次检查：可能已被并发调用发送
        if (silentNoticeMessageIdMap.get(chatIdStr)) return;
    }

    const text = buildSilentModeNotice(fileCount);

    const sendPromise = (async () => {
        let sMsg: any;
        if (replyToMsg) {
            sMsg = await safeReply(replyToMsg, { message: text });
        }
        if (!sMsg) {
            try {
                sMsg = await client.sendMessage(chatId, { message: text });
            } catch (e) {
                console.error(`[TG][silent] notice-send-failed chat=${chatIdStr}:`, e);
            }
        }
        if (sMsg) {
            silentNoticeMessageIdMap.set(chatIdStr, sMsg.id);
            console.log(`[TG][silent] notice-sent chat=${chatIdStr} msg=${sMsg.id}`);
        }
        return sMsg;
    })();

    silentNoticePromiseMap.set(chatIdStr, sendPromise);
    try {
        await sendPromise;
    } finally {
        if (silentNoticePromiseMap.get(chatIdStr) === sendPromise) {
            silentNoticePromiseMap.delete(chatIdStr);
        }
    }
}

/**
 * 安全回复消息
 */
async function safeReply(message: Api.Message, params: { message: string, buttons?: any }) {
    if (Date.now() < floodWaitUntil) return null;

    try {
        const result = await message.reply(params);
        if (process.env.TG_STATUS_DEBUG === '1') {
            const chatIdStr = message.chatId?.toString() || 'unknown';
            const isSilent = silentSessionMap.has(chatIdStr);
            const msgId = (result as any)?.id;
            console.log(`[TG][status] reply chat=${chatIdStr} msg=${msgId} silent=${isSilent}`);
        }
        return result;
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
    abortController: AbortController;
    fileName: string;
    status: 'pending' | 'active' | 'success' | 'failed' | 'cancelled';
    error?: string;
    startTime?: number;
    endTime?: number;
    totalSize?: number;
    downloadedSize?: number;
}

// 下载队列 management 类
class BetterDownloadQueue {
    private queue: DownloadTask[] = [];
    private active: DownloadTask[] = [];
    private history: DownloadTask[] = [];
    private maxHistory = 50;
    private maxConcurrent = 2; // 用户要求并发限制为 2

    async add(fileName: string, execute: (signal: AbortSignal) => Promise<void>, totalSize: number = 0): Promise<void> {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        return new Promise((resolve, reject) => {
            const abortController = new AbortController();
            const task: DownloadTask = {
                id,
                fileName,
                status: 'pending',
                abortController,
                totalSize,
                downloadedSize: 0,
                // The actual execution logic
                execute: async () => {
                    task.status = 'active';
                    task.startTime = Date.now();
                    this.active.push(task);

                    try {
                        await execute(abortController.signal);
                        task.status = abortController.signal.aborted ? 'cancelled' : 'success';
                        resolve();
                    } catch (error) {
                        task.status = abortController.signal.aborted ? 'cancelled' : 'failed';
                        task.error = (error instanceof Error) ? error.message : String(error);
                        if (abortController.signal.aborted) {
                            resolve();
                        } else {
                            reject(error);
                        }
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

    forceStopAll(reason: string = '用户强制停止'): { active: number; pending: number; total: number } {
        const pending = this.queue.splice(0);
        for (const task of pending) {
            task.status = 'cancelled';
            task.error = reason;
            task.endTime = Date.now();
            this.history.unshift(task);
        }

        for (const task of this.active) {
            task.error = reason;
            task.abortController.abort(reason);
        }

        if (this.history.length > this.maxHistory) {
            this.history.splice(this.maxHistory);
        }

        return { active: this.active.length, pending: pending.length, total: this.active.length + pending.length };
    }
}

const downloadQueue = new BetterDownloadQueue();

// 状态操作序列化器
const statusActionLocks = new Map<string, Promise<void>>();
const lastSilentNotificationTimeMap = new Map<string, number>();
const SILENT_NOTIFICATION_COOLDOWN = 30000; // 30 seconds debounce per chat

/**
 * 在 per-chat 序列化锁中执行状态操作
 */
async function runStatusAction(chatId: Api.TypeEntityLike | undefined, action: () => Promise<void>) {
    if (!chatId) return;
    const chatIdStr = chatId.toString();
    const currentLock = statusActionLocks.get(chatIdStr) || Promise.resolve();
    const nextLock = currentLock.then(async () => {
        try {
            await action();
        } catch (e) {
            console.error(`[Status] ❌ Action failed for chat ${chatIdStr}:`, e);
        }
    });
    statusActionLocks.set(chatIdStr, nextLock);
    return nextLock;
}

// 用于追踪每个会话最后一条状态消息 ID 的映射
const lastStatusMessageIdMap = new Map<string, number>();
const silentNoticeMessageIdMap = new Map<string, number>();

interface SilentSession {
    total: number;
    completed: number;
    failed: number;
}

const silentSessionMap = new Map<string, SilentSession>();

function getSilentSession(chatIdStr: string): SilentSession {
    let s = silentSessionMap.get(chatIdStr);
    if (!s) {
        s = { total: 0, completed: 0, failed: 0 };
        silentSessionMap.set(chatIdStr, s);
    }
    return s;
}

function startSilentSession(chatIdStr: string, total: number): SilentSession {
    const s = { total, completed: 0, failed: 0 };
    silentSessionMap.set(chatIdStr, s);
    return s;
}

async function finalizeSilentSessionIfDone(client: TelegramClient, chatId: Api.TypeEntityLike) {
    const chatIdStr = chatId.toString();
    if (!silentSessionMap.has(chatIdStr)) return;

    const outstanding = getOutstandingTaskCount(chatIdStr);
    if (outstanding > 0) return;

    // 全部完成：退出静默模式
    const s = silentSessionMap.get(chatIdStr);
    const silentMsgId = silentNoticeMessageIdMap.get(chatIdStr);

    // 编辑静默通知为完成消息
    if (silentMsgId) {
        const text = buildSilentAllTasksComplete(s?.failed || 0);
        await safeEditMessage(client, chatId, { message: silentMsgId, text });
    }

    // 清理静默状态
    silentSessionMap.delete(chatIdStr);
    silentNoticeMessageIdMap.delete(chatIdStr);
    lastSilentNotificationTimeMap.delete(chatIdStr);

    console.log(`[TG][silent] finalized chat=${chatIdStr} failed=${s?.failed || 0}`);
}

/**
 * 计算后台文件总数 = 下载队列中的活跃文件 + 已注册但未完成的单文件 + 批量任务中未完成的文件
 */
function getBackgroundFileCount(chatIdStr: string): number {
    // 1. 只统计当前聊天中“未完成”的单文件上传 (避开 8 秒展示期的已成功/已失败任务)
    const files = getConsolidatedFiles(chatIdStr);
    const activeFilesCount = files.filter(f => f.phase !== 'success' && f.phase !== 'failed').length;

    // 2. 只统计当前聊天中“未完成”的批量任务中的剩余文件
    const batches = getConsolidatedBatches(chatIdStr);
    const activeBatchFiles = batches
        .filter(b => b.completed < b.totalFiles)
        .reduce((sum, b) => sum + (b.totalFiles - b.completed), 0);

    const count = activeFilesCount + activeBatchFiles;

    const logLine = `[TG][silent][${Date.now()}] fileCount chat=${chatIdStr}: activeFiles=${activeFilesCount} activeBatchFiles=${activeBatchFiles} => total=${count}\n`;
    console.log(logLine.trim());
    try { fs.appendFileSync('tg_silent_debug.log', logLine); } catch (e) { }

    return count;
}

/**
 * 集中化静默模式触发逻辑
 * 后台文件数量超过 3 个时进入静默模式
 */
async function trySilentMode(client: TelegramClient, chatId: Api.TypeEntityLike, message?: Api.Message) {
    const chatIdStr = chatId.toString();
    const fileCount = getBackgroundFileCount(chatIdStr);
    const isSilent = silentSessionMap.has(chatIdStr);

    const logLine = `[TG][silent][${Date.now()}] tryCheck chat=${chatIdStr} fileCount=${fileCount} isSilent=${isSilent}\n`;
    console.log(logLine.trim());
    try { fs.appendFileSync('tg_silent_debug.log', logLine); } catch (e) { }

    if (fileCount > 3 || isSilent) {
        if (!isSilent) {
            // 首次进入静默模式
            await deleteLastStatusMessage(client, chatId);
            startSilentSession(chatIdStr, fileCount);
            console.log(`[TG][silent] ACTIVATED chat=${chatIdStr} files=${fileCount}`);
        } else {
            // 已在静默模式，更新计数
            const sess = getSilentSession(chatIdStr);
            sess.total = Math.max(sess.total, fileCount);
        }
        await ensureSilentNotice(client, chatId, fileCount, message);
        return true; // 表示已进入/处于静默模式
    }
    return false;
}

/**
 * 安全删除并追踪最后一条状态消息
 */
async function deleteLastStatusMessage(client: TelegramClient, chatId: Api.TypeEntityLike | undefined) {
    if (!chatId) return;
    const chatIdStr = chatId.toString();
    const lastMsgId = lastStatusMessageIdMap.get(chatIdStr);
    if (lastMsgId) {
        if (process.env.TG_STATUS_DEBUG === '1') {
            const isSilent = silentSessionMap.has(chatIdStr);
            console.log(`[TG][status] delete chat=${chatIdStr} msg=${lastMsgId} silentSession=${isSilent}`);
        }
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
function updateLastStatusMessageId(chatId: Api.TypeEntityLike | undefined, msgId: number | undefined, isSilent: boolean = false) {
    if (!chatId || !msgId) return;
    const chatIdStr = chatId.toString();
    lastStatusMessageIdMap.set(chatIdStr, msgId);
    if (process.env.TG_STATUS_DEBUG === '1') {
        const sess = silentSessionMap.has(chatIdStr);
        console.log(`[TG][status] last chat=${chatIdStr} msg=${msgId} sess=${sess}`);
    }
}

// ─── 单文件合并状态追踪器 ──────────────────────────────────────

interface ActiveUploadEntry {
    fileName: string;
    typeEmoji: string;
    phase: ConsolidatedUploadFile['phase'];
    downloaded?: number;
    total?: number;
    size?: number;
    error?: string;
    providerName?: string;
    fileType?: string;
    folder?: string | null;
}

// 每个 chat 的当前活跃单文件上传列表
const chatActiveUploads = new Map<string, Map<string, ActiveUploadEntry>>();

function registerUpload(chatId: string, uploadId: string, entry: ActiveUploadEntry) {
    if (!chatActiveUploads.has(chatId)) {
        chatActiveUploads.set(chatId, new Map());
    }
    chatActiveUploads.get(chatId)!.set(uploadId, entry);
}

function updateUploadPhase(chatId: string, uploadId: string, updates: Partial<ActiveUploadEntry>) {
    const map = chatActiveUploads.get(chatId);
    if (!map) return;
    const entry = map.get(uploadId);
    if (entry) Object.assign(entry, updates);
}

function removeUpload(chatId: string, uploadId: string) {
    const map = chatActiveUploads.get(chatId);
    if (map) {
        map.delete(uploadId);
        if (map.size === 0) chatActiveUploads.delete(chatId);
    }
}

function getActiveUploadCount(chatId: string): number {
    return chatActiveUploads.get(chatId)?.size || 0;
}

function getConsolidatedFiles(chatId: string): ConsolidatedUploadFile[] {
    const map = chatActiveUploads.get(chatId);
    if (!map) return [];
    return Array.from(map.values());
}

// 每个 chat 的当前活跃批量上传列表
const chatActiveBatches = new Map<string, Map<string, ConsolidatedBatchEntry>>();

function registerBatch(chatId: string, batchId: string, entry: ConsolidatedBatchEntry) {
    if (!chatActiveBatches.has(chatId)) {
        chatActiveBatches.set(chatId, new Map());
    }
    chatActiveBatches.get(chatId)!.set(batchId, entry);
}

function updateBatch(chatId: string, batchId: string, updates: Partial<ConsolidatedBatchEntry>) {
    const map = chatActiveBatches.get(chatId);
    if (!map) return;
    const entry = map.get(batchId);
    if (entry) Object.assign(entry, updates);
}

function removeBatch(chatId: string, batchId: string) {
    const map = chatActiveBatches.get(chatId);
    if (map) {
        map.delete(batchId);
        if (map.size === 0) chatActiveBatches.delete(chatId);
    }
}

function getActiveBatchCount(chatId: string): number {
    return chatActiveBatches.get(chatId)?.size || 0;
}

function getConsolidatedBatches(chatId: string): ConsolidatedBatchEntry[] {
    const map = chatActiveBatches.get(chatId);
    if (!map) return [];
    return Array.from(map.values());
}

function clearConsolidatedState(chatId: string) {
    chatActiveUploads.delete(chatId);
    chatActiveBatches.delete(chatId);
}

function isAllConsolidatedTasksDone(chatId: string): boolean {
    const files = getConsolidatedFiles(chatId);
    const batches = getConsolidatedBatches(chatId);
    if (files.length === 0 && batches.length === 0) return true;
    const filesDone = files.every(f => f.phase === 'success' || f.phase === 'failed');
    const batchesDone = batches.every(b => b.completed === b.totalFiles);
    return filesDone && batchesDone;
}

function getOutstandingTaskCount(chatIdStr: string): number {
    const files = getConsolidatedFiles(chatIdStr);
    const batches = getConsolidatedBatches(chatIdStr);

    const outstandingFiles = files.filter(f => f.phase !== 'success' && f.phase !== 'failed').length;
    const outstandingBatches = batches.filter(b => b.completed < b.totalFiles).length;
    return outstandingFiles + outstandingBatches;
}



/** Check if this is a start of a new session and cleanup old statuses */
async function checkAndResetSession(client: TelegramClient, chatId: Api.TypeEntityLike) {
    const chatIdStr = chatId.toString();

    // 增强：如果当前没有任何正在进行的任务，但却残留了静默模式标志，强制清理它
    // 这能解决因重启或异常导致的“僵尸”静默会话问题
    const outstanding = getOutstandingTaskCount(chatIdStr);
    if (outstanding === 0 && silentSessionMap.has(chatIdStr)) {
        silentSessionMap.delete(chatIdStr);
        silentNoticeMessageIdMap.delete(chatIdStr);
        lastSilentNotificationTimeMap.delete(chatIdStr);
        console.log(`[TG][silent] Auto-cleared zombie session for ${chatIdStr}`);
        return; // 清理后直接返回，让后续逻辑正常按非静默处理
    }

    if (silentSessionMap.has(chatIdStr)) {
        if (process.env.TG_STATUS_DEBUG === '1') {
            console.log(`[TG][status] reset-skip chat=${chatIdStr} reason=silentSession`);
        }
        return;
    }
    const hasAnyTask = getActiveBatchCount(chatIdStr) > 0 || getActiveUploadCount(chatIdStr) > 0;
    // If no tasks recorded OR all recorded tasks are already completed,
    // treat the next incoming upload as a new session: delete old tracker and reset state.
    if (!hasAnyTask || isAllConsolidatedTasksDone(chatIdStr)) {
        await deleteLastStatusMessage(client, chatId);
        clearConsolidatedState(chatIdStr);
    }
}

/** 更新合并状态消息 */
async function refreshConsolidatedMessage(client: TelegramClient, chatId: Api.TypeEntityLike, replyTo?: Api.Message) {
    const chatIdStr = chatId.toString();

    // 集中判断：如果文件数超过 3 或已在静默模式，直接触发 trySilentMode 并返回
    const alreadySilent = silentSessionMap.has(chatIdStr);
    const fileCount = getBackgroundFileCount(chatIdStr);

    const logLine = `[TG][consolidated][${Date.now()}] check chat=${chatIdStr} silent=${alreadySilent} fileCount=${fileCount} replyTo=${!!replyTo}\n`;
    try { fs.appendFileSync('tg_silent_debug.log', logLine); } catch (e) { }

    if (alreadySilent || fileCount > 3) {
        await trySilentMode(client, chatId, replyTo);
        return;
    }

    const files = getConsolidatedFiles(chatIdStr);
    const batches = getConsolidatedBatches(chatIdStr);

    if (files.length === 0 && batches.length === 0) return;

    const text = await buildConsolidatedStatus(files, batches);
    const existingMsgId = lastStatusMessageIdMap.get(chatIdStr);

    // 新任务触发（有 replyTo）：强制删除旧追踪器，并发送一条新的追踪器消息
    if (replyTo) {
        await deleteLastStatusMessage(client, chatId);
        const msg = await safeReply(replyTo, { message: text }) as Api.Message;
        if (msg) {
            updateLastStatusMessageId(chatId, msg.id, false);
        }
        return;
    }

    // 进度更新触发（无 replyTo）：编辑现有追踪器
    if (existingMsgId) {
        await safeEditMessage(client, chatId, { message: existingMsgId, text });
    }
}

// 导出获取队列统计信息的函数
export function getDownloadQueueStats() {
    return downloadQueue.getStats();
}

export function getTaskStatus() {
    return downloadQueue.getDetailedStatus();
}

export function forceStopDownloadTasks(reason?: string) {
    return downloadQueue.forceStopAll(reason);
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
    targetDir?: string;          // 批量上传时文件的目标目录
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

function getDownloadableMedia(message: Api.Message): any | null {
    if (!message.media) return null;
    const media: any = message.media;
    if (message.document || message.photo || message.video || message.audio || message.voice || message.sticker) {
        return message.media;
    }
    if (media.document || media.photo) {
        return media.document || media.photo;
    }
    if (media.webpage?.document || media.webpage?.photo) {
        return media.webpage.document || media.webpage.photo;
    }
    return null;
}

function isTelegramPhotoMedia(media: any): boolean {
    const inner = media?.photo || media;
    return media?.className === 'MessageMediaPhoto' || inner?.className === 'Photo' || Boolean(inner?.sizes);
}

// 获取文件预估大小
function getEstimatedFileSize(message: Api.Message): number {
    const media = getDownloadableMedia(message);
    if (isTelegramPhotoMedia(media)) {
        return 0;
    }
    const document = (media as any)?.document || media;
    if (document?.size) {
        return Number(document.size) || 0;
    }
    return 0;
}

// 进度条函数已移至 telegramMessages.ts (generateProgressBar)

function getDocumentFilename(document: any, fallback: string): string {
    const fileNameAttr = document.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
    return fileNameAttr?.fileName || fallback;
}

// 提取文件信息
function extractFileInfo(message: Api.Message): { fileName: string; mimeType: string } | null {
    const downloadableMedia = getDownloadableMedia(message);
    if (!downloadableMedia) return null;

    let fileName = 'unknown';
    let mimeType = 'application/octet-stream';

    try {
        if (message.document) {
            const doc = message.document as Api.Document;
            const fileNameAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || `file_${message.id}`;
            mimeType = doc.mimeType || getMimeTypeFromFilename(fileName);

            // 如果是音频/视频但没有文件名属性，尝试根据类型生成
            if (fileName.startsWith('file_')) {
                const videoAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeVideo');
                const audioAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeAudio');
                if (videoAttr) fileName = `video_${message.id}.mp4`;
                else if (audioAttr) fileName = `audio_${message.id}.mp3`;
            }
        } else if (message.photo) {
            const date = new Date();
            const timestamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
            fileName = `Img_${timestamp}.jpg`;
            mimeType = 'image/jpeg';
        } else if (message.video) {
            const video = message.video as Api.Document;
            const fileNameAttr = video.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || `video_${message.id}.mp4`;
            mimeType = video.mimeType || 'video/mp4';
        } else if (message.audio) {
            const audio = message.audio as Api.Document;
            const fileNameAttr = audio.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
            fileName = fileNameAttr?.fileName || `audio_${message.id}.mp3`;
            mimeType = audio.mimeType || 'audio/mpeg';
        } else if (message.voice) {
            fileName = `voice_${message.id}.ogg`;
            mimeType = 'audio/ogg';
        } else if (message.sticker) {
            fileName = `sticker_${message.id}.webp`;
            mimeType = 'image/webp';
        } else {
            const media = message.media as any;
            if (media.document && media.document instanceof Api.Document) {
                const doc = media.document;
                const fileNameAttr = doc.attributes?.find((a: any) => a.className === 'DocumentAttributeFilename') as any;
                fileName = fileNameAttr?.fileName || `file_${message.id}`;
                mimeType = doc.mimeType || getMimeTypeFromFilename(fileName);
            } else {
                const document = (downloadableMedia as any).document || (downloadableMedia as any);
                const photo = (downloadableMedia as any).photo || (downloadableMedia as any);
                if (document?.className === 'Document' || document?.attributes) {
                    fileName = getDocumentFilename(document, `file_${message.id}`);
                    mimeType = document.mimeType || getMimeTypeFromFilename(fileName);
                } else if (photo?.className === 'Photo' || photo?.sizes) {
                    const date = new Date((message.date || Math.floor(Date.now() / 1000)) * 1000);
                    const timestamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
                    fileName = `Img_${timestamp}_${message.id}.jpg`;
                    mimeType = 'image/jpeg';
                } else {
                    return null;
                }
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
    originalFileName: string, // The original file name from Telegram
    targetDir?: string,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
): Promise<{ filePath: string; actualSize: number; tempStoredName: string } | null> {
    const ext = path.extname(originalFileName) || '';
    // 使用 UUID 作为本地临时文件，避免同名冲突
    const tempStoredName = `${crypto.randomUUID()}${ext}`;
    let saveDir = targetDir || UPLOAD_DIR;

    if (!fs.existsSync(saveDir)) {
        try {
            fs.mkdirSync(saveDir, { recursive: true });
        } catch (err) {
            console.error(`🤖 创建下载目录失败: ${saveDir}`, err);
            if (saveDir === UPLOAD_DIR) throw err;
            saveDir = UPLOAD_DIR;
        }
    }

    const filePath = path.join(saveDir, tempStoredName);
    const totalSize = getEstimatedFileSize(message);
    let downloadedSize = 0;

    try {
        if (signal?.aborted) throw new Error('下载任务已停止');
        const configuredWorkers = await getTelegramDownloadWorkers();
        const media = getDownloadableMedia(message);
        if (!media) {
            throw new Error('该图文消息未包含可下载媒体');
        }
        const isPhotoMedia = isTelegramPhotoMedia(media);
        const workers = !isPhotoMedia && totalSize > TELEGRAM_DOWNLOAD_PART_SIZE
            ? Math.min(configuredWorkers, Math.ceil(totalSize / TELEGRAM_DOWNLOAD_PART_SIZE))
            : 1;
        console.log(`🤖 Telegram 下载参数: workers=${workers}, part=${TELEGRAM_DOWNLOAD_PART_SIZE} bytes, size=${totalSize || 'unknown'}, photo=${isPhotoMedia}`);

        if (isPhotoMedia) {
            const downloaded = await client.downloadMedia(message, {
                outputFile: filePath,
                progressCallback: onProgress,
            });
            if (!downloaded || !fs.existsSync(filePath)) {
                throw new Error('Telegram 图片下载未生成文件');
            }
        } else if (workers > 1 && totalSize > 0) {
            const fileHandle = await fs.promises.open(filePath, 'w');
            try {
                await fileHandle.truncate(totalSize);

                await Promise.all(Array.from({ length: workers }, async (_, workerIndex) => {
                    let writeOffset = workerIndex * TELEGRAM_DOWNLOAD_PART_SIZE;
                    for await (const chunk of client.iterDownload({
                        file: media,
                        offset: bigInt(writeOffset),
                        stride: TELEGRAM_DOWNLOAD_PART_SIZE * workers,
                        chunkSize: TELEGRAM_DOWNLOAD_PART_SIZE,
                        requestSize: TELEGRAM_DOWNLOAD_PART_SIZE,
                        fileSize: bigInt(totalSize),
                    })) {
                        if (signal?.aborted) throw new Error('下载任务已停止');
                        if (writeOffset >= totalSize) break;
                        const bytesToWrite = Math.min(chunk.length, totalSize - writeOffset);
                        if (bytesToWrite > 0) {
                            await fileHandle.write(chunk.subarray(0, bytesToWrite), 0, bytesToWrite, writeOffset);
                            downloadedSize += bytesToWrite;
                            if (onProgress) {
                                onProgress(Math.min(downloadedSize, totalSize), totalSize);
                            }
                        }
                        writeOffset += TELEGRAM_DOWNLOAD_PART_SIZE * workers;
                    }
                }));
            } finally {
                await fileHandle.close();
            }
        } else {
            const writeStream = fs.createWriteStream(filePath);

            for await (const chunk of client.iterDownload({
                file: media,
                requestSize: TELEGRAM_DOWNLOAD_PART_SIZE,
            })) {
                if (signal?.aborted) throw new Error('下载任务已停止');
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
        }

        const stats = fs.statSync(filePath);
        if (totalSize > 0 && stats.size !== totalSize) {
            throw new Error(`下载文件大小不一致: expected=${totalSize}, actual=${stats.size}`);
        }
        return { filePath, actualSize: stats.size, tempStoredName };
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
    const provider = storageManager.getProvider();
    const stats = downloadQueue.getStats();
    return buildBatchStatus({
        files: queue.files.map(f => ({
            fileName: f.fileName,
            mimeType: f.mimeType,
            status: f.status,
            size: f.size,
            error: f.error,
        })),
        folderName: queue.folderName,
        providerName: provider.name,
        queuePending: stats.pending,
        queueActive: stats.active,
    });
}

// 处理单个文件上传（带重试机制）
async function processFileUpload(client: TelegramClient, file: FileUploadItem, queue?: MediaGroupQueue): Promise<void> {
    file.status = 'queued';

    const attemptUpload = async (signal?: AbortSignal): Promise<boolean> => {
        let localFilePath: string | undefined;
        let storedName: string | undefined; // This will hold the unique name for final storage

        try {
            // 获取唯一的存储文件名
            const activeAccountId = storageManager.getActiveAccountId();
            const chatName = await getTelegramChatName(file.message);
            const storageRules = await getStoragePathRules();
            const storageFolder = buildStorageFolderWithRules({
                source: 'telegram',
                chatName,
                folder: queue?.folderName || null,
                mimeType: file.mimeType,
                fileName: file.fileName,
            }, storageRules);
            storedName = await getUniqueStoredName(file.fileName, storageFolder, activeAccountId);

            const downloadSource = await resolveDownloadSource(client, file.message);
            const result = await downloadAndSaveFile(downloadSource.client, downloadSource.message, file.fileName, file.targetDir, undefined, signal);
            if (!result) {
                file.error = '下载失败';
                return false;
            }

            localFilePath = result.filePath;
            // storedName 已在上方生成，结果中的 storedName 是原始名，由于我们已手动生成唯一名，忽略
            const actualSize = result.actualSize;
            const fileType = getFileType(file.mimeType);
            const duplicateMode = await getDuplicateMode();
            if (duplicateMode === 'skip') {
                const duplicate = await findDuplicateFile(file.fileName, storageFolder, actualSize, activeAccountId);
                if (duplicate) {
                    file.status = 'success';
                    file.size = actualSize;
                    file.fileType = fileType;
                    if (localFilePath && fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
                    return true;
                }
            }

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

            try {
                finalPath = await provider.saveFile(localFilePath, storedName, file.mimeType, storageFolder);
                if (fs.existsSync(localFilePath)) {
                    fs.unlinkSync(localFilePath);
                }
                localFilePath = undefined;
            } catch (err) {
                console.error('保存文件到存储提供商失败:', err);
                throw err;
            }

            await query(`
                INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [file.fileName, storedName, fileType, file.mimeType, actualSize, finalPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, storageFolder, activeAccountId]);

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
                    console.log(`🤖 上传尝试失败，已自动清理本地垃圾缓存: ${localFilePath}`);
                } catch (e) {
                    console.error('🤖 自动清理垃圾缓存失败:', e);
                }
            }
            return false;
        }
    };

    const queueTask = async (signal: AbortSignal) => {
        file.status = 'uploading';
        // 不再单独更新 msg，由外部轮询或回调处理
        // if (queue && queue.statusMsgId && queue.chatId) ...

        const firstAttemptSuccess = await attemptUpload(signal);

        if (!firstAttemptSuccess && !signal.aborted && !file.retried) {
            file.retried = true;
            file.status = 'uploading'; // 保持 uploading 状态供外部显示
            file.error = undefined;
            // retry message? 外部 ConsolidatedStatus 会处理 retrying 状态显示，这里暂时还是 uploading
            // 可以在 attemptUpload 内部加 retry 逻辑
            const secondAttemptSuccess = await attemptUpload(signal);
            if (!secondAttemptSuccess) {
                file.status = 'failed';
            }
        } else if (!firstAttemptSuccess) {
            file.status = 'failed';
        }
    };

    const taskDisplayName = queue?.folderName ? `${queue.folderName}/${file.fileName}` : file.fileName;
    return downloadQueue.add(taskDisplayName, queueTask);
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
            folderName = caption.split(/\r?\n/)[0].trim();
            break;
        }
    }

    const chatId = queue.chatId!;
    const batchId = mediaGroupId;

    if (!folderName || isOpaqueTelegramIdentifier(folderName)) {
        folderName = await getTelegramBatchFolderName(firstMessage, mediaGroupId);
    }

    // 新会话重置检查
    await checkAndResetSession(client, chatId);

    // 注册批量任务到追踪器
    registerBatch(chatId.toString(), batchId, {
        id: batchId,
        folderName,
        totalFiles: queue.files.length,
        completed: 0,
        successful: 0,
        failed: 0,
        providerName: storageManager.getProvider().name,
        queuePending: 0
    });

    // 路径穿越防御：清理文件夹名称
    const sanitizedFolderName = sanitizeFilename(folderName);
    const targetDir = path.join(UPLOAD_DIR, sanitizedFolderName);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // 更新队列中所有文件的目标路径
    queue.folderName = sanitizedFolderName;
    for (const file of queue.files) {
        file.targetDir = targetDir;
    }

    // 立即显示合并状态（静默模式下跳过）
    if (!silentSessionMap.has(chatId.toString())) {
        await runStatusAction(chatId, async () => {
            const stats = downloadQueue.getStats();
            // 如果是大量文件且之前是静默模式，可能需要保持静默或发送静默通知
            // 这里简化逻辑：直接使用合并视图
            await refreshConsolidatedMessage(client, chatId, firstMessage);
        });
    }

    // 批量上传时的回调，用于更新 Batch Entry
    const onBatchProgress = async () => {
        const completed = queue.files.filter(f => f.status === 'success' || f.status === 'failed').length;
        const successful = queue.files.filter(f => f.status === 'success').length;
        const failed = queue.files.filter(f => f.status === 'failed').length;
        const stats = downloadQueue.getStats();

        updateBatch(chatId.toString(), batchId, {
            completed,
            successful,
            failed,
            queuePending: stats.pending
        });

        // 静默模式下跳过合并状态更新
        if (!silentSessionMap.has(chatId.toString())) {
            await runStatusAction(chatId, async () => {
                await refreshConsolidatedMessage(client, chatId);
            });
        }
    };

    const refreshBatchProgressAndFinalizeSilent = async () => {
        await onBatchProgress();
        const chatIdStr = chatId.toString();
        if (silentSessionMap.has(chatIdStr)) {
            const sess = getSilentSession(chatIdStr);
            const failedFiles = getConsolidatedFiles(chatIdStr).filter(f => f.phase === 'failed').length;
            const failedBatches = getConsolidatedBatches(chatIdStr).reduce((sum, b) => sum + (b.failed || 0), 0);
            sess.failed = Math.max(sess.failed, failedFiles + failedBatches);
            await finalizeSilentSessionIfDone(client, chatId);
        }
    };

    // 定时更新状态（作为补充，防止回调太频繁或丢失）
    let lastTime = 0;
    const statusUpdater = setInterval(async () => {
        const now = Date.now();
        if (now - lastTime < 3000) return;
        lastTime = now;
        await onBatchProgress();
    }, 3000);

    try {
        // 启动所有文件上传
        // 注意：我们需要修改 processFileUpload 以便它能正确工作，
        // 或者我们可以在这里包装它。processFileUpload 自带了 retry 逻辑。
        // 为了简单，我们让 processFileUpload 更新 file.status，我们要监控 queue.files 的状态变化。
        // 上面的 setInterval 已经负责了轮询状态并更新 UI。
        // 我们只需等待所有 promise 完成。

        // 启动所有文件上传，并根据索引命名
        await Promise.all(queue.files.map((file, index) => {
            // 如果文件夹名不是默认的 ID，我们可以给里面的文件加个索引
            const ext = path.extname(file.fileName);
            const baseName = queue.folderName || 'file';
            // 只有当文件夹名比较有意义时才使用文件夹名作为前缀
            const isDefaultFolder = /^[0-9-]+$/.test(baseName);

            if (!isDefaultFolder) {
                file.fileName = `${baseName}_${index + 1}${ext}`;
            }

            return processFileUpload(client, file, queue).finally(refreshBatchProgressAndFinalizeSilent);
        }));

        // 最后一次更新状态
        await onBatchProgress();

    } finally {
        clearInterval(statusUpdater);

        // 任务完成后延迟清理追踪器条目
        // 只有当所有关联的 batch 都完成了，最后的消息才会被保留
        setTimeout(() => {
            removeBatch(chatId.toString(), batchId);
            // 触发一次刷新，如果还有其他任务则显示它们，如果没有则不通过 refreshConsolidatedMessage 发消息
            // 注意：refreshConsolidatedMessage 如果没有任务会直接返回

            // 为了让用户看到最终结果，我们不立即删除最后一条消息
            // 而是依赖下一次任务开始时复用或新建
        }, 8000);

        // 清理 mediaGroup
        mediaGroupQueues.delete(mediaGroupId);
    }
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
        await message.reply({ message: MSG.AUTH_REQUIRED_UPLOAD });
        return;
    }

    const fileInfo = extractFileInfo(message);
    if (!fileInfo) {
        if (message.media) {
            if ((message.media as any).className === 'MessageMediaWebPage') return;
            await message.reply({ message: MSG.UNSUPPORTED_MEDIA });
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

        // 先把 media group 登记到合并追踪器里
        if (message.chatId) {
            const chatIdStr = message.chatId.toString();
            const batchId = mediaGroupId;
            const batchMap = chatActiveBatches.get(chatIdStr);
            if (!batchMap || !batchMap.has(batchId)) {
                registerBatch(chatIdStr, batchId, {
                    id: batchId,
                    folderName: queue.folderName || 'media-group',
                    totalFiles: queue.files.length,
                    completed: 0,
                    successful: 0,
                    failed: 0,
                    providerName: storageManager.getProvider().name,
                    queuePending: 0,
                });
            } else {
                updateBatch(chatIdStr, batchId, {
                    totalFiles: queue.files.length,
                });
            }
        }

        if (message.chatId) {
            await trySilentMode(client, message.chatId, message);
        }
    } else {
        let finalFileName = fileName;
        const caption = message.message || '';
        if (caption && caption.trim()) {
            const ext = path.extname(fileName);
            const firstLine = caption.split(/\r?\n/)[0].trim();
            const sanitizedCaption = sanitizeFilename(firstLine);

            if (ext && !sanitizedCaption.toLowerCase().endsWith(ext.toLowerCase())) {
                finalFileName = `${sanitizedCaption}${ext}`;
            } else {
                finalFileName = sanitizedCaption;
            }
        }

        const typeEmoji = getTypeEmoji(mimeType);
        const totalSize = getEstimatedFileSize(message);
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const chatId = message.chatId!;
        const chatIdStr = chatId.toString();

        if (message.chatId) {
            await checkAndResetSession(client, chatId);
        }

        registerUpload(chatIdStr, uploadId, {
            fileName: finalFileName,
            typeEmoji,
            phase: 'queued',
            total: totalSize,
        });

        let statusMsg: Api.Message | undefined;
        const useConsolidated = () => getActiveUploadCount(chatIdStr) >= 2 || getActiveBatchCount(chatIdStr) > 0;

        await trySilentMode(client, chatId, message);

        if (!silentSessionMap.has(chatIdStr) && getBackgroundFileCount(chatIdStr) <= 3) {
            await runStatusAction(chatId, async () => {
                if (useConsolidated()) {
                    await refreshConsolidatedMessage(client, chatId, message);
                } else {
                    await deleteLastStatusMessage(client, chatId);
                    statusMsg = await safeReply(message, {
                        message: buildDownloadProgress(finalFileName, 0, totalSize, typeEmoji)
                    }) as Api.Message;
                    if (statusMsg) {
                        updateLastStatusMessageId(chatId, statusMsg.id, false);
                    }
                }
            });
        }

        const stats = downloadQueue.getStats();
        if (!useConsolidated() && statusMsg && (stats.active >= 2 || stats.pending > 0) && !silentSessionMap.has(chatIdStr)) {
            await runStatusAction(chatId, async () => {
                await safeEditMessage(client, chatId, {
                    message: statusMsg!.id,
                    text: buildQueuedMessage(finalFileName, stats.pending)
                });
            });
        }

        let lastUpdateTime = 0;
        const onProgress = async (downloaded: number, total: number) => {
            const now = Date.now();
            if (now - lastUpdateTime < 3000) return;
            lastUpdateTime = now;

            updateUploadPhase(chatIdStr, uploadId, { phase: 'downloading', downloaded, total });

            if (silentSessionMap.has(chatIdStr)) return;

            if (useConsolidated()) {
                await runStatusAction(chatId, async () => {
                    await refreshConsolidatedMessage(client, chatId);
                });
            } else if (statusMsg) {
                await runStatusAction(chatId, async () => {
                    await safeEditMessage(client, chatId, {
                        message: statusMsg!.id,
                        text: buildDownloadProgress(finalFileName, downloaded, total, typeEmoji),
                    });
                });
            }
        };

        let retryCount = 0;
        const maxRetries = 1;
        let lastLocalPath: string | undefined;
        let lastError: string | undefined;

        const attemptSingleUpload = async (signal?: AbortSignal): Promise<boolean> => {
            let localFilePath: string | undefined;
            try {
                if (signal?.aborted) throw new Error('下载任务已停止');
                const activeAccountId = storageManager.getActiveAccountId();
                const chatName = await getTelegramChatName(message);
                const storageRules = await getStoragePathRules();
                const storageFolder = buildStorageFolderWithRules({
                    source: 'telegram',
                    chatName,
                    mimeType,
                    fileName: finalFileName,
                }, storageRules);
                // 关键在这里：获取唯一文件名
                const storedName = await getUniqueStoredName(finalFileName, storageFolder, activeAccountId);

                const downloadSource = await resolveDownloadSource(client, message);
                const result = await downloadAndSaveFile(downloadSource.client, downloadSource.message, fileName, undefined, onProgress, signal);
                if (!result) {
                    lastError = '下载失败';
                    return false;
                }
                localFilePath = result.filePath;
                lastLocalPath = localFilePath;
                const { actualSize } = result;
                const fileType = getFileType(mimeType);
                const duplicateMode = await getDuplicateMode();
                if (duplicateMode === 'skip') {
                    const duplicate = await findDuplicateFile(finalFileName, storageFolder, actualSize, activeAccountId);
                    if (duplicate) {
                        if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
                        lastLocalPath = undefined;
                        updateUploadPhase(chatIdStr, uploadId, { phase: 'success', size: actualSize, providerName: storageManager.getProvider().name, fileType, folder: storageFolder });
                        if (statusMsg && !silentSessionMap.has(chatIdStr)) {
                            await runStatusAction(chatId, async () => {
                                await client.editMessage(chatId, {
                                    message: statusMsg!.id,
                                    text: buildDuplicateSkipped(finalFileName, storageFolder, duplicate.id),
                                });
                            });
                        }
                        return true;
                    }
                }

                updateUploadPhase(chatIdStr, uploadId, { phase: 'saving' });
                if (useConsolidated()) {
                    await runStatusAction(chatId, async () => {
                        await refreshConsolidatedMessage(client, chatId);
                    });
                } else if (statusMsg && !silentSessionMap.has(chatIdStr)) {
                    await runStatusAction(chatId, async () => {
                        await safeEditMessage(client, chatId, {
                            message: statusMsg!.id,
                            text: buildSavingFile(finalFileName, typeEmoji),
                        });
                    });
                }

                let thumbnailPath: string | null = null;
                let dimensions: { width?: number; height?: number } = {};
                try {
                    thumbnailPath = await generateThumbnail(localFilePath, storedName, mimeType);
                    dimensions = await getImageDimensions(localFilePath, mimeType);
                } catch (thumbErr) { }

                const provider = storageManager.getProvider();
                let finalPath = localFilePath;
                let sourceRef = provider.name;

                try {
                    finalPath = await provider.saveFile(localFilePath, storedName, mimeType, storageFolder);
                    if (fs.existsSync(localFilePath)) {
                        fs.unlinkSync(localFilePath);
                    }
                    lastLocalPath = undefined;
                    localFilePath = undefined;
                } catch (err) {
                    lastError = (err as Error).message;
                    throw err;
                }

                await query(`
                    INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                `, [finalFileName, storedName, fileType, mimeType, actualSize, finalPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, storageFolder, activeAccountId]);

                updateUploadPhase(chatIdStr, uploadId, { phase: 'success', size: actualSize, providerName: provider.name, fileType, folder: storageFolder });

                if (useConsolidated()) {
                    await runStatusAction(chatId, async () => {
                        await refreshConsolidatedMessage(client, chatId);
                    });
                } else if (statusMsg && !silentSessionMap.has(chatIdStr)) {
                    await runStatusAction(chatId, async () => {
                        await client.editMessage(chatId, {
                            message: statusMsg!.id,
                            text: buildUploadSuccess(finalFileName, actualSize, fileType, provider.name, storageFolder),
                        });
                    });
                }
                return true;
            } catch (error) {
                lastError = error instanceof Error ? error.message : '未知错误';
                if (localFilePath && fs.existsSync(localFilePath)) {
                    try { fs.unlinkSync(localFilePath); } catch (e) { }
                }
                lastLocalPath = undefined;
                return false;
            }
        };

        const singleUploadTask = async (signal: AbortSignal) => {
            let success = await attemptSingleUpload(signal);
            if (!success && !signal.aborted && retryCount < maxRetries) {
                retryCount++;
                if (lastLocalPath && fs.existsSync(lastLocalPath)) {
                    try { fs.unlinkSync(lastLocalPath); } catch (e) { }
                }
                lastLocalPath = undefined;

                updateUploadPhase(chatIdStr, uploadId, { phase: 'retrying' });
                if (useConsolidated()) {
                    await runStatusAction(chatId, async () => {
                        await refreshConsolidatedMessage(client, chatId);
                    });
                } else if (statusMsg && !silentSessionMap.has(chatIdStr)) {
                    await runStatusAction(chatId, async () => {
                        await client.editMessage(chatId, {
                            message: statusMsg!.id,
                            text: buildRetryMessage(finalFileName, typeEmoji),
                        });
                    });
                }
                success = await attemptSingleUpload(signal);
            }

            if (signal.aborted) {
                lastError = '用户强制停止下载任务';
                updateUploadPhase(chatIdStr, uploadId, { phase: 'failed', error: lastError });
                if (statusMsg && !silentSessionMap.has(chatIdStr)) {
                    await runStatusAction(chatId, async () => {
                        await client.editMessage(chatId, {
                            message: statusMsg!.id,
                            text: buildUploadFail(finalFileName, lastError!)
                        }).catch(() => { });
                    });
                }
            } else if (!success) {
                if (silentSessionMap.has(chatIdStr)) {
                    const sess = getSilentSession(chatIdStr);
                    sess.completed += 1;
                    sess.failed += 1;
                    await finalizeSilentSessionIfDone(client, chatId);
                }
                updateUploadPhase(chatIdStr, uploadId, { phase: 'failed', error: lastError || '未知错误' });
                if (useConsolidated()) {
                    await runStatusAction(chatId, async () => {
                        await refreshConsolidatedMessage(client, chatId);
                    });
                } else if (statusMsg && !silentSessionMap.has(chatIdStr)) {
                    await runStatusAction(chatId, async () => {
                        await client.editMessage(chatId, {
                            message: statusMsg!.id,
                            text: buildUploadFail(finalFileName, lastError || '未知错误')
                        }).catch(() => { });
                    });
                } else {
                    await safeReply(message, {
                        message: buildUploadFail(finalFileName, lastError || '未知错误')
                    });
                }
            } else {
                if (silentSessionMap.has(chatIdStr)) {
                    const sess = getSilentSession(chatIdStr);
                    sess.completed += 1;
                    await finalizeSilentSessionIfDone(client, chatId);
                }
            }

            setTimeout(() => {
                removeUpload(chatIdStr, uploadId);
            }, 8000);
        };

        downloadQueue.add(finalFileName, singleUploadTask).catch(err => {
            console.error(`🤖 单文件下载任务异常: ${finalFileName}`, err);
            removeUpload(chatIdStr, uploadId);
        });
    }
}
