import { TelegramClient, Api } from 'telegram';
import { NewMessageEvent } from 'telegram/events/index.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bigInt from 'big-integer';
import { query, pool } from '../db/index.js';
import { generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';
import { storageManager, StorageQuotaCooldownError, isStorageQuotaCooldownError, type StorageTargetSnapshot } from './storage.js';
import { TaskAbortRegistry } from './taskAbortRegistry.js';
import { assertStorageTargetWritable, formatStorageCooldownNotice } from './storageCooldownGuard.js';
import { markStorageAccountCooldown } from './storageCooldown.js';
import { getTelegramUserClient, isTelegramUserClientReady } from './telegramUserClient.js';
import { getSetting } from '../utils/settings.js';
import { isAuthenticatedAsync } from './telegramState.js';
import { formatBytes, getTypeEmoji, getFileType, sanitizeFilename } from '../utils/telegramUtils.js';
import { extractFileInfo, getDownloadableMedia, getEstimatedFileSize, isTelegramPhotoMedia, type TelegramFileInfo } from '../utils/telegramMedia.js';
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
    buildSilentProgress,
    buildTaskControlButtons,
    buildBatchStatus,
    buildConsolidatedStatus,
    type BatchFile,
    type ConsolidatedUploadFile,
    type ConsolidatedBatchEntry,
} from '../utils/telegramMessages.js';
import { getUniqueStoredName } from '../utils/fileUtils.js';
import { buildStorageFolderWithRules, getStoragePathRules, getTelegramBatchFolderName, getTelegramChatName, isOpaqueTelegramIdentifier } from '../utils/storagePath.js';
import { resolveTelegramGeneratedFileName } from '../utils/telegramNaming.js';
import { annotateTelegramMediaGroup, createTelegramMediaGroupDebouncer, getForwardedSourceLookup, prefetchForwardedSourceMessages, takePendingMediaGroupSnapshot, telegramMediaGroupQueueKey, type ForwardedSourceMessageCache } from '../utils/telegramMediaGroup.js';
import { resolveTelegramStorageFolder, resolveTelegramBatchStorageFolder, resolveTelegramTaskStorageFolder, previewTelegramStorageFolder } from '../utils/telegramPathSettings.js';
import { findDuplicateFile, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { DownloadTaskQueue } from './downloadTaskQueue.js';
import { saveAndIndexWithCompensation, compensateIndexedWriteAfterCancel } from './storageWrite.js';
import { withStorageAccountOperationLease } from './storageAccountOperation.js';
import {
    beginTelegramWriteReconciliation,
    markTelegramWriteIndexPresent,
    markTelegramWriteObjectPresent,
    updateTelegramWriteAfterCompensation,
} from './telegramWriteReconciliation.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const DEFAULT_TELEGRAM_DOWNLOAD_WORKERS = Math.max(1, Math.min(16, parseInt(process.env.TELEGRAM_DOWNLOAD_WORKERS || '4', 10) || 4));
const TELEGRAM_DOWNLOAD_PART_SIZE = 512 * 1024;
const TG_BATCH_DEFAULT_LIMIT = 50;
const TG_LARGE_TASK_SEGMENT_SIZE = Math.max(10, parseInt(process.env.TG_LARGE_TASK_SEGMENT_SIZE || '50', 10) || 50);
const TG_MIN_FREE_DISK_BYTES = Math.max(1024 * 1024 * 1024, (parseInt(process.env.TG_MIN_FREE_DISK_GB || '8', 10) || 8) * 1024 * 1024 * 1024);
const TG_LARGE_TASK_REFRESH_INTERVAL_MS = Math.max(3000, parseInt(process.env.TG_LARGE_TASK_REFRESH_INTERVAL_MS || '10000', 10) || 10000);
const TG_DISK_WATERMARK_RECHECK_MS = Math.max(5000, parseInt(process.env.TG_DISK_WATERMARK_RECHECK_MS || '30000', 10) || 30000);
const TG_DISK_WATERMARK_MAX_WAIT_MS = Math.max(0, parseInt(process.env.TG_DISK_WATERMARK_MAX_WAIT_MS || '0', 10) || 0);
const TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE = Math.max(1, parseInt(process.env.TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE || '50', 10) || 50);
const MEDIA_GROUP_DEBOUNCE_MS = 200;
const MEDIA_GROUP_MAX_WAIT_MS = 1500;

function normalizeFileDownloadConcurrency(value: unknown): number {
    const parsed = parseInt(String(value ?? process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY ?? '2'), 10);
    return [1, 2, 3, 4].includes(parsed) ? parsed : 2;
}

const TG_DEBUG_LOG_PATH = process.env.TG_STATUS_DEBUG_LOG || path.join(process.cwd(), 'data', 'logs', 'tg_silent_debug.log');
const TG_DEBUG_LOG_MAX_BYTES = Math.max(1024 * 1024, parseInt(process.env.TG_DEBUG_LOG_MAX_MB || '5', 10) * 1024 * 1024);
function appendTelegramDebugLog(line: string) {
    if (process.env.TG_STATUS_DEBUG !== '1') return;
    try {
        fs.mkdirSync(path.dirname(TG_DEBUG_LOG_PATH), { recursive: true });
        if (fs.existsSync(TG_DEBUG_LOG_PATH) && fs.statSync(TG_DEBUG_LOG_PATH).size > TG_DEBUG_LOG_MAX_BYTES) {
            fs.renameSync(TG_DEBUG_LOG_PATH, `${TG_DEBUG_LOG_PATH}.${Date.now()}.old`);
        }
        fs.appendFileSync(TG_DEBUG_LOG_PATH, line);
    } catch { }
}


export interface TelegramDownloadMessageRef {
    id: number;
    itemId?: string;
    source?: Api.TypeEntityLike | string;
    origin?: 'channel' | 'comment';
    channelPostId?: number;
    fileInfo?: TelegramFileInfo;
    totalSize?: number;
    message?: Api.Message;
    groupedId?: string;
    sharedCaption?: string | null;
    groupIndex?: number;
    groupSize?: number;
    leaseToken?: string;
    writeOperationId?: string;
    jobId?: string;
}

export interface TelegramPersistedWrite {
    savedPath: string;
    fileId: string;
}

export async function runLeaseProtectedTelegramSave<T extends TelegramPersistedWrite>(
    withLease: (operation: () => Promise<T>) => Promise<T>,
    save: () => Promise<T>,
    compensate: (persisted: T) => Promise<{ status: 'compensated' | 'reconciliation-required'; error?: string }>,
    validateBeforeSettlement: () => Promise<void> = async () => undefined,
): Promise<T> {
    let persisted: T | undefined;
    try {
        return await withLease(async () => {
            persisted = await save();
            await validateBeforeSettlement();
            return persisted;
        });
    } catch (error) {
        if (persisted) {
            const compensation = await compensate(persisted);
            if (compensation.status !== 'compensated') {
                throw new Error(`Telegram lease 丢失后需要人工对账: ${compensation.error || '补偿失败'}`, { cause: error });
            }
        }
        throw error;
    }
}

interface DownloadableMessageRef {
    id: number;
    sourceKey: string;
    sourceEntity: Api.TypeEntityLike | string;
    persistentRef: TelegramDownloadMessageRef;
    origin: 'channel' | 'comment';
    channelPostId?: number;
    fileInfo: TelegramFileInfo;
    totalSize: number;
    message?: Api.Message;
    groupedId?: string;
    sharedCaption?: string | null;
    groupIndex?: number;
    groupSize?: number;
}

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

async function resolveDownloadSource(botClient: TelegramClient, message: Api.Message, forwardedSourceCache?: ForwardedSourceMessageCache): Promise<{ client: TelegramClient; message: Api.Message }> {
    const activeUserClient = getTelegramUserClient();
    if (activeUserClient && botClient === activeUserClient) {
        return { client: botClient, message };
    }

    const userDownloadEnabled = (await getSetting('telegram_user_download_enabled', 'false')) === 'true';
    if (!userDownloadEnabled) {
        return { client: botClient, message };
    }

    const userClient = getTelegramUserClient();
    if (!userClient || !isTelegramUserClientReady()) {
        throw new Error('Telegram 用户账号下载已开启，但 user session 未就绪');
    }

    const cachedForwardedSourceMessage = getForwardedSourceLookup(forwardedSourceCache, message);
    if (cachedForwardedSourceMessage) {
        console.log(`🤖 使用批量预取的转发来源媒体: msg=${cachedForwardedSourceMessage.id}`);
        return { client: userClient, message: cachedForwardedSourceMessage };
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

function getMessageCaptionFirstLine(message: Api.Message): string {
    return String((message as any).message || (message as any).text || (message as any).caption || '')
        .split(/\r?\n/)[0]
        .trim();
}

function rebuildGeneratedTelegramDisplayName(
    message: Api.Message,
    currentFileName: string,
    mimeType: string,
    sharedCaption?: string | null,
    sequenceNumber?: number,
): string {
    return resolveTelegramGeneratedFileName({
        currentFileName,
        mimeType,
        caption: getMessageCaptionFirstLine(message),
        sharedCaption,
        messageId: message.id,
        sequenceNumber,
    });
}

async function getCanonicalTelegramFileName(
    message: Api.Message,
    currentFileName: string,
    mimeType: string,
    sharedCaption?: string | null,
    sequenceNumber?: number,
    generatedName = true,
): Promise<string> {
    if (!generatedName) return currentFileName;
    return rebuildGeneratedTelegramDisplayName(message, currentFileName, mimeType, sharedCaption, sequenceNumber);
}

async function getDiskWatermarkState(requiredBytes = 0): Promise<{ availableBytes: number; ok: boolean }> {
    const statfs = await fs.promises.statfs(UPLOAD_DIR);
    const availableBytes = Number(statfs.bavail) * Number(statfs.bsize);
    return { availableBytes, ok: availableBytes - requiredBytes >= TG_MIN_FREE_DISK_BYTES };
}

async function ensureDiskWatermark(requiredBytes = 0): Promise<void> {
    const { availableBytes, ok } = await getDiskWatermarkState(requiredBytes);
    if (!ok) {
        throw new Error(`磁盘空间不足，已触发保护：可用 ${formatBytes(availableBytes)}，预计还需 ${formatBytes(requiredBytes)}，需保留 ${formatBytes(TG_MIN_FREE_DISK_BYTES)}`);
    }
}

async function waitForDiskWatermark(requiredBytes = 0, signal?: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const blockerId = crypto.randomUUID();
    let announcedPause = false;

    try {
        while (true) {
            if (signal?.aborted) throw new Error('下载任务已停止');
            const { availableBytes, ok } = await getDiskWatermarkState(requiredBytes);
            if (ok) {
                if (announcedPause) {
                    const stats = downloadQueue.releaseDiskPressureBlocker(blockerId);
                    console.log(`[Queue] 💧 磁盘水位恢复，继续下载队列: active=${stats.active}, pending=${stats.pending}`);
                }
                return;
            }

            if (!announcedPause) {
                const stats = downloadQueue.acquireDiskPressureBlocker(
                    blockerId,
                    `磁盘空间不足：可用 ${formatBytes(availableBytes)}，当前文件预计还需 ${formatBytes(requiredBytes)}，系统需保留 ${formatBytes(TG_MIN_FREE_DISK_BYTES)}`,
                    TG_DISK_WATERMARK_RECHECK_MS,
                );
                console.warn(`[Queue] 💧 磁盘空间不足，已暂停下载队列: active=${stats.active}, pending=${stats.pending}, available=${formatBytes(availableBytes)}, required=${formatBytes(requiredBytes)}, reserve=${formatBytes(TG_MIN_FREE_DISK_BYTES)}`);
                announcedPause = true;
            }

            if (TG_DISK_WATERMARK_MAX_WAIT_MS > 0 && Date.now() - startedAt >= TG_DISK_WATERMARK_MAX_WAIT_MS) {
                throw new Error(`磁盘空间不足，已暂停下载队列后等待超时：可用 ${formatBytes(availableBytes)}，预计还需 ${formatBytes(requiredBytes)}，需保留 ${formatBytes(TG_MIN_FREE_DISK_BYTES)}`);
            }

            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                }, TG_DISK_WATERMARK_RECHECK_MS);
                const onAbort = () => {
                    clearTimeout(timer);
                    reject(new Error('下载任务已停止'));
                };
                if (signal?.aborted) {
                    onAbort();
                    return;
                }
                signal?.addEventListener('abort', onAbort, { once: true });
            });
        }
    } finally {
        if (announcedPause) {
            const stats = downloadQueue.releaseDiskPressureBlocker(blockerId);
            const exitReason = signal?.aborted ? '等待任务已取消' : '磁盘等待已结束';
            console.log(`[Queue] 💧 ${exitReason}，释放本任务磁盘保护: active=${stats.active}, pending=${stats.pending}`);
        }
    }
}

function shouldRefreshLargeTaskStatus(lastStatusRefresh: number, completed: number, force = false): boolean {
    return force || completed <= 3 || completed % 20 === 0 || Date.now() - lastStatusRefresh >= TG_LARGE_TASK_REFRESH_INTERVAL_MS;
}

/**
 * 安全编辑消息，捕获 FloodWaitError 并更新全局冷却状态
 */
async function safeEditMessage(client: TelegramClient, chatId: Api.TypeEntityLike, params: any) {
    if (Date.now() < floodWaitUntil) {
        console.warn(`[Telegram] ⏳ 跳过编辑消息：仍在 FloodWait 冷却中 chat=${chatId.toString()} msg=${params?.message}`);
        return null;
    }

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
        if (e.errorMessage === 'MESSAGE_NOT_MODIFIED' || e.message?.includes('MESSAGE_NOT_MODIFIED')) {
            if (process.env.TG_STATUS_DEBUG === '1') {
                console.log(`[TG][status] edit-noop chat=${chatId.toString()} msg=${params?.message}`);
            }
            return { notModified: true };
        }
        console.warn(`[Telegram] ⚠️ 编辑消息失败 chat=${chatId.toString()} msg=${params?.message}:`, e?.errorMessage || e?.message || e);
        return null;
    }
}

const telegramStorageWriteLocks = new Map<string, Promise<void>>();

async function withTelegramStorageWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = telegramStorageWriteLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    telegramStorageWriteLocks.set(key, previous.then(() => current, () => current));
    await previous.catch(() => undefined);
    try {
        return await fn();
    } finally {
        release();
        if (telegramStorageWriteLocks.get(key) === current) {
            telegramStorageWriteLocks.delete(key);
        }
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

    const initialCardState = getDownloadTaskCardState(chatIdStr);
    const text = buildSilentModeNotice(
        fileCount,
        getSessionTaskId(chatIdStr),
        initialCardState.paused || initialCardState.pausing,
        initialCardState.reason,
        initialCardState.systemPause,
    );

    const sendPromise = (async () => {
        let sMsg: any;
        if (replyToMsg) {
            sMsg = await safeReply(replyToMsg, {
                message: text,
                buttons: buildTaskControlButtons(
                    getSessionTaskId(chatIdStr),
                    initialCardState.paused,
                    initialCardState.systemPause,
                    initialCardState.pausing,
                    initialCardState.userPaused,
                ),
            });
        }
        if (!sMsg) {
            try {
                sMsg = await client.sendMessage(chatId, {
                    message: text,
                    buttons: buildTaskControlButtons(
                        getSessionTaskId(chatIdStr),
                        initialCardState.paused,
                        initialCardState.systemPause,
                        initialCardState.pausing,
                        initialCardState.userPaused,
                    ),
                });
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

const downloadQueue = new DownloadTaskQueue({
    maxConcurrent: normalizeFileDownloadConcurrency(process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY),
});
const channelTaskAbortRegistry = new TaskAbortRegistry();

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
    taskId: string;
    knownTaskKeys: Set<string>;
    knownTaskCounts: Map<string, number>;
    folders: Set<string>;
    providers: Set<string>;
}

const silentSessionMap = new Map<string, SilentSession>();
interface TaskControlScope {
    chatId: string;
    userId?: number;
}

const taskIdToChatId = new Map<string, string>();
const taskIdControlScopes = new Map<string, TaskControlScope>();

function createSessionTaskId(): string {
    return `t${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
}

function getSessionTaskId(chatIdStr: string): string | undefined {
    return silentSessionMap.get(chatIdStr)?.taskId;
}

function resolveTaskChatId(taskId?: string): string | undefined {
    if (!taskId) return undefined;
    return taskIdToChatId.get(taskId.trim());
}

function registerTaskControlScope(taskId: string, chatId: string, userId?: number): void {
    taskIdToChatId.set(taskId, chatId);
    taskIdControlScopes.set(taskId, { chatId, userId });
}

function removeTaskControlScope(taskId?: string): void {
    if (!taskId) return;
    taskIdToChatId.delete(taskId);
    taskIdControlScopes.delete(taskId);
}

export function canControlTask(taskId: string | undefined, chatId: string | undefined, userId?: number): boolean {
    if (!taskId || !chatId || userId === undefined) return false;
    const scope = taskIdControlScopes.get(taskId.trim());
    if (!scope || scope.userId === undefined) return false;
    if (scope.chatId !== chatId) return false;
    if (scope.userId !== userId) return false;
    return true;
}

function getSilentSession(chatIdStr: string, userId?: number): SilentSession {
    let s = silentSessionMap.get(chatIdStr);
    if (!s) {
        if (userId === undefined) throw new Error('创建静默任务缺少所有者');
        const taskId = createSessionTaskId();
        s = { total: 0, completed: 0, failed: 0, taskId, knownTaskKeys: new Set(), knownTaskCounts: new Map(), folders: new Set(), providers: new Set() };
        silentSessionMap.set(chatIdStr, s);
        registerTaskControlScope(taskId, chatIdStr, userId);
    }
    return s;
}

function startSilentSession(chatIdStr: string, total: number, userId: number): SilentSession {
    const taskId = createSessionTaskId();
    const s = { total, completed: 0, failed: 0, taskId, knownTaskKeys: new Set<string>(), knownTaskCounts: new Map<string, number>(), folders: new Set<string>(), providers: new Set<string>() };
    silentSessionMap.set(chatIdStr, s);
    registerTaskControlScope(taskId, chatIdStr, userId);
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

    // 编辑静默通知为完成消息；如果编辑失败，补发一条完成消息，避免 Telegram 卡在旧进度。
    if (silentMsgId) {
        const text = buildSilentAllTasksComplete(
            s?.total || 0,
            s?.failed || 0,
            s?.taskId,
            getConsolidatedFiles(chatIdStr),
            [
                ...getConsolidatedBatches(chatIdStr),
                ...Array.from(s?.folders || []).map((folder, index) => ({
                    id: `session-folder-${index}`,
                    folderName: folder,
                    folderPath: folder,
                    totalFiles: 1,
                    completed: 1,
                    successful: 1,
                    failed: 0,
                    providerName: Array.from(s?.providers || [])[0],
                })),
            ],
        );
        // GramJS/Telegram rejects ReplyInlineMarkup with an empty rows array (REPLY_MARKUP_INVALID).
        // Omit buttons entirely to clear inline controls on successful completion.
        const controls = s?.failed
            ? (() => {
                const queueStats = getDownloadQueueStats();
                return buildTaskControlButtons(s?.taskId, queueStats.paused, queueStats.systemPause);
            })()
            : undefined;
        const edited = await safeEditMessage(client, chatId, { message: silentMsgId, text, buttons: controls });
        if (!edited) {
            try {
                await client.sendMessage(chatId, { message: text, buttons: controls });
                console.warn(`[TG][silent] completion-edit-failed fallback-sent chat=${chatIdStr} oldMsg=${silentMsgId}`);
            } catch (e) {
                console.error(`[TG][silent] completion-fallback-send-failed chat=${chatIdStr}:`, e);
            }
        }
    }

    // 清理静默状态
    silentSessionMap.delete(chatIdStr);
    removeTaskControlScope(s?.taskId);
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
    appendTelegramDebugLog(logLine)

    return count;
}

/**
 * 集中化静默模式触发逻辑
 * 后台文件数量超过 3 个时进入静默模式
 */
async function trySilentMode(client: TelegramClient, chatId: Api.TypeEntityLike, message?: Api.Message, ownerUserId?: number) {
    const chatIdStr = chatId.toString();
    const fileCount = getBackgroundFileCount(chatIdStr);
    const isSilent = silentSessionMap.has(chatIdStr);

    const logLine = `[TG][silent][${Date.now()}] tryCheck chat=${chatIdStr} fileCount=${fileCount} isSilent=${isSilent}\n`;
    console.log(logLine.trim());
    appendTelegramDebugLog(logLine)

    if (fileCount > 3 || isSilent) {
        if (!isSilent) {
            // 首次进入静默模式
            await deleteLastStatusMessage(client, chatId);
            const transferSession = syncChatTransferSession(chatIdStr);
            if (ownerUserId === undefined) throw new Error('进入静默模式缺少任务所有者');
            const silentSession = startSilentSession(chatIdStr, transferSession.total, ownerUserId);
            silentSession.knownTaskKeys = new Set(transferSession.knownTaskKeys);
            silentSession.knownTaskCounts = new Map(transferSession.knownTaskCounts);
            console.log(`[TG][silent] ACTIVATED chat=${chatIdStr} files=${fileCount}`);
        } else {
            // 已在静默模式，更新已知任务集合，保持总数为会话累计文件数
            syncSilentSessionTotals(chatIdStr);
        }
        await ensureSilentNotice(client, chatId, fileCount, message);
        await refreshSilentProgress(client, chatId);
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
    id?: string;
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

interface ChatTransferSession {
    total: number;
    completed: number;
    failed: number;
    knownTaskKeys: Set<string>;
    knownTaskCounts: Map<string, number>;
    folders: Set<string>;
    providers: Set<string>;
}

const chatTransferSessions = new Map<string, ChatTransferSession>();

function getChatTransferSession(chatId: string): ChatTransferSession {
    let session = chatTransferSessions.get(chatId);
    if (!session) {
        session = { total: 0, completed: 0, failed: 0, knownTaskKeys: new Set(), knownTaskCounts: new Map(), folders: new Set(), providers: new Set() };
        chatTransferSessions.set(chatId, session);
    }
    return session;
}

function rememberTransferDestination(chatId: string, folder?: string | null, providerName?: string) {
    const session = getChatTransferSession(chatId);
    if (folder) session.folders.add(folder);
    if (providerName) session.providers.add(providerName);
    const silentSession = silentSessionMap.get(chatId);
    if (silentSession) {
        if (folder) silentSession.folders.add(folder);
        if (providerName) silentSession.providers.add(providerName);
    }
}

function updateTaskCount(totalTracker: Pick<ChatTransferSession, 'total' | 'knownTaskKeys' | 'knownTaskCounts'>, key: string, count: number) {
    const previousCount = totalTracker.knownTaskCounts.get(key) || 0;
    if (count > previousCount) {
        totalTracker.total += count - previousCount;
        totalTracker.knownTaskCounts.set(key, count);
    }
    totalTracker.knownTaskKeys.add(key);
}

function syncChatTransferSession(chatId: string): ChatTransferSession {
    const session = getChatTransferSession(chatId);

    const batches = getConsolidatedBatches(chatId);
    for (const batch of batches) {
        const key = `batch:${batch.id}`;
        updateTaskCount(session, key, batch.totalFiles);
    }

    const files = getConsolidatedFiles(chatId);
    for (const file of files) {
        const key = `file:${file.id || file.fileName}`;
        updateTaskCount(session, key, 1);
    }

    const completedBatches = batches.reduce((sum, batch) => sum + batch.completed, 0);
    const failedBatches = batches.reduce((sum, batch) => sum + batch.failed, 0);
    const completedFiles = files.filter(file => file.phase === 'success' || file.phase === 'failed').length;
    const failedFiles = files.filter(file => file.phase === 'failed').length;
    for (const batch of batches) {
        if (batch.folderPath) session.folders.add(batch.folderPath);
        if (batch.providerName) session.providers.add(batch.providerName);
    }
    for (const file of files) {
        if (file.folder) session.folders.add(file.folder);
        if (file.providerName) session.providers.add(file.providerName);
    }
    session.completed = Math.max(session.completed, completedBatches + completedFiles);
    session.failed = Math.max(session.failed, failedBatches + failedFiles);

    return session;
}

function resetChatTransferSession(chatId: string) {
    chatTransferSessions.delete(chatId);
}

// 每个 chat 的当前活跃单文件上传列表
const chatActiveUploads = new Map<string, Map<string, ActiveUploadEntry>>();

function registerUpload(chatId: string, uploadId: string, entry: ActiveUploadEntry) {
    if (!chatActiveUploads.has(chatId)) {
        chatActiveUploads.set(chatId, new Map());
    }
    chatActiveUploads.get(chatId)!.set(uploadId, { ...entry, id: uploadId });
    syncChatTransferSession(chatId);
}

function updateUploadPhase(chatId: string, uploadId: string, updates: Partial<ActiveUploadEntry>) {
    const map = chatActiveUploads.get(chatId);
    if (!map) return;
    const entry = map.get(uploadId);
    if (entry) {
        Object.assign(entry, updates);
        syncChatTransferSession(chatId);
    }
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
    syncChatTransferSession(chatId);
}

function updateBatch(chatId: string, batchId: string, updates: Partial<ConsolidatedBatchEntry>) {
    const map = chatActiveBatches.get(chatId);
    if (!map) return;
    const entry = map.get(batchId);
    if (entry) {
        Object.assign(entry, updates);
        syncChatTransferSession(chatId);
    }
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

function syncSilentSessionTotals(chatIdStr: string): SilentSession | null {
    const session = silentSessionMap.get(chatIdStr);
    if (!session) return null;

    const transferSession = syncChatTransferSession(chatIdStr);
    for (const key of transferSession.knownTaskKeys) {
        session.knownTaskKeys.add(key);
    }
    for (const [key, count] of transferSession.knownTaskCounts) {
        updateTaskCount(session, key, count);
    }
    for (const folder of transferSession.folders) {
        session.folders.add(folder);
    }
    for (const provider of transferSession.providers) {
        session.providers.add(provider);
    }
    session.total = Math.max(session.total, transferSession.total);
    session.completed = Math.max(session.completed, transferSession.completed);
    session.failed = Math.max(session.failed, transferSession.failed);

    return session;
}

export async function refreshSilentProgress(client: TelegramClient, chatId: Api.TypeEntityLike, userId?: number, pauseHint?: { paused: boolean; pausing: boolean; reason?: string }) {
    const chatIdStr = chatId.toString();
    if (!silentSessionMap.has(chatIdStr)) return;
    const silentMsgId = silentNoticeMessageIdMap.get(chatIdStr);
    if (!silentMsgId) return;

    const session = syncSilentSessionTotals(chatIdStr) || getSilentSession(chatIdStr);
    const batches = getConsolidatedBatches(chatIdStr);
    const files = getConsolidatedFiles(chatIdStr);
    const totalBatchFiles = batches.reduce((sum, batch) => sum + batch.totalFiles, 0);
    const completedBatchFiles = batches.reduce((sum, batch) => sum + batch.completed, 0);
    const completedSingleFiles = files.filter(file => file.phase === 'success' || file.phase === 'failed').length;
    const totalFiles = Math.max(session.total, totalBatchFiles + files.length, completedBatchFiles + completedSingleFiles, session.completed);
    const completedFiles = Math.max(session.completed, completedBatchFiles + completedSingleFiles);
    const isComplete = totalFiles > 0 && completedFiles >= totalFiles;
    const cardState = getDownloadTaskCardState(chatIdStr, userId);
    const cardPaused = cardState.paused || Boolean(pauseHint?.paused);
    const cardPausing = !cardPaused && (cardState.pausing || Boolean(pauseHint?.pausing));
    const cardPauseReason = cardState.reason || pauseHint?.reason;
    const cardSystemPause = cardState.systemPause;
    const cardUserPaused = cardState.userPaused || Boolean(pauseHint?.paused) || Boolean(pauseHint?.pausing);
    const text = buildSilentProgress(
        session.total,
        batches,
        files,
        session.completed,
        session.failed,
        session.taskId,
        cardPaused,
        cardPauseReason,
        cardPausing,
        cardSystemPause,
    );
    const controls = isComplete && session.failed === 0
        ? undefined
        : buildTaskControlButtons(session.taskId, cardPaused, cardSystemPause, cardPausing, cardUserPaused);
    const buttons = controls;
    await safeEditMessage(client, chatId, { message: silentMsgId, text, buttons });
}



/** Check if this is a start of a new session and cleanup old statuses */
async function checkAndResetSession(client: TelegramClient, chatId: Api.TypeEntityLike) {
    const chatIdStr = chatId.toString();

    // 增强：如果当前没有任何正在进行的任务，但却残留了静默模式标志，强制清理它
    // 这能解决因重启或异常导致的“僵尸”静默会话问题
    const outstanding = getOutstandingTaskCount(chatIdStr);
    if (outstanding === 0 && silentSessionMap.has(chatIdStr)) {
        const zombieTaskId = getSessionTaskId(chatIdStr);
        silentSessionMap.delete(chatIdStr);
        removeTaskControlScope(zombieTaskId);
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
        resetChatTransferSession(chatIdStr);
    }
}

/** 更新合并状态消息 */
async function refreshConsolidatedMessage(client: TelegramClient, chatId: Api.TypeEntityLike, replyTo?: Api.Message) {
    const chatIdStr = chatId.toString();

    // 集中判断：如果文件数超过 3 或已在静默模式，直接触发 trySilentMode 并返回
    const alreadySilent = silentSessionMap.has(chatIdStr);
    const fileCount = getBackgroundFileCount(chatIdStr);

    const logLine = `[TG][consolidated][${Date.now()}] check chat=${chatIdStr} silent=${alreadySilent} fileCount=${fileCount} replyTo=${!!replyTo}\n`;
    appendTelegramDebugLog(logLine)

    if (alreadySilent || fileCount > 3) {
        await trySilentMode(client, chatId, replyTo, replyTo?.senderId?.toJSNumber());
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

export function getFileDownloadConcurrency(): number {
    return downloadQueue.getMaxConcurrent();
}

export function setFileDownloadConcurrency(value: number): number {
    const normalized = downloadQueue.setMaxConcurrent(value);
    process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY = String(normalized);
    return normalized;
}

export async function loadFileDownloadConcurrencySetting(): Promise<number> {
    const value = await getSetting('telegram_file_download_concurrency', process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY || '2');
    return setFileDownloadConcurrency(normalizeFileDownloadConcurrency(value));
}

export function getTaskStatus() {
    return downloadQueue.getDetailedStatus();
}

export function listDownloadTaskGroups(chatId?: string, userId?: number) {
    return downloadQueue.getSnapshot({ chatId, userId }).groups;
}

export function getDownloadTaskScopeStatus(chatId: string, userId?: number) {
    return downloadQueue.getScopeStatus({ chatId, userId });
}

export function mergeTaskCardPauseState(
    queuePaused: boolean,
    queueReason: string | undefined,
    scopeStatus: { paused: boolean; pausing: boolean; userPaused: boolean; reason?: string; systemPause?: { kind: 'disk_pressure'; reason: string; autoResume: true; recheckMs?: number } },
    queueSystemPause?: { kind: 'disk_pressure'; reason: string; autoResume: true; recheckMs?: number },
    queueUserPaused = false,
) {
    const paused = queuePaused || scopeStatus.paused;
    const sourceSystemPause = queueSystemPause || scopeStatus.systemPause;
    const systemPause = sourceSystemPause ? { ...sourceSystemPause } : undefined;
    const reason = queueReason || scopeStatus.reason;
    if (systemPause && queueReason) systemPause.reason = queueReason;
    return {
        paused,
        pausing: !paused && scopeStatus.pausing,
        reason,
        systemPause,
        userPaused: scopeStatus.userPaused || (queuePaused && queueUserPaused),
    };
}

export function getDownloadTaskCardState(chatId: string, userId?: number) {
    const queueStats = downloadQueue.getStats();
    const scopeStatus = downloadQueue.getScopeStatus({ chatId, userId });
    return mergeTaskCardPauseState(queueStats.paused, queueStats.pauseReason, scopeStatus, queueStats.systemPause, queueStats.userPaused);
}

export function getDownloadTaskGroup(groupId: string, chatId?: string, userId?: number) {
    return downloadQueue.getGroup(groupId, { chatId, userId });
}

export function prioritizeDownloadTaskGroup(groupId: string, chatId: string, userId: number) {
    return downloadQueue.prioritizeGroup(groupId, { chatId, userId });
}

export function pauseDownloadTaskGroup(groupId: string, chatId: string, userId: number) {
    return downloadQueue.pauseGroup(groupId, { chatId, userId });
}

export function resumeDownloadTaskGroup(groupId: string, chatId: string, userId: number) {
    return downloadQueue.resumeGroup(groupId, { chatId, userId });
}

export function cancelDownloadTaskGroup(groupId: string, chatId: string, userId: number) {
    return downloadQueue.cancelGroup(groupId, { chatId, userId }, '用户通过任务中心取消任务');
}

function ordinaryGroupId(prefix: 's' | 'a', chatId: string, identity: string): string {
    return `${prefix}${crypto.createHash('sha256').update(`${chatId}:${identity}`).digest('base64url').slice(0, 22)}`;
}

function channelExecutionGroupId(key: string): string {
    return `j${crypto.createHash('sha256').update(key).digest('base64url').slice(0, 22)}`;
}

export function getChannelExecutionGroup(jobId: string) {
    return downloadQueue.getGroup(channelExecutionGroupId(jobId), {}, true);
}

export function prioritizeChannelExecutionGroup(jobId: string) {
    return downloadQueue.prioritizeGroup(channelExecutionGroupId(jobId), {});
}

export function pauseChannelExecutionGroup(jobId: string) {
    return downloadQueue.pauseGroup(channelExecutionGroupId(jobId), {}, true);
}

export function resumeChannelExecutionGroup(jobId: string) {
    return downloadQueue.resumeGroup(channelExecutionGroupId(jobId), {}, true);
}

export function getChannelTaskAbortSignal(jobId: string): AbortSignal {
    return channelTaskAbortRegistry.acquire(jobId).signal;
}

export function releaseChannelTaskAbortSignal(jobId: string, signal: AbortSignal): void {
    const controller = channelTaskAbortRegistry.get(jobId);
    if (controller?.signal === signal) channelTaskAbortRegistry.release(jobId, controller);
}

export function abortChannelExecutionForLeaseLoss(jobId: string): void {
    channelTaskAbortRegistry.cancel(jobId, 'Telegram 下载 lease 已丢失');
    downloadQueue.cancelGroup(channelExecutionGroupId(jobId), {}, 'Telegram 下载 lease 已丢失', true);
}

export function cancelChannelExecutionGroup(jobId: string) {
    channelTaskAbortRegistry.cancel(jobId, '用户取消频道任务');
    return downloadQueue.cancelGroup(channelExecutionGroupId(jobId), {}, '用户取消频道任务', true);
}

export function resolveTaskChatIdForControl(taskId?: string): string | undefined {
    return resolveTaskChatId(taskId);
}

export function forceStopDownloadTasksForScope(chatId: string, userId: number, reason?: string) {
    return downloadQueue.cancelScope({ chatId, userId }, reason);
}

export function forceStopDownloadTasks(reason?: string) {
    return downloadQueue.forceStopAll(reason);
}

export function pauseDownloadTasks(taskId?: string, chatId?: string, userId?: number) {
    if (taskId) {
        const scope = taskIdControlScopes.get(taskId.trim());
        if (!scope) return { active: 0, pending: 0, total: 0 };
        return downloadQueue.pauseScope(scope);
    }
    if (!chatId || userId === undefined) return { active: 0, pending: 0, total: 0 };
    return downloadQueue.pauseScope({ chatId, userId });
}

export function resumeDownloadTasks(taskId?: string, chatId?: string, userId?: number) {
    if (taskId) {
        const scope = taskIdControlScopes.get(taskId.trim());
        if (!scope) return { active: 0, pending: 0, total: 0 };
        return downloadQueue.resumeScope(scope);
    }
    if (!chatId || userId === undefined) return { active: 0, pending: 0, total: 0 };
    return downloadQueue.resumeScope({ chatId, userId });
}

export function cancelDownloadTask(selector?: string) {
    const normalized = selector?.trim();
    if (normalized && resolveTaskChatId(normalized)) {
        // Until the queue is fully per-session, refuse to translate a task card into forceStopAll.
        return downloadQueue.cancel('no-such-task-selector', `用户通过 /task_cancel ${normalized} 取消任务`);
    }
    return downloadQueue.cancel(normalized, '用户通过 /task_cancel 取消任务');
}

export async function cancelSilentTask(client: TelegramClient, chatId: Api.TypeEntityLike, taskId: string, fallbackMessageId?: number, userId?: number) {
    const mappedChatId = resolveTaskChatId(taskId);
    const chatIdStr = mappedChatId || chatId.toString();
    const editChatId = mappedChatId || chatId;
    if (!canControlTask(taskId, chatIdStr, userId)) {
        throw new Error('任务不属于当前聊天或已失效');
    }
    const session = silentSessionMap.get(chatIdStr);
    const silentMsgId = silentNoticeMessageIdMap.get(chatIdStr) || fallbackMessageId;
    const scope = taskIdControlScopes.get(taskId.trim());
    if (!scope) throw new Error('任务控制作用域已失效');
    const result = downloadQueue.cancelScope(scope, '用户通过静默任务卡取消当前下载任务');
    const total = Math.max(session?.total || 0, result.total);
    const completed = session?.completed || 0;
    const failed = session?.failed || 0;
    const pendingOrActive = Math.max(0, total - completed);

    if (silentMsgId) {
        const text = [
            `🛑 **后台任务已取消**`,
            ``,
            `🆔 任务：\`${taskId}\``,
            `✅ 已完成: ${completed} 个文件`,
            ...(failed > 0 ? [`❌ 失败: ${failed} 个文件`] : []),
            `🚫 已停止/清空: ${pendingOrActive} 个等待或进行中的任务`,
            ``,
            `已移除暂停 / 继续 / 取消按钮，此任务不会再响应旧按钮操作。`,
        ].join('\n');
        await safeEditMessage(client, editChatId, { message: silentMsgId, text, buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
    }

    silentSessionMap.delete(chatIdStr);
    removeTaskControlScope(session?.taskId);
    removeTaskControlScope(taskId);
    silentNoticeMessageIdMap.delete(chatIdStr);
    lastSilentNotificationTimeMap.delete(chatIdStr);
    clearConsolidatedState(chatIdStr);
    resetChatTransferSession(chatIdStr);

    return result;
}

export function retryFailedDownloadTasks(limit = 10, taskId?: string, chatId?: string, userId?: number) {
    return downloadQueue.retryFailed(limit, { chatId, userId }, taskId);
}

// 多文件上传队列管理
interface FileUploadItem {
    fileName: string;
    mimeType: string;
    generatedName?: boolean;
    message: Api.Message;
    status: 'pending' | 'queued' | 'uploading' | 'success' | 'failed';
    size?: number;
    fileType?: string;
    error?: string;
    storageCooldownUntil?: Date;
    retried?: boolean;           // 是否已重试过
    targetDir?: string;          // 批量上传时文件的目标目录
    folderOverride?: string | null; // 任务级保存目录覆盖，不影响全局路径规则
    sharedCaption?: string | null;
    groupIndex?: number;
    groupSize?: number;
    forwardedSourceCache?: ForwardedSourceMessageCache;
    storageTarget?: StorageTargetSnapshot;
    leaseSettled?: boolean;
    withLease?: <T>(operation: () => Promise<T>) => Promise<T>;
    persistentRef?: TelegramDownloadMessageRef;
}

interface MediaGroupQueue {
    mediaGroupId: string;
    queueKey: string;
    chatId: Api.TypeEntityLike | undefined;
    userId?: number;
    client?: TelegramClient;
    statusMsgId?: number;
    files: FileUploadItem[];
    processingStarted: boolean;
    createdAt: number;
    lastAddedAt: number;
    folderName?: string;  // 多文件上传的文件夹名称（来自消息 caption）
    folderPath?: string;  // 实际创建的文件夹路径
    storageFolder?: string | null; // 批量任务整批共用的第三方存储目录
    storageTarget: StorageTargetSnapshot;
}

// 多文件上传队列 (key: mediaGroupId)
const mediaGroupQueues = new Map<string, MediaGroupQueue>();

// 多文件上传动态 debounce：每收到同组新消息后重置短等待窗口，同时设置最大等待兜底，避免已收齐相册还固定等 1.5s。
const mediaGroupDebouncer = createTelegramMediaGroupDebouncer({
    delayMs: MEDIA_GROUP_DEBOUNCE_MS,
    onReady: (mediaGroupId) => processBatchUpload(undefined, mediaGroupId),
});


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
        await waitForDiskWatermark(totalSize || 0, signal);
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
                progressCallback: onProgress
                    ? (((downloaded: any, total: any) => onProgress(Number(downloaded), Number(total))) as any)
                    : undefined,
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
        folderPath: queue.folderPath,
        providerName: provider.name,
        queuePending: stats.pending,
        queueActive: stats.active,
    });
}

export async function waitForChannelExecutionPermission(
    getExecutionControlState: (() => Promise<'run' | 'paused' | 'cooldown' | 'cancelled'>) | undefined,
    signal: AbortSignal,
    options: { allowUserPauseForActiveWorker?: boolean } = {},
): Promise<'run' | 'cancelled'> {
    if (!getExecutionControlState) return 'run';
    while (true) {
        if (signal.aborted) return 'cancelled';
        const state = await getExecutionControlState();
        if (state === 'run') return 'run';
        if (state === 'paused' && options.allowUserPauseForActiveWorker) return 'run';
        if (state === 'cancelled') return 'cancelled';
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, state === 'cooldown' ? 5000 : 1000);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new Error('下载任务已停止'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }).catch(() => undefined);
    }
}

export async function waitForStorageCooldownRetry(
    initialRetryAt: Date,
    signal: AbortSignal,
    retry: () => Promise<Date | undefined>,
    onWaiting?: (retryAt: Date) => Promise<void> | void,
    now: () => number = Date.now,
): Promise<'success' | 'cancelled'> {
    let retryAt: Date | undefined = initialRetryAt;
    while (retryAt && !signal.aborted) {
        await onWaiting?.(retryAt);
        while (!signal.aborted && now() < retryAt.getTime()) {
            await new Promise<void>(resolve => {
                const onAbort = () => {
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(() => {
                    signal.removeEventListener('abort', onAbort);
                    resolve();
                }, Math.min(30_000, Math.max(1000, retryAt!.getTime() - now())));
                signal.addEventListener('abort', onAbort, { once: true });
            });
        }
        if (signal.aborted) return 'cancelled';
        retryAt = await retry();
    }
    return signal.aborted ? 'cancelled' : 'success';
}

// 处理单个文件上传（带重试机制）
async function processFileUpload(
    client: TelegramClient,
    file: FileUploadItem,
    queue?: MediaGroupQueue,
    groupId?: string,
    getExecutionControlState?: () => Promise<'run' | 'paused' | 'cooldown' | 'cancelled'>,
): Promise<void> {
    file.status = 'queued';

    const attemptUpload = async (signal?: AbortSignal, reportProgress?: (downloaded: number, total: number) => void): Promise<boolean> => {
        let localFilePath: string | undefined;
        let storedName: string | undefined; // This will hold the unique name for final storage

        try {
            const storageTarget = file.storageTarget || queue?.storageTarget || storageManager.getActiveTarget();
            file.storageTarget = storageTarget;
            const { provider, accountId: activeAccountId } = storageTarget;
            await assertStorageTargetWritable(storageTarget);
            const chatName = await getTelegramChatName(file.message);
            file.fileName = await getCanonicalTelegramFileName(file.message, file.fileName, file.mimeType, file.sharedCaption, file.groupIndex, file.generatedName !== false);
            if (queue?.chatId) {
                const batchId = (file.message as any).groupedId?.toString();
                if (batchId) updateBatch(queue.chatId.toString(), batchId, { currentFileName: file.fileName, currentFileActive: true });
            }
            const batchFolder = null;
            const storageRules = await getStoragePathRules();
            const automaticFolder = buildStorageFolderWithRules({
                source: 'telegram',
                chatName,
                folder: batchFolder,
                mimeType: file.mimeType,
                fileName: file.fileName,
            }, storageRules);
            const chatIdForPath = queue?.chatId?.toString() || file.message.chatId?.toString() || 'unknown';
            const storageFolder = file.folderOverride !== undefined
                ? file.folderOverride
                : queue?.storageFolder !== undefined
                    ? queue.storageFolder
                    : resolveTelegramStorageFolder(chatIdForPath, automaticFolder);

            const downloadSource = await resolveDownloadSource(client, file.message, file.forwardedSourceCache);
            const result = await downloadAndSaveFile(downloadSource.client, downloadSource.message, file.fileName, file.targetDir, reportProgress, signal);
            if (!result) {
                file.error = '下载失败';
                return false;
            }

            localFilePath = result.filePath;
            const actualSize = result.actualSize;
            const fileType = getFileType(file.mimeType);
            const duplicateMode = await getDuplicateMode();
            if (duplicateMode === 'skip') {
                const duplicate = await findDuplicateFile(file.fileName, storageFolder, actualSize, activeAccountId);
                if (duplicate) {
                    file.status = 'success';
                    file.size = actualSize;
                    file.fileType = fileType;
                    if (queue?.chatId) {
                        const chatIdStr = queue.chatId.toString();
                        const batchId = (file.message as any).groupedId?.toString();
                        if (batchId) updateBatch(chatIdStr, batchId, { folderPath: storageFolder || undefined, providerName: storageManager.getProvider().name });
                        rememberTransferDestination(chatIdStr, storageFolder, storageManager.getProvider().name);
                    }
                    if (localFilePath && fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
                    return true;
                }
            }

            if (signal?.aborted) throw new Error('下载任务已停止');
            const storageLockKey = `${provider.name}:${activeAccountId || 'local'}:${storageFolder || ''}`;
            return await withTelegramStorageWriteLock(storageLockKey, async () => {
                if (signal?.aborted) throw new Error('下载任务已停止');
                storedName = await getUniqueStoredName(file.fileName, storageFolder, activeAccountId);

                // 生成缩略图和获取尺寸。方案A：只在本地存储生成；第三方存储不生成本地缩略图。
                let thumbnailPath: string | null = null;
                let dimensions: { width?: number; height?: number } = {};
                if (provider.name === 'local' && (file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/'))) {
                    try {
                        thumbnailPath = await generateThumbnail(localFilePath!, storedName, file.mimeType);
                        dimensions = await getImageDimensions(localFilePath!, file.mimeType);
                    } catch (thumbErr) {
                        console.warn('🤖 生成缩略图/获取尺寸失败，继续上传:', thumbErr);
                    }
                }

                let finalPath = localFilePath!;
                let indexedFileId: string | null = null;
                let sourceRef = provider.name;

                const permissionBeforeStore = await waitForChannelExecutionPermission(
                    getExecutionControlState,
                    signal || new AbortController().signal,
                    { allowUserPauseForActiveWorker: true },
                );
                if (permissionBeforeStore === 'cancelled' || signal?.aborted) throw new Error('下载任务已停止');
                const save = async (): Promise<TelegramPersistedWrite> => {
                    const persistentRef = file.persistentRef;
                    let operationId: string | undefined;
                    let savedPath = '';
                    let indexState: 'unknown' | 'present' | 'deleted' = 'unknown';
                    if (persistentRef?.jobId && persistentRef.itemId && persistentRef.leaseToken) {
                        operationId = await beginTelegramWriteReconciliation(pool, {
                            jobId: persistentRef.jobId,
                            itemId: persistentRef.itemId,
                            childLeaseToken: persistentRef.leaseToken,
                            provider: provider.name,
                            accountId: activeAccountId,
                        });
                        persistentRef.writeOperationId = operationId;
                    }
                    try {
                        savedPath = await provider.saveFile(localFilePath!, storedName!, file.mimeType, storageFolder);
                        finalPath = savedPath;
                        if (operationId) await markTelegramWriteObjectPresent(pool, operationId, savedPath);
                        const inserted = await query(`
                            INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                            RETURNING id
                        `, [file.fileName, storedName, fileType, file.mimeType, actualSize, savedPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, storageFolder, activeAccountId]);
                        indexedFileId = String(inserted.rows[0].id);
                        indexState = 'present';
                        if (operationId) await markTelegramWriteIndexPresent(pool, operationId, indexedFileId);
                        return { savedPath: finalPath, fileId: indexedFileId };
                    } catch (error) {
                        if (!operationId) throw error;
                        let objectState: 'unknown' | 'deleted' = savedPath ? 'unknown' : 'unknown';
                        let compensatedIndexState: 'unknown' | 'deleted' = indexState === 'present' ? 'unknown' : 'deleted';
                        const errors: string[] = [];
                        if (savedPath) {
                            try { await provider.deleteFile(savedPath); objectState = 'deleted'; }
                            catch (cleanupError) { errors.push(`object: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
                        }
                        if (indexedFileId) {
                            try {
                                if ((await query('DELETE FROM files WHERE id = $1', [indexedFileId])).rowCount !== 1) throw new Error('索引补偿影响 0 行');
                                compensatedIndexState = 'deleted';
                            } catch (cleanupError) { errors.push(`index: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
                        }
                        await updateTelegramWriteAfterCompensation(pool, operationId, {
                            objectState, indexState: compensatedIndexState,
                            reason: errors.join('; ') || `保存失败且补偿已确认: ${error instanceof Error ? error.message : String(error)}`,
                        });
                        throw error;
                    }
                };
                const leasedSave = () => withStorageAccountOperationLease(pool, activeAccountId, 'telegram_upload', save);
                if (file.withLease) {
                    const persisted = await runLeaseProtectedTelegramSave(
                        file.withLease,
                        leasedSave,
                        async saved => {
                            const compensation = await compensateIndexedWriteAfterCancel({
                                fileId: saved.fileId,
                                savedPath: saved.savedPath,
                                deleteIndex: async fileId => (await query('DELETE FROM files WHERE id = $1', [fileId])).rowCount === 1,
                                deleteObject: savedPath => provider.deleteFile(savedPath),
                            });
                            if (file.persistentRef?.writeOperationId) {
                                await updateTelegramWriteAfterCompensation(pool, file.persistentRef.writeOperationId, {
                                    objectState: compensation.status === 'compensated' ? 'deleted' : 'unknown',
                                    indexState: compensation.status === 'compensated' ? 'deleted' : 'unknown',
                                    reason: compensation.status === 'compensated' ? 'child settlement 失败后的补偿已确认' : (compensation.error || '补偿结果不确定'),
                                });
                            }
                            return compensation;
                        },
                        async () => {
                            if (signal?.aborted) throw new Error('下载任务已停止');
                            const state = await waitForChannelExecutionPermission(
                                getExecutionControlState,
                                signal || new AbortController().signal,
                                { allowUserPauseForActiveWorker: true },
                            );
                            if (state === 'cancelled') throw new Error('下载任务已停止');
                        },
                    );
                    finalPath = persisted.savedPath;
                    indexedFileId = persisted.fileId;
                    file.leaseSettled = true;
                } else {
                    await leasedSave();
                }
                if (fs.existsSync(localFilePath!)) fs.unlinkSync(localFilePath!);
                localFilePath = undefined;

                // Durable child-lease saves validate cancellation before success settlement. Once
                // settled, late AbortSignal delivery must not delete a file whose child is success.
                if (signal?.aborted && !file.leaseSettled) {
                    const compensation = indexedFileId
                        ? await compensateIndexedWriteAfterCancel({
                            fileId: indexedFileId,
                            savedPath: finalPath,
                            deleteIndex: async fileId => (await query('DELETE FROM files WHERE id = $1', [fileId])).rowCount === 1,
                            deleteObject: savedPath => provider.deleteFile(savedPath),
                        })
                        : { status: 'reconciliation-required' as const, error: '取消补偿缺少文件索引 ID' };
                    if (compensation.status !== 'compensated') {
                        throw new Error(`下载任务取消后需要人工对账: ${compensation.error}`);
                    }
                    throw new Error('下载任务已停止');
                }
                file.status = 'success';
                file.size = actualSize;
                file.fileType = fileType;
                if (queue?.chatId) {
                    const chatIdStr = queue.chatId.toString();
                    const batchId = (file.message as any).groupedId?.toString();
                    if (batchId) updateBatch(chatIdStr, batchId, { folderPath: storageFolder || undefined, providerName: provider.name });
                    rememberTransferDestination(chatIdStr, storageFolder, provider.name);
                }
                return true;
            });

        } catch (error) {
            if ((error as Error)?.name === 'TelegramDownloadLeaseLostError') throw error;
            console.error('🤖 文件上传失败:', error);
            if (isStorageQuotaCooldownError(error)) {
                await markStorageAccountCooldown(error.storageAccountId || file.storageTarget?.accountId, error.provider, error.reason, error.cooldownUntil, error.message);
                file.storageCooldownUntil = error.cooldownUntil;
                file.error = formatStorageCooldownNotice(error.cooldownUntil);
                if (localFilePath && fs.existsSync(localFilePath)) {
                    try { fs.unlinkSync(localFilePath); } catch { }
                }
                throw error;
            } else {
                file.error = (error as Error).message;
            }
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

    const queueTask = async (signal: AbortSignal, taskId?: string) => {
        try {
            const permission = await waitForChannelExecutionPermission(getExecutionControlState, signal);
            if (permission === 'cancelled') {
                file.status = 'failed';
                file.error = '任务已取消';
                return { status: 'success' as const };
            }
            file.status = 'uploading';
            const reportProgress = taskId
                ? (downloaded: number, total: number) => downloadQueue.updateProgress(taskId, downloaded, total)
                : undefined;
            // 不再单独更新 msg，由外部轮询或回调处理
            // if (queue && queue.statusMsgId && queue.chatId) ...

            const firstAttemptSuccess = await attemptUpload(signal, reportProgress);

            if (!firstAttemptSuccess && !signal.aborted && !file.retried && !file.storageCooldownUntil) {
                file.retried = true;
                file.status = 'uploading'; // 保持 uploading 状态供外部显示
                file.error = undefined;
                const secondAttemptSuccess = await attemptUpload(signal, reportProgress);
                if (!secondAttemptSuccess) {
                    file.status = 'failed';
                }
            } else if (!firstAttemptSuccess) {
                file.status = 'failed';
            }
            return file.status === 'failed'
                ? { status: 'failed' as const, error: file.error || '下载失败' }
                : { status: 'success' as const };
        } finally {
            if (queue?.chatId) {
                const batchId = (file.message as any).groupedId?.toString();
                if (batchId) updateBatch(queue.chatId.toString(), batchId, { currentFileActive: false, currentFileName: undefined });
            }
        }
    };

    if (file.generatedName !== false) {
        file.fileName = await getCanonicalTelegramFileName(file.message, file.fileName, file.mimeType, file.sharedCaption, file.groupIndex, true);
    }
    const taskDisplayName = queue?.folderName ? `${queue.folderName}/${file.fileName}` : file.fileName;
    if (!groupId) throw new Error(`下载任务缺少任务组: ${taskDisplayName}`);
    const onPendingCancelled = () => {
        file.status = 'failed';
        file.error = '用户取消任务';
    };
    return downloadQueue.add(groupId, taskDisplayName, queueTask, file.size || 0, onPendingCancelled);
}

// 处理批量文件上传队列
async function processBatchUpload(client: TelegramClient | undefined, queueKey: string): Promise<void> {
    const queue = mediaGroupQueues.get(queueKey);
    if (!queue || queue.processingStarted) return;
    mediaGroupDebouncer.cancel(queueKey);
    queue.processingStarted = true;

    try {
        await processBatchUploadSnapshot(client, queueKey, queue);
    } catch (error) {
        console.error(`🤖 Telegram 相册处理失败: group=${queue.mediaGroupId}`, error);
        queue.processingStarted = false;
        mediaGroupDebouncer.bump(queueKey);
    }
}

async function processBatchUploadSnapshot(client: TelegramClient | undefined, queueKey: string, queue: MediaGroupQueue): Promise<void> {
    const mediaGroupId = queue.mediaGroupId;
    const batchClient: TelegramClient | undefined = client || queue.client || ((queue.files[0]?.message as any)?.client as TelegramClient | undefined);
    if (!batchClient) throw new Error('Telegram 相册缺少可用客户端');

    const snapshot = takePendingMediaGroupSnapshot(queue.files);
    if (snapshot.length === 0) {
        mediaGroupQueues.delete(queueKey);
        return;
    }

    const firstMessage = snapshot[0]?.message;
    if (!firstMessage) throw new Error('Telegram 相册没有有效媒体消息');

    annotateTelegramMediaGroup(snapshot);
    const mediaGroupCaption = snapshot[0]?.sharedCaption || '';
    let folderName = mediaGroupCaption;

    const chatId = queue.chatId!;
    const batchId = mediaGroupId;
    const groupId = ordinaryGroupId('a', chatId.toString(), queueKey);

    if (!folderName || isOpaqueTelegramIdentifier(folderName)) {
        folderName = await getTelegramBatchFolderName(firstMessage, mediaGroupId);
    }
    downloadQueue.ensureGroup({
        id: groupId,
        kind: 'album',
        title: folderName,
        chatId: chatId.toString(),
        userId: queue.userId || firstMessage.senderId?.toJSNumber(),
        targetFolder: queue.storageFolder,
        expectedTotal: snapshot.length,
    });
    const sharedCaption = mediaGroupCaption;
    const activeUserClient = getTelegramUserClient();
    const shouldPrefetchForwardedSources = activeUserClient
        && isTelegramUserClientReady()
        && (await getSetting('telegram_user_download_enabled', 'false')) === 'true'
        && batchClient !== activeUserClient;
    const forwardedSourceCache = shouldPrefetchForwardedSources
        ? await prefetchForwardedSourceMessages(activeUserClient, snapshot.map(file => file.message))
        : undefined;
    if (forwardedSourceCache?.size) {
        console.log(`🤖 批量预取转发来源媒体: group=${mediaGroupId} cached=${forwardedSourceCache.size}/${snapshot.length}`);
    }
    for (const file of snapshot) {
        file.sharedCaption = sharedCaption;
        file.forwardedSourceCache = forwardedSourceCache;
    }

    // 新会话重置检查
    await checkAndResetSession(batchClient, chatId);

    // 注册批量任务到追踪器
    registerBatch(chatId.toString(), batchId, {
        id: batchId,
        folderName,
        folderPath: undefined,
        totalFiles: snapshot.length,
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

    const firstBatchFile = queue.files[0];
    if (firstBatchFile) {
        const chatName = await getTelegramChatName(firstBatchFile.message);
        const batchFolder = null;
        const storageRules = await getStoragePathRules();
        const automaticPreview = buildStorageFolderWithRules({
            source: 'telegram',
            chatName,
            folder: batchFolder,
            mimeType: firstBatchFile.mimeType,
            fileName: firstBatchFile.fileName,
        }, storageRules);
        const storageFolder = resolveTelegramBatchStorageFolder(chatId.toString(), automaticPreview);
        queue.storageFolder = storageFolder;
        downloadQueue.ensureGroup({
            id: groupId,
            kind: 'album',
            title: queue.folderName || folderName,
            chatId: chatId.toString(),
            userId: queue.userId || firstMessage.senderId?.toJSNumber(),
            targetFolder: storageFolder,
            expectedTotal: snapshot.length,
        });
        const folderPreview = storageFolder;
        updateBatch(chatId.toString(), batchId, { folderName: queue.folderName, folderPath: folderPreview || undefined });
        queue.folderPath = folderPreview || undefined;
        rememberTransferDestination(chatId.toString(), folderPreview, storageManager.getProvider().name);
    }

    // 立即显示合并状态（静默模式下跳过）
    if (!silentSessionMap.has(chatId.toString())) {
        await runStatusAction(chatId, async () => {
            const stats = downloadQueue.getStats();
            // 如果是大量文件且之前是静默模式，可能需要保持静默或发送静默通知
            // 这里简化逻辑：直接使用合并视图
            await refreshConsolidatedMessage(batchClient, chatId, firstMessage);
        });
    }

    // 批量上传时的回调，用于更新 Batch Entry
    const onBatchProgress = async () => {
        const completed = queue.files.filter(f => f.status === 'success' || f.status === 'failed').length;
        const successful = queue.files.filter(f => f.status === 'success').length;
        const failed = queue.files.filter(f => f.status === 'failed').length;
        const currentFile = queue.files.find(f => f.status === 'uploading');
        const stats = downloadQueue.getStats();

        updateBatch(chatId.toString(), batchId, {
            completed,
            successful,
            failed,
            queuePending: stats.pending,
            currentFileName: currentFile?.fileName,
            currentFileActive: Boolean(currentFile),
        });

        // 静默模式下编辑静默通知为进度卡；非静默模式更新合并状态
        if (silentSessionMap.has(chatId.toString())) {
            await runStatusAction(chatId, async () => {
                await refreshSilentProgress(batchClient, chatId);
            });
        } else {
            await runStatusAction(chatId, async () => {
                await refreshConsolidatedMessage(batchClient, chatId);
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
            await finalizeSilentSessionIfDone(batchClient, chatId);
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

    const queuedFilePromises: Promise<void>[] = [];
    try {
        // snapshot 已在 200ms quiet window 后冻结，统一 caption 与顺序后再并发入队。
        for (let offset = 0; offset < snapshot.length; offset += TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE) {
            const files = snapshot.slice(offset, offset + TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE);
            for (const file of files) {
                file.targetDir = targetDir;
                file.forwardedSourceCache = forwardedSourceCache;
                queuedFilePromises.push(
                    processFileUpload(batchClient, file, queue, groupId)
                        .finally(refreshBatchProgressAndFinalizeSilent)
                );
            }
        }
        updateBatch(chatId.toString(), batchId, { totalFiles: snapshot.length });
        await Promise.allSettled(queuedFilePromises);

        await onBatchProgress();
        await finalizeSilentSessionIfDone(batchClient, chatId);

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

        // 只有确认没有晚到的 pending 项才清理；若状态更新期间又有新项到达，重新安排同组 processor。
        if (queue.files.some(file => file.status === 'pending')) {
            queue.processingStarted = false;
            mediaGroupDebouncer.bump(queueKey);
        } else {
            mediaGroupQueues.delete(queueKey);
        }
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

export async function getTelegramDownloadPreview(messages: Api.Message[]): Promise<{ mediaCount: number; duplicateCount: number; newCount: number; skippedCount: number }> {
    const activeAccountId = storageManager.getActiveAccountId();
    const storageRules = await getStoragePathRules();
    let mediaCount = 0;
    let duplicateCount = 0;
    let skippedCount = 0;

    for (const message of messages) {
        const fileInfo = extractFileInfo(message);
        if (!fileInfo) {
            skippedCount += 1;
            continue;
        }
        mediaCount += 1;
        const chatName = await getTelegramChatName(message);
        const automaticFolder = buildStorageFolderWithRules({
            source: 'telegram',
            chatName,
            mimeType: fileInfo.mimeType,
            fileName: fileInfo.fileName,
        }, storageRules);
        const storageFolder = previewTelegramStorageFolder(message.chatId?.toString() || 'unknown', automaticFolder);
        const duplicate = await findDuplicateFile(fileInfo.fileName, storageFolder, getEstimatedFileSize(message), activeAccountId);
        if (duplicate) duplicateCount += 1;
    }

    return {
        mediaCount,
        duplicateCount,
        newCount: Math.max(0, mediaCount - duplicateCount),
        skippedCount,
    };
}

function sourceKeyForDownloadRef(source: Api.TypeEntityLike | string): string {
    if (typeof source === 'string') return source;
    const anySource: any = source as any;
    const id = anySource?.channelId || anySource?.chatId || anySource?.userId || anySource?.id;
    if (id !== undefined && id !== null) {
        return `${anySource?.className || 'peer'}:${id.toString()}`;
    }
    return JSON.stringify(source);
}

function normalizeTelegramDownloadRefs(
    refs: TelegramDownloadMessageRef[] | undefined,
    defaultSourceEntity: Api.TypeEntityLike | string,
): TelegramDownloadMessageRef[] | undefined {
    if (!refs) return undefined;
    return refs
        .filter(ref => ref.id > 0)
        .map(ref => ({ ...ref, source: ref.source || defaultSourceEntity }));
}

export async function downloadTelegramChannelRange(
    botClient: TelegramClient,
    requestMessage: Api.Message,
    source: string,
    startMessageId: number,
    limit: number = 50,
    direction: 'older' | 'newer' = 'older',
    explicitIds?: number[],
    folderOverride?: string | null,
    explicitRefs?: TelegramDownloadMessageRef[],
    onItemSettled?: (item: TelegramDownloadMessageRef, status: 'success' | 'failed' | 'skipped', error?: string) => Promise<void> | void,
    executionGroupKey?: string,
    getExecutionControlState?: () => Promise<'run' | 'paused' | 'cooldown' | 'cancelled'>,
    taskSignal?: AbortSignal,
    ownerUserId?: number,
    storageTarget: StorageTargetSnapshot = storageManager.getActiveTarget(),
    withItemLease?: <T>(ref: TelegramDownloadMessageRef, operation: () => Promise<T>) => Promise<T>,
): Promise<{ requested: number; found: number; skipped: number; failed: number; successful: number; successfulMessageIds: number[]; failedMessageIds: number[]; skippedMessageIds: number[]; firstId: number; lastId: number }> {
    const userClient = getTelegramUserClient();
    if (!userClient || !isTelegramUserClientReady()) {
        throw new Error('Telegram 用户账号下载器未就绪：请先配置 TELEGRAM_API_ID / TELEGRAM_API_HASH 并生成 user session');
    }

    const safeLimit = Math.max(1, Math.floor(limit || TG_BATCH_DEFAULT_LIMIT));
    const sourceEntity = source.startsWith('@') || /^-?\d+$/.test(source) || /^https?:\/\//i.test(source)
        ? source
        : `@${source}`;
    const normalizedExplicitRefs = normalizeTelegramDownloadRefs(explicitRefs, sourceEntity);
    const ids = normalizedExplicitRefs?.map(ref => ref.id) || explicitIds?.filter(id => id > 0) || Array.from({ length: safeLimit }, (_, index) => (
        direction === 'newer' ? startMessageId + index : startMessageId - index
    )).filter(id => id > 0);

    if (ids.length === 0) {
        throw new Error('起始消息 ID 无效');
    }

    const chatId = requestMessage.chatId;
    if (!chatId) {
        throw new Error('无法识别当前 Bot 会话');
    }

    await checkAndResetSession(botClient, chatId);

    let found = 0;
    let skipped = 0;
    const chatIdStr = chatId.toString();
    const taskFolderOverride = folderOverride !== undefined ? folderOverride : undefined;
    let taskResolvedStorageFolder: string | null | undefined;
    const downloadableRefs: DownloadableMessageRef[] = [];
    const successfulMessageIds: number[] = [];
    const failedMessageIds: number[] = [];
    const skippedMessageIds: number[] = [];

    if (normalizedExplicitRefs) {
        for (const ref of normalizedExplicitRefs) {
            const refSource = ref.source || sourceEntity;
            const fileInfo = ref.fileInfo;
            if (!fileInfo) {
                skipped += 1;
                skippedMessageIds.push(ref.id);
                await onItemSettled?.(ref, 'skipped');
                continue;
            }
            downloadableRefs.push({
                id: ref.id,
                sourceKey: sourceKeyForDownloadRef(refSource),
                sourceEntity: refSource,
                persistentRef: ref,
                origin: ref.origin || 'channel',
                channelPostId: ref.channelPostId,
                fileInfo,
                totalSize: ref.totalSize || 0,
                message: ref.message,
                groupedId: ref.groupedId,
                sharedCaption: ref.sharedCaption,
                groupIndex: ref.groupIndex,
                groupSize: ref.groupSize,
            });
        }
    } else {
        for (let offset = 0; offset < ids.length; offset += TG_LARGE_TASK_SEGMENT_SIZE) {
            const scanIds = ids.slice(offset, offset + TG_LARGE_TASK_SEGMENT_SIZE);
            const scanMessages = await userClient.getMessages(sourceEntity as any, { ids: scanIds });
            const returnedIds = new Set<number>();
            for (const sourceMessage of scanMessages) {
                if (!sourceMessage) continue;
                returnedIds.add(sourceMessage.id);
                const fileInfo = extractFileInfo(sourceMessage);
                if (!fileInfo) {
                    skipped += 1;
                    skippedMessageIds.push(sourceMessage.id);
                    continue;
                }
                downloadableRefs.push({
                    id: sourceMessage.id,
                    sourceKey: sourceKeyForDownloadRef(sourceEntity),
                    sourceEntity,
                    persistentRef: { id: sourceMessage.id, source: sourceEntity, origin: 'channel', fileInfo },
                    origin: 'channel',
                    fileInfo,
                    totalSize: getEstimatedFileSize(sourceMessage),
                });
            }
            for (const requestedId of scanIds) {
                if (!returnedIds.has(requestedId)) {
                    skipped += 1;
                    skippedMessageIds.push(requestedId);
                }
            }
        }
    }

    const batchId = `tg-range-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const channelGroupId = channelExecutionGroupId(executionGroupKey || `${chatIdStr}:${batchId}`);
    if (executionGroupKey) {
        const controlState = await getExecutionControlState?.();
        if (controlState && controlState !== 'run') {
            if (controlState === 'cancelled') {
                for (const ref of downloadableRefs) await onItemSettled?.(ref.persistentRef, 'skipped', '任务已取消');
            }
            return {
                requested: ids.length,
                found: 0,
                skipped: controlState === 'cancelled' ? downloadableRefs.length : 0,
                failed: 0,
                successful: 0,
                successfulMessageIds,
                failedMessageIds,
                skippedMessageIds: controlState === 'cancelled' ? downloadableRefs.map(ref => ref.id) : skippedMessageIds,
                firstId: ids[0],
                lastId: ids[ids.length - 1],
            };
        }
    }
    downloadQueue.ensureGroup({
        id: channelGroupId,
        kind: 'channel',
        title: sourceEntity.toString(),
        chatId: chatIdStr,
        hidden: true,
        expectedTotal: downloadableRefs.length,
    });
    if (downloadableRefs.length > 0) {
        const firstRef = downloadableRefs[0];
        if (taskFolderOverride !== undefined) {
            taskResolvedStorageFolder = taskFolderOverride;
        } else if (firstRef) {
            const firstMessage = (await userClient.getMessages(firstRef.sourceEntity as any, { ids: [firstRef.id] }))[0] as Api.Message | undefined;
            if (firstMessage) {
                const chatName = await getTelegramChatName(firstMessage);
                const storageRules = await getStoragePathRules();
                const automaticPreview = buildStorageFolderWithRules({
                    source: 'telegram',
                    chatName,
                    mimeType: firstRef.fileInfo.mimeType,
                    fileName: firstRef.fileInfo.fileName,
                }, storageRules);
                taskResolvedStorageFolder = resolveTelegramTaskStorageFolder(chatIdStr, automaticPreview).folder;
            }
        }
        registerBatch(chatIdStr, batchId, {
            id: batchId,
            folderName: sourceEntity.toString(),
            folderPath: taskResolvedStorageFolder || undefined,
            totalFiles: downloadableRefs.length,
            completed: 0,
            successful: 0,
            failed: 0,
            providerName: storageManager.getProvider().name,
            queuePending: 0,
        });
        await trySilentMode(botClient, chatId, requestMessage, ownerUserId ?? requestMessage.senderId?.toJSNumber());
        await refreshConsolidatedMessage(botClient, chatId, requestMessage);
    }

    let completed = 0;
    let successful = 0;
    let failed = 0;
    let lastStatusRefresh = 0;

    const refreshSegmentStatus = async (force = false, currentFileName?: string) => {
        if (!shouldRefreshLargeTaskStatus(lastStatusRefresh, completed, force)) return;
        lastStatusRefresh = Date.now();
        const stats = downloadQueue.getStats();
        updateBatch(chatIdStr, batchId, {
            completed,
            successful,
            failed,
            queuePending: stats.pending,
            currentFileName,
        });
        if (silentSessionMap.has(chatIdStr)) {
            await refreshSilentProgress(botClient, chatId);
            await finalizeSilentSessionIfDone(botClient, chatId);
        } else {
            await refreshConsolidatedMessage(botClient, chatId);
        }
    };

    for (let offset = 0; offset < downloadableRefs.length; offset += TG_LARGE_TASK_SEGMENT_SIZE) {
        const segment = downloadableRefs.slice(offset, offset + TG_LARGE_TASK_SEGMENT_SIZE);
        const segmentBytes = segment.reduce((sum, item) => sum + (item.totalSize || 0), 0);
        await waitForDiskWatermark(segmentBytes, taskSignal);
        const segmentMessagesBySource = new Map<string, Map<number, Api.Message>>();
        const refsBySource = new Map<string, DownloadableMessageRef[]>();
        for (const item of segment) {
            const items = refsBySource.get(item.sourceKey) || [];
            items.push(item);
            refsBySource.set(item.sourceKey, items);
        }
        for (const [sourceKey, sourceItems] of refsBySource) {
            const preloadedMessageById = new Map<number, Api.Message>();
            const missingSourceItems: DownloadableMessageRef[] = [];
            for (const sourceItem of sourceItems) {
                if (sourceItem.message) {
                    preloadedMessageById.set(sourceItem.id, sourceItem.message);
                } else {
                    missingSourceItems.push(sourceItem);
                }
            }
            if (missingSourceItems.length > 0) {
                const segmentIds = missingSourceItems.map(item => item.id);
                const segmentMessages = await userClient.getMessages(sourceItems[0].sourceEntity as any, { ids: segmentIds });
                for (const segmentMessage of segmentMessages) {
                    if (segmentMessage) preloadedMessageById.set(segmentMessage.id, segmentMessage as Api.Message);
                }
            }
            segmentMessagesBySource.set(sourceKey, preloadedMessageById);
        }

        await Promise.all(segment.map(async (item) => {
            if (getExecutionControlState) {
                const controlState = await getExecutionControlState();
                if (controlState !== 'run') {
                    if (controlState === 'cancelled') {
                        skipped += 1;
                        completed += 1;
                        skippedMessageIds.push(item.id);
                        await onItemSettled?.(item.persistentRef, 'skipped', '任务已取消');
                    }
                    return;
                }
            }
            const { fileName, mimeType } = item.fileInfo;
            const message = segmentMessagesBySource.get(item.sourceKey)?.get(item.id);
            if (!message) {
                skipped += 1;
                failed += 1;
                completed += 1;
                failedMessageIds.push(item.id);
                await refreshSegmentStatus(false, fileName);
                await onItemSettled?.(item.persistentRef, 'failed', '消息不存在或无法重新读取');
                return;
            }
            const uploadItem: FileUploadItem = {
                fileName,
                mimeType,
                generatedName: item.fileInfo.generatedName,
                message,
                status: 'pending',
                sharedCaption: item.sharedCaption,
                groupIndex: item.groupIndex,
                groupSize: item.groupSize,
                storageTarget,
                persistentRef: item.persistentRef,
                withLease: withItemLease ? operation => withItemLease(item.persistentRef, operation) : undefined,
            };
            try {
                if (taskResolvedStorageFolder !== undefined) {
                    updateBatch(chatIdStr, batchId, { folderPath: taskResolvedStorageFolder || undefined });
                } else if (!getConsolidatedBatches(chatIdStr).find(batch => batch.id === batchId)?.folderPath) {
                    const chatName = await getTelegramChatName(message);
                    const storageRules = await getStoragePathRules();
                    const automaticPreview = buildStorageFolderWithRules({
                        source: 'telegram',
                        chatName,
                        mimeType,
                        fileName,
                    }, storageRules);
                    const resolved = resolveTelegramTaskStorageFolder(chatIdStr, automaticPreview).folder;
                    taskResolvedStorageFolder = resolved;
                    updateBatch(chatIdStr, batchId, { folderPath: resolved || undefined });
                }
                uploadItem.folderOverride = taskResolvedStorageFolder !== undefined ? taskResolvedStorageFolder : taskFolderOverride;
                await refreshSegmentStatus(true, fileName);
                await processFileUpload(userClient, uploadItem, undefined, channelGroupId, getExecutionControlState);
                if (uploadItem.status === 'success') {
                    successful += 1;
                    successfulMessageIds.push(item.id);
                    if (!uploadItem.leaseSettled) await onItemSettled?.(item.persistentRef, 'success');
                } else if (uploadItem.storageCooldownUntil) {
                    throw new StorageQuotaCooldownError(uploadItem.error || 'Google Drive 今日上传额度已达上限，任务将自动暂停 24 小时后继续。', {
                        provider: 'google_drive',
                        reason: 'daily_upload_limit',
                        storageAccountId: storageManager.getActiveAccountId() || undefined,
                        cooldownUntil: uploadItem.storageCooldownUntil,
                    });
                } else {
                    failed += 1;
                    failedMessageIds.push(item.id);
                    await onItemSettled?.(item.persistentRef, 'failed', uploadItem.error || '下载失败');
                }
            } catch (err) {
                if ((err as Error)?.name === 'TelegramDownloadLeaseLostError') throw err;
                if (isStorageQuotaCooldownError(err)) {
                    throw err;
                }
                const flood = (() => {
                    const anyErr = err as any;
                    const text = `${anyErr?.message || ''} ${anyErr?.errorMessage || ''}`;
                    const seconds = Number(anyErr?.seconds || anyErr?.value || text.match(/FLOOD_WAIT_?(\d+)/i)?.[1] || 0);
                    return seconds > 0 || /FLOOD|Too many requests/i.test(text) ? Math.max(30, seconds || 60) : 0;
                })();
                if (flood > 0) {
                    const floodError = new Error(`Telegram FloodWait ${flood}s`);
                    (floodError as any).seconds = flood;
                    throw floodError;
                }
                console.error(`🤖 频道分段下载任务异常: ${fileName}`, err);
                failed += 1;
                failedMessageIds.push(item.id);
                await onItemSettled?.(item.persistentRef, 'failed', err instanceof Error ? err.message : String(err));
            } finally {
                if (!uploadItem.storageCooldownUntil) {
                    completed += 1;
                    found += 1;
                }
                await refreshSegmentStatus(false, fileName);
            }
        }));
        await refreshSegmentStatus(true, segment[segment.length - 1]?.fileInfo.fileName);
    }

    if (downloadableRefs.length > 0) {
        updateBatch(chatIdStr, batchId, { completed, successful, failed, queuePending: 0, currentFileName: undefined });
        await refreshSegmentStatus(true);
        await finalizeSilentSessionIfDone(botClient, chatId);
        setTimeout(() => removeBatch(chatIdStr, batchId), 8000);
    }

    return {
        requested: ids.length,
        found,
        skipped,
        failed,
        successful,
        successfulMessageIds,
        failedMessageIds,
        skippedMessageIds: skippedMessageIds.filter(id => id > 0),
        firstId: ids[0],
        lastId: ids[ids.length - 1],
    };
}

// Main handler for file uploads
export async function handleFileUpload(client: TelegramClient, event: NewMessageEvent): Promise<void> {
    const message = event.message;
    const senderId = message.senderId?.toJSNumber();
    if (!senderId) return;

    if (!(await isAuthenticatedAsync(senderId))) {
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

    const { fileName, mimeType, generatedName } = fileInfo;
    const mediaGroupId = (message as any).groupedId?.toString();

    if (mediaGroupId) {
        if (message.chatId) {
            await checkAndResetSession(client, message.chatId);
        }
        const queueKey = telegramMediaGroupQueueKey(message.chatId, mediaGroupId);
        let queue = mediaGroupQueues.get(queueKey);
        if (!queue) {
            queue = {
                mediaGroupId,
                queueKey,
                chatId: message.chatId,
                userId: senderId,
                client,
                files: [],
                processingStarted: false,
                storageTarget: storageManager.getActiveTarget(),
                createdAt: Date.now(),
                lastAddedAt: Date.now(),
            };
            mediaGroupQueues.set(queueKey, queue);
            const queueInstance = queue;
            setTimeout(() => {
                if (mediaGroupQueues.get(queueKey) === queueInstance && !queueInstance.processingStarted) {
                    mediaGroupDebouncer.flush(queueKey);
                }
            }, MEDIA_GROUP_MAX_WAIT_MS);
        }
        queue.files.push({
            fileName,
            mimeType,
            generatedName,
            message,
            status: 'pending',
        });
        queue.lastAddedAt = Date.now();
        mediaGroupDebouncer.bump(queueKey);

        // 先把 media group 登记到合并追踪器里
        if (message.chatId) {
            const chatIdStr = message.chatId.toString();
            const batchId = mediaGroupId;
            const batchMap = chatActiveBatches.get(chatIdStr);
            if (!batchMap || !batchMap.has(batchId)) {
                registerBatch(chatIdStr, batchId, {
                    id: batchId,
                    folderName: queue.folderName || 'media-group',
                    folderPath: undefined,
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
            await trySilentMode(client, message.chatId, message, senderId);
            const taskId = getSessionTaskId(message.chatId.toString());
            if (taskId) registerTaskControlScope(taskId, message.chatId.toString(), senderId);
        }
    } else {
        let finalFileName = fileName;

        const typeEmoji = getTypeEmoji(mimeType);
        const totalSize = getEstimatedFileSize(message);
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const chatId = message.chatId!;
        const chatIdStr = chatId.toString();
        const chatName = await getTelegramChatName(message);
        const previewRules = await getStoragePathRules();
        const previewFolder = resolveTelegramStorageFolder(chatIdStr, buildStorageFolderWithRules({
            source: 'telegram',
            chatName,
            mimeType,
            fileName: finalFileName,
        }, previewRules));
        const singleStorageTarget = storageManager.getActiveTarget();
        const singleGroupId = ordinaryGroupId('s', chatIdStr, String(message.id));
        downloadQueue.ensureGroup({
            id: singleGroupId,
            kind: 'single',
            title: finalFileName,
            chatId: chatIdStr,
            userId: senderId,
            targetFolder: previewFolder,
            expectedTotal: 1,
        });

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

        await trySilentMode(client, chatId, message, senderId);
        const silentTaskId = getSessionTaskId(chatIdStr);
        if (silentTaskId) registerTaskControlScope(silentTaskId, chatIdStr, senderId);

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

            if (silentSessionMap.has(chatIdStr)) {
                await runStatusAction(chatId, async () => {
                    await refreshSilentProgress(client, chatId);
                });
                return;
            }

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
        let storageCooldownUntil: Date | undefined;

        const attemptSingleUpload = async (signal?: AbortSignal, reportProgress: (downloaded: number, total: number) => void = (downloaded, total) => { void onProgress(downloaded, total); }): Promise<boolean> => {
            let localFilePath: string | undefined;
            const storageTarget = singleStorageTarget;
            const { provider, accountId: activeAccountId } = storageTarget;
            try {
                if (signal?.aborted) throw new Error('下载任务已停止');
                await assertStorageTargetWritable(storageTarget);
                finalFileName = await getCanonicalTelegramFileName(message, finalFileName, mimeType, undefined, undefined, generatedName);
                updateUploadPhase(chatIdStr, uploadId, { fileName: finalFileName });
                const storageRules = await getStoragePathRules();
                const automaticFolder = buildStorageFolderWithRules({
                    source: 'telegram',
                    chatName,
                    mimeType,
                    fileName: finalFileName,
                }, storageRules);
                const storageFolder = resolveTelegramStorageFolder(chatIdStr, automaticFolder);
                downloadQueue.ensureGroup({
                    id: singleGroupId,
                    kind: 'single',
                    title: finalFileName,
                    chatId: chatIdStr,
                    userId: senderId,
                    targetFolder: storageFolder,
                    expectedTotal: 1,
                });
                // 关键在这里：获取唯一文件名
                const storedName = await getUniqueStoredName(finalFileName, storageFolder, activeAccountId);

                const downloadSource = await resolveDownloadSource(client, message);
                const result = await downloadAndSaveFile(downloadSource.client, downloadSource.message, fileName, undefined, reportProgress, signal);
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
                        updateUploadPhase(chatIdStr, uploadId, { phase: 'success', size: actualSize, providerName: provider.name, fileType, folder: storageFolder });
                        rememberTransferDestination(chatIdStr, storageFolder, provider.name);
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
                if (silentSessionMap.has(chatIdStr)) {
                    await runStatusAction(chatId, async () => {
                        await refreshSilentProgress(client, chatId);
                    });
                } else if (useConsolidated()) {
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

                if (signal?.aborted) throw new Error('下载任务已停止');
                let thumbnailPath: string | null = null;
                let dimensions: { width?: number; height?: number } = {};
                // 方案A：只在本地存储生成缩略图；第三方存储不生成本地缩略图。
                if (provider.name === 'local' && (mimeType.startsWith('image/') || mimeType.startsWith('video/'))) {
                    try {
                        thumbnailPath = await generateThumbnail(localFilePath, storedName, mimeType);
                        dimensions = await getImageDimensions(localFilePath, mimeType);
                    } catch (thumbErr) { }
                }

                let finalPath = localFilePath;
                let indexedFileId: string | null = null;
                let sourceRef = provider.name;

                if (signal?.aborted) throw new Error('下载任务已停止');
                try {
                    finalPath = await withStorageAccountOperationLease(pool, activeAccountId, 'telegram_upload', () =>
                        saveAndIndexWithCompensation(provider, localFilePath!, storedName, mimeType, storageFolder, async savedPath => {
                            const inserted = await query(`
                                INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                                RETURNING id
                            `, [finalFileName, storedName, fileType, mimeType, actualSize, savedPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, storageFolder, activeAccountId]);
                            indexedFileId = String(inserted.rows[0].id);
                        }),
                    );
                    if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
                    lastLocalPath = undefined;
                    localFilePath = undefined;
                } catch (err) {
                    lastError = (err as Error).message;
                    throw err;
                }

                if (signal?.aborted) {
                    const compensation = indexedFileId
                        ? await compensateIndexedWriteAfterCancel({
                            fileId: indexedFileId,
                            savedPath: finalPath,
                            deleteIndex: async fileId => (await query('DELETE FROM files WHERE id = $1', [fileId])).rowCount === 1,
                            deleteObject: savedPath => provider.deleteFile(savedPath),
                        })
                        : { status: 'reconciliation-required' as const, error: '取消补偿缺少文件索引 ID' };
                    if (compensation.status !== 'compensated') {
                        throw new Error(`下载任务取消后需要人工对账: ${compensation.error}`);
                    }
                    throw new Error('下载任务已停止');
                }

                updateUploadPhase(chatIdStr, uploadId, { phase: 'success', size: actualSize, providerName: provider.name, fileType, folder: storageFolder });
                rememberTransferDestination(chatIdStr, storageFolder, provider.name);

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
                if (isStorageQuotaCooldownError(error)) {
                    await markStorageAccountCooldown(error.storageAccountId || singleStorageTarget.accountId, error.provider, error.reason, error.cooldownUntil, error.message);
                    storageCooldownUntil = error.cooldownUntil;
                    lastError = formatStorageCooldownNotice(error.cooldownUntil);
                } else {
                    lastError = error instanceof Error ? error.message : '未知错误';
                }
                if (localFilePath && fs.existsSync(localFilePath)) {
                    try { fs.unlinkSync(localFilePath); } catch (e) { }
                }
                lastLocalPath = undefined;
                return false;
            }
        };

        const singleUploadTask = async (signal: AbortSignal, taskId?: string) => {
            const reportQueueProgress = (downloaded: number, total: number) => {
                if (taskId) downloadQueue.updateProgress(taskId, downloaded, total);
                void onProgress(downloaded, total);
            };
            let success = await attemptSingleUpload(signal, reportQueueProgress);
            if (!success && !signal.aborted && !storageCooldownUntil && retryCount < maxRetries) {
                retryCount++;
                if (lastLocalPath && fs.existsSync(lastLocalPath)) {
                    try { fs.unlinkSync(lastLocalPath); } catch (e) { }
                }
                lastLocalPath = undefined;

                updateUploadPhase(chatIdStr, uploadId, { phase: 'retrying' });
                if (silentSessionMap.has(chatIdStr)) {
                    await runStatusAction(chatId, async () => {
                        await refreshSilentProgress(client, chatId);
                    });
                } else if (useConsolidated()) {
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
                success = await attemptSingleUpload(signal, reportQueueProgress);
            }

            if (storageCooldownUntil) {
                updateUploadPhase(chatIdStr, uploadId, { phase: 'queued' });
                const retryResult = await waitForStorageCooldownRetry(
                    storageCooldownUntil,
                    signal,
                    async () => {
                        storageCooldownUntil = undefined;
                        lastError = undefined;
                        success = await attemptSingleUpload(signal, reportQueueProgress);
                        return storageCooldownUntil;
                    },
                    async (retryAt) => {
                        if (statusMsg && !silentSessionMap.has(chatIdStr)) {
                            await safeEditMessage(client, chatId, { message: statusMsg.id, text: lastError || formatStorageCooldownNotice(retryAt) });
                        }
                    },
                );
                if (retryResult === 'cancelled') return { status: 'success' as const };
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
                updateUploadPhase(chatIdStr, uploadId, { phase: 'failed', error: lastError || '未知错误' });
                if (silentSessionMap.has(chatIdStr)) {
                    const sess = getSilentSession(chatIdStr);
                    sess.completed += 1;
                    sess.failed += 1;
                    await refreshSilentProgress(client, chatId);
                    await finalizeSilentSessionIfDone(client, chatId);
                }
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
                    await refreshSilentProgress(client, chatId);
                    await finalizeSilentSessionIfDone(client, chatId);
                }
            }

            setTimeout(() => {
                removeUpload(chatIdStr, uploadId);
            }, 8000);
            return success
                ? { status: 'success' as const }
                : { status: 'failed' as const, error: lastError || '未知错误' };
        };

        const onSinglePendingCancelled = async () => {
            const error = '用户取消任务';
            updateUploadPhase(chatIdStr, uploadId, { phase: 'failed', error });
            if (silentSessionMap.has(chatIdStr)) {
                const sess = getSilentSession(chatIdStr);
                sess.completed += 1;
                sess.failed += 1;
                await refreshSilentProgress(client, chatId);
                await finalizeSilentSessionIfDone(client, chatId);
            } else if (useConsolidated()) {
                await runStatusAction(chatId, async () => refreshConsolidatedMessage(client, chatId));
            } else if (statusMsg) {
                await safeEditMessage(client, chatId, {
                    message: statusMsg.id,
                    text: buildUploadFail(finalFileName, error),
                });
            }
            setTimeout(() => removeUpload(chatIdStr, uploadId), 8000);
        };
        downloadQueue.add(singleGroupId, finalFileName, singleUploadTask, totalSize, onSinglePendingCancelled).catch(err => {
            console.error(`🤖 单文件下载任务异常: ${finalFileName}`, err);
            removeUpload(chatIdStr, uploadId);
        });
    }
}
