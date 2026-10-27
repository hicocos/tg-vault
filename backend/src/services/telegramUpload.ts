import { Api, TelegramClient } from 'telegram';
import { withTelegramAccount, startTelegramDownloadAttempt, finishTelegramDownloadAttempt, markTelegramAccountSourceAccess } from './telegramMultiAccountRuntime.js';
import { getTelegramMessagesWithAccess, getTelegramDiscussionMessagesWithAccess, getTelegramForwardedMessage } from './telegramScanAccount.js';
import { NewMessageEvent } from 'telegram/events/index.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bigInt from 'big-integer';
import { query, pool } from '../db/index.js';
import { getTaskReceipt, saveTaskReceipt } from './telegramTaskReceipts.js';
import { retryTelegramBackgroundJob } from './telegramChannelJobs.js';
import { generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';
import { storageManager, StorageQuotaCooldownError, isStorageQuotaCooldownError, type StorageTargetSnapshot } from './storage.js';
import { TaskAbortRegistry } from './taskAbortRegistry.js';
import { assertStorageTargetWritable, formatStorageCooldownNotice } from './storageCooldownGuard.js';
import { markStorageAccountCooldown } from './storageCooldown.js';
import { getSetting } from '../utils/settings.js';
import { isAuthenticatedAsync } from './telegramState.js';
import { formatBytes, getTypeEmoji, getFileType, sanitizeFilename } from '../utils/telegramUtils.js';
import { extractFileInfo, getDownloadableMedia, getEstimatedFileSize, isTelegramPhotoMedia, type TelegramFileInfo } from '../utils/telegramMedia.js';
import { telegramChatKeyFromPeerParts } from '../utils/telegramChatKey.js';
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
import { annotateTelegramMediaGroup, createTelegramMediaGroupDebouncer, getOrCreateTelegramMediaGroupQueue, takePendingMediaGroupSnapshot, telegramMediaGroupQueueKey } from '../utils/telegramMediaGroup.js';
import { resolveTelegramStorageFolderPersistent, resolveTelegramTaskStorageFolderPersistent, previewTelegramStorageFolderPersistent } from '../utils/telegramPathSettings.js';
import { consumeOrGetTelegramTargetState } from '../utils/telegramTargetStateStore.js';
import { findDuplicateFile, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { DownloadTaskQueue, type DownloadTaskGroupInput, type DownloadTaskGroupSnapshot } from './downloadTaskQueue.js';
import { runRollingDownloadWindow } from './rollingDownloadWindow.js';
import { persistOrdinaryTransferTask, updateTransferTask } from './transferTasks.js';
import { saveAndIndexWithCompensation, compensateIndexedWriteAfterCancel } from './storageWrite.js';
import { acquireStorageAccountOperationLease, withStorageAccountOperationLease } from './storageAccountOperation.js';
import { lockStorageAccountForUse } from './storageAccountLifecycle.js';
import {
    beginTelegramWriteReconciliation,
    markTelegramWriteIndexPresent,
    markTelegramWriteObjectPresent,
    updateTelegramWriteAfterCompensation,
} from './telegramWriteReconciliation.js';
import { getTelegramUserLocaleOrDefault } from './telegramLocalePreferences.js';
import { DEFAULT_LOCALE, formatBytes as formatLocalizedBytes, t, type TelegramLocale } from '../i18n/telegram.js';
import { buildTaskCenterDetail, ordinaryTaskCenterItem, type TaskCenterItem } from './telegramTaskCenter.js';
import { buildProgressControlButtons, registerProgressCard, isInteractiveProgressCard, taskCenterCardOwners, taskCenterCardKey } from './telegramProgressControls.js';
import { downloadProgressView } from './downloadProgress.js';
import { telegramDownloadStream, runTelegramDownloadStripes } from './telegramDownloadStream.js';
import { setTimeout as waitForDownload } from 'node:timers/promises';
import { getProviderDisplayName } from '../utils/providerMetadata.js';
import { protectTemporaryUploadFile, withTemporaryUploadFiles } from '../utils/temporaryUploadFiles.js';
import { normalizeFileDownloadConcurrency, registerFileConcurrencyRuntime } from './telegramFileConcurrency.js';
import { isTelegramTransientDownloadError } from './telegramDownloadRetry.js';
import { normalizeTelegramDownloadWorkers } from '../utils/advancedSettings.js';
import { TelegramUserWorkerClient } from './telegramUserWorkerClient.js';
import { createTelegramDownloadIterator, TELEGRAM_DOWNLOAD_PART_SIZE, writeTelegramDownloadChunk } from './telegramFileDownload.js';
import { TelegramDiskReservations } from './telegramDiskReservations.js';
import { rememberOrdinaryFile, updateOrdinaryFile, indexOrdinaryFile, readRecoverableOrdinaryTasks, rereadOrdinaryFile } from './telegramOrdinaryRecovery.js';
import { botDownloadRuntime } from './telegramBotDownloadRuntime.js';
import { refreshTelegramDownloadMessage } from './telegramDownloadSource.js';
import { withTelegramOperationSignal } from './telegramOperationContext.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const DEFAULT_TELEGRAM_DOWNLOAD_WORKERS = normalizeTelegramDownloadWorkers(process.env.TELEGRAM_DOWNLOAD_WORKERS);
const TG_BATCH_DEFAULT_LIMIT = 50;
const TG_LARGE_TASK_SEGMENT_SIZE = Math.max(10, parseInt(process.env.TG_LARGE_TASK_SEGMENT_SIZE || '50', 10) || 50);
const TG_MIN_FREE_DISK_BYTES = Math.max(1024 * 1024 * 1024, (parseInt(process.env.TG_MIN_FREE_DISK_GB || '8', 10) || 8) * 1024 * 1024 * 1024);
const TG_LARGE_TASK_REFRESH_INTERVAL_MS = Math.max(3000, parseInt(process.env.TG_LARGE_TASK_REFRESH_INTERVAL_MS || '10000', 10) || 10000);
const TG_DISK_WATERMARK_RECHECK_MS = Math.max(5000, parseInt(process.env.TG_DISK_WATERMARK_RECHECK_MS || '30000', 10) || 30000);
const TG_DISK_WATERMARK_MAX_WAIT_MS = Math.max(0, parseInt(process.env.TG_DISK_WATERMARK_MAX_WAIT_MS || '0', 10) || 0);
const TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE = Math.max(1, parseInt(process.env.TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE || '50', 10) || 50);
const MEDIA_GROUP_DEBOUNCE_MS = 200;
const MEDIA_GROUP_MAX_WAIT_MS = 1500;
const diskReservations = new TelegramDiskReservations();


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
        persisted = await save();
        await validateBeforeSettlement();
        return await withLease(async () => persisted!);
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

async function getTelegramDownloadWorkers(): Promise<number> {
    const storedValue = await getSetting('telegram_download_workers', String(DEFAULT_TELEGRAM_DOWNLOAD_WORKERS));
    return normalizeTelegramDownloadWorkers(storedValue);
}

// 用于追踪 Telegram FloodWait 的全局截止时间
let floodWaitUntil = 0;

async function downloadIncomingTelegramFile(
    botClient: TelegramClient,
    message: Api.Message,
    fileName: string,
    targetDir?: string,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
    groupId?: string,
    taskId?: string,
    onPooled?: () => void,
) {
    const previousClient = botClient;
    botClient = await botDownloadRuntime.acquire(botClient, signal);
    if (botClient !== previousClient) message = await refreshTelegramDownloadMessage(botClient, message);
    if ((await getSetting('telegram_user_download_enabled', 'false')) !== 'true') {
        return downloadAndSaveFile(botClient, message, fileName, targetDir, onProgress, signal, groupId);
    }
    const forwarded = message.fwdFrom;
    const source = forwarded?.savedFromPeer && forwarded.savedFromMsgId
        ? forwarded.savedFromPeer : forwarded?.fromId;
    const messageId = forwarded?.savedFromPeer && forwarded.savedFromMsgId
        ? forwarded.savedFromMsgId : forwarded?.channelPost;
    if (source && messageId) {
        onPooled?.();
        return withTelegramAccount(sourceKeyForDownloadRef(source), 'download', async (client, accountId) => {
            if (taskId) downloadQueue.resetProgress(taskId);
            const visible = await getTelegramForwardedMessage(botClient, client, message);
            if (!visible?.media) throw new Error('消息不存在或不包含可下载媒体');
            await markTelegramAccountSourceAccess(accountId, sourceKeyForDownloadRef(source), 'download', 'allowed');
            return downloadAndSaveFile(client, visible, fileName, targetDir, onProgress, signal, groupId);
        }, { signal, onDownloadRetry: event => { if (taskId) downloadQueue.setRetrying(taskId, event.attempt, event.maxAttempts, `下载重试 ${event.attempt}/${event.maxAttempts}：${event.error}`); } });
    }
    // Direct Bot messages have Bot-specific message IDs and cannot be re-read by user accounts.
    return downloadAndSaveFile(botClient, message, fileName, targetDir, onProgress, signal, groupId);
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


async function waitForDiskWatermark(requiredBytes: number, reservationId: string, directory: string, signal?: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const blockerId = crypto.randomUUID();
    let announcedPause = false;

    try {
        while (true) {
            if (signal?.aborted) throw new Error('下载任务已停止');
            const { availableBytes, ok } = await diskReservations.reserve(reservationId, directory, requiredBytes, TG_MIN_FREE_DISK_BYTES);
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
    client = botDownloadRuntime.active(client);
    if (isInteractiveProgressCard(chatId.toString(), Number(params.message))) return null;
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

const silentNoticePromiseMap = new Map<string, Promise<any>>();
const silentProgressEdits = new Map<string, Promise<unknown>>();

async function ensureSilentNotice(client: TelegramClient, chatId: Api.TypeEntityLike, fileCount: number, replyToMsg?: Api.Message) {
    client = botDownloadRuntime.active(client);
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
        const owner = message.client;
        const activeClient = owner ? botDownloadRuntime.active(owner) : undefined;
        const result = activeClient && activeClient !== owner
            ? await activeClient.sendMessage(await message.getInputChat() || message.chatId!, { ...params, replyTo: message.id })
            : await message.reply(params);
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

const ordinaryTaskPersistedAt = new Map<string, { at: number; state: DownloadTaskGroupSnapshot['state']; completed: number; failed: number; cancelled: number; total: number }>();
const singleTaskCardRefreshers = new Map<string, () => Promise<void>>();
async function admitOrdinaryTransferTask(input: DownloadTaskGroupInput): Promise<void> {
    const now = Date.now();
    const snapshot: DownloadTaskGroupSnapshot = {
        ...input,
        state: 'waiting',
        total: Math.max(0, input.expectedTotal || 0),
        active: 0,
        downloading: 0,
        uploading: 0,
        waitingUpload: 0,
        retrying: 0,
        stage: 'waiting',
        pending: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        createdAt: now,
        updatedAt: now,
    };
    if (!input.targetAccountId) {
        await persistOrdinaryTransferTask(snapshot);
        return;
    }
    const client = await pool.connect();
    let lease: Awaited<ReturnType<typeof acquireStorageAccountOperationLease>> | null = null;
    try {
        await client.query('BEGIN');
        const account = await lockStorageAccountForUse(client, input.targetAccountId);
        if (account.type !== input.targetProvider) throw new Error('普通 Bot 任务目标账户与 provider 不匹配');
        lease = await acquireStorageAccountOperationLease(pool, input.targetAccountId, 'telegram_bot_admission');
        await client.query('COMMIT');
        await persistOrdinaryTransferTask(snapshot);
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
        await lease?.release();
    }
}
const downloadQueue = new DownloadTaskQueue({
    maxConcurrent: normalizeFileDownloadConcurrency(process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY),
    onGroupChanged: async group => {
        if (group.hidden) return;
        const now = Date.now();
        const previous = ordinaryTaskPersistedAt.get(group.id);
        if (!previous || previous.state !== group.state) {
            void singleTaskCardRefreshers.get(group.id)?.().catch(error => {
                console.error('🤖 单文件任务状态卡刷新失败:', error);
            });
        }
        const changed = !previous || previous.state !== group.state || previous.completed !== group.completed
            || previous.failed !== group.failed || previous.cancelled !== group.cancelled || previous.total !== group.total;
        if (!changed && now - previous.at < 1_000) return;
        await persistOrdinaryTransferTask(group);
        ordinaryTaskPersistedAt.set(group.id, { at: now, state: group.state, completed: group.completed,
            failed: group.failed, cancelled: group.cancelled, total: group.total });
    },
});
registerFileConcurrencyRuntime(value => {
    downloadQueue.setMaxConcurrent(value);
    process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY = String(value);
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
    groupIds?: Set<string>;
    jobIds?: Set<string>;
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
    const existing = taskIdControlScopes.get(taskId);
    if (existing && (existing.chatId !== chatId || (existing.userId !== undefined && userId !== undefined && existing.userId !== userId))) {
        throw new Error('任务控制作用域不匹配');
    }
    taskIdToChatId.set(taskId, chatId);
    taskIdControlScopes.set(taskId, { ...existing, chatId, userId: userId ?? existing?.userId });
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

export function getTaskControlJobIds(taskId: string, chatId: string, userId: number): string[] {
    if (!canControlTask(taskId, chatId, userId)) return [];
    return Array.from(taskIdControlScopes.get(taskId.trim())?.jobIds || []);
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
    client = botDownloadRuntime.active(client);
    const chatIdStr = chatId.toString();
    if (!silentSessionMap.has(chatIdStr)) return;

    const outstanding = getOutstandingTaskCount(chatIdStr);
    if (outstanding > 0) return;

    // 全部完成：退出静默模式
    const s = silentSessionMap.get(chatIdStr);
    const scope = s ? taskIdControlScopes.get(s.taskId) : undefined;
    if (s?.failed && scope?.userId !== undefined) {
        await saveTaskReceipt({
            id: s.taskId, chatId: chatIdStr, userId: scope.userId,
            jobIds: [...(scope.jobIds || [])], groupIds: [...(scope.groupIds || [])],
            failures: downloadQueue.getDetailedStatus().history
                .filter(task => task.status === 'failed' && scope.groupIds?.has(task.groupId))
                .map(task => `${task.fileName}: ${task.error || '下载失败'}`),
        });
    }
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
                const buttons = buildTaskControlButtons(s?.taskId, queueStats.paused, queueStats.systemPause, false, queueStats.userPaused, s?.failed || 0);
                if (buttons) buttons.rows = buttons.rows.slice(1);
                return buttons;
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
            syncSilentSessionTotals(chatIdStr);
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
    client = botDownloadRuntime.active(client);
    if (!chatId) return;
    const chatIdStr = chatId.toString();
    const lastMsgId = lastStatusMessageIdMap.get(chatIdStr);
    if (lastMsgId && isInteractiveProgressCard(chatIdStr, lastMsgId)) {
        lastStatusMessageIdMap.delete(chatIdStr);
        return;
    }
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
    groupId?: string;
    speedBytesPerSecond?: number;
    size?: number;
    error?: string;
    providerName?: string;
    fileType?: string;
    folder?: string | null;
    storageLabel?: string;
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

async function describeStorageTarget(target: StorageTargetSnapshot): Promise<string> {
    if (!target.accountId) return target.provider.name === 'local' ? '本地存储（服务器）' : target.provider.name;
    const result = await query('SELECT name FROM storage_accounts WHERE id = $1', [target.accountId]);
    return `${String(result.rows[0]?.name || '未命名账户')}（${getProviderDisplayName(target.provider.name)} · ${target.accountId.slice(0, 8)}）`;
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
        const taskId = getSessionTaskId(chatId);
        const scope = taskId ? taskIdControlScopes.get(taskId) : undefined;
        if (scope && batch.groupId) (scope.groupIds ??= new Set()).add(batch.groupId);
    }

    const files = getConsolidatedFiles(chatId);
    for (const file of files) {
        const key = `file:${file.id || file.fileName}`;
        updateTaskCount(session, key, 1);
        const sessionId = getSessionTaskId(chatId);
        const scope = sessionId ? taskIdControlScopes.get(sessionId) : undefined;
        const groupId = file.id ? chatActiveUploads.get(chatId)?.get(file.id)?.groupId : undefined;
        if (scope && groupId) (scope.groupIds ??= new Set()).add(groupId);
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
    return Array.from(map.values(), file => {
        const group = file.groupId ? downloadQueue.getGroup(file.groupId, {}, true) : undefined;
        if (!group || ['success', 'failed', 'cancelled'].includes(file.phase)) return file;
        const paused = ['paused', 'pausing'].includes(group.state);
        const progress = downloadProgressView(group, group.state === 'running', 0);
        return { ...file, paused, downloaded: progress.completedBytes, total: progress.totalBytes,
            speedBytesPerSecond: progress.speedBytesPerSecond };
    });
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
    return Array.from(map.values(), batch => {
        const group = batch.groupId ? downloadQueue.getGroup(batch.groupId, {}, true) : undefined;
        if (!group) return batch;
        const paused = ['paused', 'pausing'].includes(group.state);
        return { ...batch, paused, downloadProgress: downloadProgressView(group, group.state === 'running', batch.totalFiles > 0 ? batch.completed / batch.totalFiles * 100 : 0) };
    });
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

export async function refreshSilentProgress(client: TelegramClient, chatId: Api.TypeEntityLike, userId?: number) {
    const chatIdStr = chatId instanceof Api.PeerUser || chatId instanceof Api.PeerChat || chatId instanceof Api.PeerChannel
        ? telegramChatKeyFromPeerParts(chatId)
        : chatId.toString();
    if (!silentSessionMap.has(chatIdStr)) return;
    const silentMsgId = silentNoticeMessageIdMap.get(chatIdStr);
    if (!silentMsgId) return;

    const session = syncSilentSessionTotals(chatIdStr) || getSilentSession(chatIdStr);
    const previousEdit = silentProgressEdits.get(chatIdStr);
    const edit = (async () => {
        await previousEdit;
        if (silentSessionMap.get(chatIdStr) !== session) return;
        syncSilentSessionTotals(chatIdStr);
        const batches = getConsolidatedBatches(chatIdStr);
        const files = getConsolidatedFiles(chatIdStr);
        const totalBatchFiles = batches.reduce((sum, batch) => sum + batch.totalFiles, 0);
        const completedBatchFiles = batches.reduce((sum, batch) => sum + batch.completed, 0);
        const completedSingleFiles = files.filter(file => file.phase === 'success' || file.phase === 'failed').length;
        const totalFiles = Math.max(session.total, totalBatchFiles + files.length, completedBatchFiles + completedSingleFiles, session.completed);
        const completedFiles = Math.max(session.completed, completedBatchFiles + completedSingleFiles);
        const isComplete = totalFiles > 0 && completedFiles >= totalFiles;
        const ownerId = userId ?? taskIdControlScopes.get(session.taskId)?.userId;
        const cardState = getDownloadTaskCardState(chatIdStr, ownerId);
        const cardPaused = cardState.paused;
        const cardPausing = !cardPaused && cardState.pausing;
        const text = buildSilentProgress(
            session.total, batches, files, session.completed, session.failed, session.taskId,
            cardPaused, cardState.reason, cardPausing, cardState.systemPause,
        );
        const buttons = isComplete && session.failed === 0
            ? undefined
            : buildTaskControlButtons(session.taskId, cardPaused, cardState.systemPause, cardPausing, cardState.userPaused, session.failed);
        await safeEditMessage(client, chatIdStr, { message: silentMsgId, text, buttons });
    })();
    silentProgressEdits.set(chatIdStr, edit);
    try {
        await edit;
    } finally {
        if (silentProgressEdits.get(chatIdStr) === edit) silentProgressEdits.delete(chatIdStr);
    }
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

/** Refresh the existing live tracker after an authenticated resume callback. */
export async function refreshDownloadProgress(client: TelegramClient, chatId: Api.TypeEntityLike, userId: number) {
    const key = chatId instanceof Api.PeerUser || chatId instanceof Api.PeerChat || chatId instanceof Api.PeerChannel
        ? telegramChatKeyFromPeerParts(chatId) : chatId.toString();
    const messageId = lastStatusMessageIdMap.get(key);
    const owner = messageId ? taskCenterCardOwners.get(taskCenterCardKey(key, messageId)) : undefined;
    if (owner?.userId !== userId) return;
    if (silentSessionMap.has(key)) await refreshSilentProgress(client, key, userId);
    else {
        const groups = listDownloadTaskGroups(key, userId);
        const refresh = groups.length === 1 ? singleTaskCardRefreshers.get(groups[0].id) : undefined;
        if (refresh) await refresh();
        else await refreshConsolidatedMessage(client, key);
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
    const ownerId = replyTo?.senderId?.toJSNumber()
        ?? (existingMsgId ? taskCenterCardOwners.get(taskCenterCardKey(chatIdStr, existingMsgId))?.userId : undefined);
    const locale = ownerId === undefined ? DEFAULT_LOCALE : await getTelegramUserLocaleOrDefault(ownerId);
    const items = ownerId === undefined ? [] : listDownloadTaskGroups(chatIdStr, ownerId)
        .map(group => ordinaryTaskCenterItem(group, locale)).filter((item): item is TaskCenterItem => Boolean(item));
    const buttons = buildProgressControlButtons(items, locale);

    // 新任务触发（有 replyTo）：强制删除旧追踪器，并发送一条新的追踪器消息
    if (replyTo) {
        await deleteLastStatusMessage(client, chatId);
        const msg = await safeReply(replyTo, { message: text, buttons }) as Api.Message;
        if (msg) {
            updateLastStatusMessageId(chatId, msg.id, false);
            if (ownerId !== undefined) registerProgressCard(chatIdStr, msg.id, ownerId);
        }
        return;
    }

    // 进度更新触发（无 replyTo）：编辑现有追踪器
    if (existingMsgId && !isInteractiveProgressCard(chatIdStr, existingMsgId)) {
        await safeEditMessage(client, chatId, { message: existingMsgId, text, buttons });
    }
}

// 导出获取队列统计信息的函数
export function getDownloadQueueStats() {
    return downloadQueue.getStats();
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
    const state = mergeTaskCardPauseState(queueStats.paused, queueStats.pauseReason, scopeStatus, queueStats.systemPause, queueStats.userPaused);
    const hasRunningGroup = downloadQueue.getSnapshot({ chatId, userId }).groups.some(group => group.state === 'running');
    return hasRunningGroup && !queueStats.paused
        ? { ...state, paused: false, pausing: false, reason: undefined }
        : state;
}

export function getDownloadTaskGroup(groupId: string, chatId?: string, userId?: number) {
    return downloadQueue.getGroup(groupId, { chatId, userId });
}

export function getDownloadTaskSnapshot(groupId: string, chatId?: string, userId?: number) {
    return downloadQueue.getGroupSnapshot(groupId, { chatId, userId });
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

export async function cancelSilentTask(client: TelegramClient, chatId: Api.TypeEntityLike, taskId: string, fallbackMessageId?: number, userId?: number, locale: TelegramLocale = DEFAULT_LOCALE) {
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

    silentSessionMap.delete(chatIdStr);
    removeTaskControlScope(session?.taskId);
    removeTaskControlScope(taskId);
    silentNoticeMessageIdMap.delete(chatIdStr);
    lastSilentNotificationTimeMap.delete(chatIdStr);
    clearConsolidatedState(chatIdStr);
    resetChatTransferSession(chatIdStr);
    // Drain any edit already sent before publishing the terminal cancellation card.
    await silentProgressEdits.get(chatIdStr);

    if (silentMsgId) {
        const text = [
            t(locale, 'upload.taskCancelled.title'),
            ``,
            t(locale, 'upload.taskCancelled.id', { taskId }),
            t(locale, 'upload.taskCancelled.completed', { count: completed }),
            ...(failed > 0 ? [t(locale, 'upload.taskCancelled.failed', { count: failed })] : []),
            t(locale, 'upload.taskCancelled.stopped', { count: pendingOrActive }),
            ``,
            t(locale, 'upload.taskCancelled.controlsRemoved'),
        ].join('\n');
        await safeEditMessage(client, editChatId, { message: silentMsgId, text, buttons: undefined });
    }


    return result;
}

export function listFailedDownloadTaskDetails(taskId: string, chatId: string, userId: number, locale: TelegramLocale = DEFAULT_LOCALE): string[] {
    if (!canControlTask(taskId, chatId, userId)) return [];
    const files = getConsolidatedFiles(chatId)
        .filter(file => file.phase === 'failed')
        .map(file => `${file.fileName}: ${file.error || t(locale, 'upload.error.unknown')}`);
    const batches = getConsolidatedBatches(chatId)
        .filter(batch => batch.failed > 0)
        .map(batch => t(locale, 'upload.failedDetail.batch', { name: batch.folderPath || batch.folderName, count: batch.failed }));
    return [...files, ...batches];
}

export async function retryFailedDownloadTasks(limit = 10, taskId?: string, chatId?: string, userId?: number) {
    const receipt = taskId && userId !== undefined ? await getTaskReceipt(taskId, userId) : null;
    if (receipt) {
        if (chatId !== receipt.chatId) return { retried: 0 };
        let retried = 0;
        for (const jobId of receipt.jobIds) {
            const result = await retryTelegramBackgroundJob(receipt.userId, jobId, receipt.chatId);
            retried += Number(result?.retried || 0);
        }
        for (const groupId of receipt.groupIds) {
            if (retried >= limit) break;
            retried += (await downloadQueue.retryFailed(limit - retried, { chatId, userId }, groupId)).retried;
        }
        return { retried };
    }
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
    storageTarget?: StorageTargetSnapshot;
    leaseSettled?: boolean;
    withLease?: <T>(operation: () => Promise<T>) => Promise<T>;
    persistentRef?: TelegramDownloadMessageRef;
    discussion?: { source: string; postId: number };
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
const mediaGroupQueueCreations = new Map<string, Promise<MediaGroupQueue>>();

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
    groupId?: string,
): Promise<{ filePath: string; actualSize: number; tempStoredName: string } | null> {
    const botTransfer = botDownloadRuntime.isManaged(client);
    if (botTransfer) {
        const next = await botDownloadRuntime.acquire(client, signal);
        if (next !== client) message = await refreshTelegramDownloadMessage(next, message);
        client = next;
    }
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
    protectTemporaryUploadFile(filePath);
    const totalSize = getEstimatedFileSize(message);
    let downloadedSize = 0;
    const beforeRead = async (readSignal = signal) => {
        while (groupId) {
            readSignal?.throwIfAborted();
            const group = downloadQueue.getGroup(groupId, {}, true);
            if (!group || !['paused', 'pausing'].includes(group.state)) return;
            await waitForDownload(100, undefined, { signal: readSignal });
        }
    };

    try {
        if (signal?.aborted) throw new Error('下载任务已停止');
        await beforeRead();
        await waitForDiskWatermark(totalSize || 64 * 1024 ** 2, filePath, saveDir, signal);
        const configuredWorkers = await getTelegramDownloadWorkers();
        let media = getDownloadableMedia(message);
        if (!media) {
            throw new Error('该图文消息未包含可下载媒体');
        }
        let refreshFlight: Promise<void> | undefined;
        const recoverBotDownload = botTransfer ? async (_error: unknown, _offset: number, _attempt: number, recoverySignal = signal) => {
            if (!refreshFlight) {
                const flight = (async () => {
                    const next = await botDownloadRuntime.acquire(client, recoverySignal);
                    if (next === client) return;
                    message = await refreshTelegramDownloadMessage(next, message);
                    client = next;
                    media = getDownloadableMedia(message);
                })();
                refreshFlight = flight;
                void flight.finally(() => { if (refreshFlight === flight) refreshFlight = undefined; }).catch(() => undefined);
            }
            await refreshFlight;
        } : undefined;
        const isPhotoMedia = isTelegramPhotoMedia(media);
        const workers = !isPhotoMedia && totalSize > TELEGRAM_DOWNLOAD_PART_SIZE
            ? Math.min(configuredWorkers, Math.ceil(totalSize / TELEGRAM_DOWNLOAD_PART_SIZE))
            : 1;
        console.log(`🤖 Telegram 下载参数: workers=${workers}, request=${isPhotoMedia ? 'sdk' : TELEGRAM_DOWNLOAD_PART_SIZE}, chunk=${isPhotoMedia ? 'sdk' : TELEGRAM_DOWNLOAD_PART_SIZE}, size=${totalSize || 'unknown'}, photo=${isPhotoMedia}`);
        const openDownload = (params: Parameters<typeof createTelegramDownloadIterator>[1]) => client instanceof TelegramUserWorkerClient
            ? client.iterDownload(params) : createTelegramDownloadIterator(client, params);

        if (isPhotoMedia) {
            let photoRetries = 0;
            while (true) {
                try {
                    const downloaded = await withTelegramOperationSignal(signal, () => client.downloadMedia(message, {
                        outputFile: filePath,
                        progressCallback: async (downloaded, total) => {
                            if (signal?.aborted) throw new Error('下载任务已停止');
                            await beforeRead();
                            onProgress?.(Number(downloaded), Number(total));
                            diskReservations.commit(filePath, Math.max(0, Number(downloaded) - downloadedSize));
                            downloadedSize = Number(downloaded);
                        },
                    }));
                    if (!downloaded || !fs.existsSync(filePath)) throw new Error('Telegram 图片下载未生成文件');
                    break;
                } catch (error) {
                    signal?.throwIfAborted();
                    const code = error instanceof Error ? error.message : String(error);
                    if (!recoverBotDownload || !['BOT_CONNECTION_LOST','BOT_DC_CONNECTION_LOST','BOT_CANCELLED'].includes(code) || photoRetries >= 3) throw error;
                    await waitForDownload(300 * 2 ** photoRetries++, undefined, { signal });
                    await recoverBotDownload(error, 0, photoRetries);
                }
            }
        } else if (workers > 1 && totalSize > 0) {
            const fileHandle = await fs.promises.open(filePath, 'w');
            try {
                await fileHandle.truncate(totalSize);

                await runTelegramDownloadStripes(workers, async (workerIndex, stripeSignal) => {
                    let writeOffset = workerIndex * TELEGRAM_DOWNLOAD_PART_SIZE;
                    for await (const chunk of telegramDownloadStream(offset => openDownload({
                        file: media,
                        offset: bigInt(offset),
                        stride: TELEGRAM_DOWNLOAD_PART_SIZE * workers,
                        chunkSize: TELEGRAM_DOWNLOAD_PART_SIZE,
                        requestSize: TELEGRAM_DOWNLOAD_PART_SIZE,
                        fileSize: bigInt(totalSize),
                    }), { offset: writeOffset, stride: TELEGRAM_DOWNLOAD_PART_SIZE * workers, end: totalSize, signal: stripeSignal, beforeRead: () => beforeRead(stripeSignal), recover: recoverBotDownload })) {
                        stripeSignal.throwIfAborted();
                        if (writeOffset >= totalSize) break;
                        const bytesToWrite = Math.min(chunk.length, totalSize - writeOffset);
                        if (bytesToWrite > 0) {
                            await writeTelegramDownloadChunk(fileHandle, chunk, bytesToWrite, writeOffset, stripeSignal);
                            downloadedSize += bytesToWrite;
                            diskReservations.commit(filePath, bytesToWrite);
                            if (onProgress) {
                                onProgress(Math.min(downloadedSize, totalSize), totalSize);
                            }
                        }
                        writeOffset += TELEGRAM_DOWNLOAD_PART_SIZE * workers;
                    }
                }, signal);
            } finally {
                await fileHandle.close();
            }
        } else {
            const fileHandle = await fs.promises.open(filePath, 'w');
            try {
                for await (const chunk of telegramDownloadStream(offset => openDownload({ file: media, offset: bigInt(offset), requestSize: TELEGRAM_DOWNLOAD_PART_SIZE }), { offset: 0, end: totalSize || undefined, signal, beforeRead, recover: recoverBotDownload })) {
                    if (signal?.aborted) throw new Error('下载任务已停止');
                    await fileHandle.writeFile(chunk);
                    downloadedSize += chunk.length;
                    diskReservations.commit(filePath, chunk.length);
                    if (onProgress && totalSize > 0) onProgress(downloadedSize, totalSize);
                }
            } finally {
                await fileHandle.close();
            }
        }

        const stats = fs.statSync(filePath);
        if (totalSize > 0 && (stats.size !== totalSize || (!isTelegramPhotoMedia(getDownloadableMedia(message)) && downloadedSize !== totalSize))) {
            throw new Error(`下载文件大小不一致: expected=${totalSize}, actual=${stats.size}`);
        }
        return { filePath, actualSize: stats.size, tempStoredName };
    } catch (error) {
        console.error('🤖 下载文件失败:', error);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        throw error;
    } finally {
        diskReservations.release(filePath);
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
    let retryDownload = false;
    const ordinary = !file.persistentRef && Boolean(groupId);

    const attemptUpload = (signal?: AbortSignal, reportProgress?: (downloaded: number, total: number) => void, taskId?: string): Promise<boolean> => withTemporaryUploadFiles(async () => {
        let localFilePath: string | undefined;
        let storedName: string | undefined; // This will hold the unique name for final storage
        let pooledDownload = Boolean(file.persistentRef);
        let sourceDownloaded = false;
        let readingSource = false;

        try {
            if (ordinary) await updateOrdinaryFile(groupId!, file.message.id, { status: 'downloading' });
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
                    : await resolveTelegramStorageFolderPersistent(chatIdForPath, automaticFolder);

            readingSource = true;
            const result = file.persistentRef
                ? await withTelegramAccount(sourceKeyForDownloadRef(file.persistentRef.source || ''), 'download', async (downloadClient, accountId) => {
                    if (taskId) downloadQueue.resetProgress(taskId);
                    const ref = file.persistentRef!;
                    const attemptId = await startTelegramDownloadAttempt({ accountId, sourceKey: sourceKeyForDownloadRef(ref.source || ''), jobId: ref.jobId || null, itemId: ref.itemId || null, leaseToken: ref.leaseToken || null });
                    try {
                        const [message] = file.discussion
                            ? await getTelegramDiscussionMessagesWithAccess(downloadClient, ref.source || '', { ids: [ref.id] }, file.discussion)
                            : await getTelegramMessagesWithAccess(downloadClient, ref.source || '', { ids: [ref.id] });
                        if (!message) throw new Error('消息不存在或无法重新读取');
                        const downloaded = await downloadAndSaveFile(downloadClient, message, file.fileName, file.targetDir, reportProgress, signal, groupId);
                        await finishTelegramDownloadAttempt(attemptId, 'succeeded');
                        return downloaded;
                    } catch (error) {
                        await finishTelegramDownloadAttempt(attemptId, 'failed', error instanceof Error ? error.message : String(error));
                        throw error;
                    }
                }, { signal, onDownloadRetry: event => { if (taskId) downloadQueue.setRetrying(taskId, event.attempt, event.maxAttempts, `下载重试 ${event.attempt}/${event.maxAttempts}：${event.error}`); } })
                : await downloadIncomingTelegramFile(client, file.message, file.fileName, file.targetDir, reportProgress, signal, groupId, taskId, () => { pooledDownload = true; });
            if (!result) {
                file.error = '下载失败';
                return false;
            }

            localFilePath = result.filePath;
            sourceDownloaded = true;
            readingSource = false;
            retryDownload = false;
            if (taskId) await downloadQueue.beginUpload(taskId);
            const actualSize = result.actualSize;
            if (file.persistentRef) file.persistentRef.totalSize = actualSize;
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
                        if (batchId) updateBatch(chatIdStr, batchId, { folderPath: storageFolder || '/', providerName: provider.name });
                        rememberTransferDestination(chatIdStr, storageFolder || '/', await describeStorageTarget(storageTarget));
                    }
                    if (localFilePath && fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
                    return true;
                }
            }

            if (signal?.aborted) throw new Error('下载任务已停止');
            storedName = await getUniqueStoredName(file.fileName, storageFolder, activeAccountId);
            
            // 生成缩略图和获取尺寸。方案A：只在本地存储生成；第三方存储不生成本地缩略图。
            let thumbnailPath: string | null = null;
            let dimensions: { width?: number; height?: number } = {};
            if (provider.name === 'local' && (file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/'))) {
                try {
                    thumbnailPath = await generateThumbnail(localFilePath!, storedName, file.mimeType, signal);
                    dimensions = await getImageDimensions(localFilePath!, file.mimeType, signal);
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
            // Storage failures must not restart Telegram or create another unresolved write.
            retryDownload = false;
            const save = async (): Promise<TelegramPersistedWrite> => {
                const persistentRef = file.persistentRef;
                signal?.throwIfAborted();
                const preparedWrite = await provider.prepareSaveFile?.(localFilePath!, storedName!, file.mimeType, storageFolder);
                signal?.throwIfAborted();
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
                        storedPath: preparedWrite?.storedPath,
                    });
                    persistentRef.writeOperationId = operationId;
                }
                try {
                    signal?.throwIfAborted();
                    if (ordinary) await updateOrdinaryFile(groupId!, file.message.id, { status: 'saving', storedPath: preparedWrite?.storedPath, storedName });
                    savedPath = preparedWrite
                        ? await preparedWrite.save(signal)
                        : await provider.saveFile(localFilePath!, storedName!, file.mimeType, storageFolder, { signal });
                    finalPath = savedPath;
                    if (operationId) await markTelegramWriteObjectPresent(pool, operationId, savedPath);
                    const insertSql = `INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`;
                    const values = [file.fileName, storedName, fileType, file.mimeType, actualSize, savedPath, thumbnailPath, dimensions.width, dimensions.height, sourceRef, storageFolder, activeAccountId];
                    indexedFileId = ordinary ? await indexOrdinaryFile(groupId!, file.message.id, insertSql, values)
                        : String((await query(insertSql, values)).rows[0].id);
                    indexState = 'present';
                    if (operationId) await markTelegramWriteIndexPresent(pool, operationId, indexedFileId);
                    return { savedPath: finalPath, fileId: indexedFileId };
                } catch (error) {
                    if (!operationId) throw error;
                    let objectState: 'unknown' | 'deleted' = 'unknown';
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
                    const originalMessage = error instanceof Error ? error.message : String(error);
                    try {
                        await updateTelegramWriteAfterCompensation(pool, operationId, {
                            objectState, indexState: compensatedIndexState,
                            reason: `保存失败: ${originalMessage}${errors.length ? `; 补偿失败: ${errors.join('; ')}` : ''}`,
                        });
                    } catch (journalError) {
                        console.error('Telegram write journal 保存失败证据更新失败:', journalError);
                    }
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
                if (batchId) updateBatch(chatIdStr, batchId, { folderPath: storageFolder || '/', providerName: provider.name });
                rememberTransferDestination(chatIdStr, storageFolder || '/', await describeStorageTarget(storageTarget));
            }
            return true;

        } catch (error) {
            if ((error as Error)?.name === 'TelegramDownloadLeaseLostError') throw error;
            console.error('🤖 文件上传失败:', error);
            retryDownload = readingSource && !pooledDownload && !sourceDownloaded && isTelegramTransientDownloadError(error);
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
    });

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
            if (taskId) downloadQueue.resetProgress(taskId);
            const firstAttemptSuccess = await attemptUpload(signal, reportProgress, taskId);
            if (taskId) downloadQueue.stopProgress(taskId);

            if (!firstAttemptSuccess && retryDownload && !signal.aborted && !file.retried && !file.storageCooldownUntil) {
                file.retried = true;
                file.status = 'uploading'; // 保持 uploading 状态供外部显示
                const originalError = file.error;
                if (taskId) downloadQueue.resetProgress(taskId);
                const secondAttemptSuccess = await attemptUpload(signal, reportProgress, taskId);
                if (taskId) downloadQueue.stopProgress(taskId);
                file.error = secondAttemptSuccess ? undefined : originalError || file.error;
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
            if (ordinary) await updateOrdinaryFile(groupId!, file.message.id, {
                status: signal.aborted ? 'cancelled' : file.status === 'success' ? 'success' : 'failed', error: file.error });
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
    const onPendingCancelled = async () => {
        file.status = 'failed';
        file.error = '用户取消任务';
        if (ordinary) await updateOrdinaryFile(groupId!, file.message.id, { status: 'cancelled', error: file.error });
    };
    return downloadQueue.add(groupId, taskDisplayName, queueTask, file.size || getEstimatedFileSize(file.message), onPendingCancelled);
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
    const initialAlbumGroup: DownloadTaskGroupInput = {
        id: groupId,
        kind: 'album',
        title: folderName,
        chatId: chatId.toString(),
        userId: queue.userId || firstMessage.senderId?.toJSNumber(),
        targetProvider: queue.storageTarget.provider.name,
        targetAccountId: queue.storageTarget.accountId,
        targetFolder: queue.storageFolder,
        expectedTotal: snapshot.length,
    };
    await admitOrdinaryTransferTask(initialAlbumGroup);
    downloadQueue.ensureGroup(initialAlbumGroup);
    const sharedCaption = mediaGroupCaption;
    for (const file of snapshot) {
        file.sharedCaption = sharedCaption;
    }

    // 新会话重置检查
    await checkAndResetSession(batchClient, chatId);

    // 注册批量任务到追踪器
    const storageLabel = await describeStorageTarget(queue.storageTarget);
    registerBatch(chatId.toString(), batchId, {
        id: batchId,
        groupId,
        folderName,
        folderPath: undefined,
        totalFiles: snapshot.length,
        completed: 0,
        successful: 0,
        failed: 0,
        providerName: queue.storageTarget.provider.name,
        storageLabel,
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
        const storageFolder = await resolveTelegramStorageFolderPersistent(chatId.toString(), automaticPreview);
        queue.storageFolder = storageFolder;
        await updateTransferTask('telegram_bot', groupId, { targetFolder: storageFolder });
        downloadQueue.ensureGroup({
            id: groupId,
            kind: 'album',
            title: queue.folderName || folderName,
            chatId: chatId.toString(),
            userId: queue.userId || firstMessage.senderId?.toJSNumber(),
            targetProvider: queue.storageTarget.provider.name,
            targetAccountId: queue.storageTarget.accountId,
            targetFolder: storageFolder,
            expectedTotal: snapshot.length,
        });
        const folderPreview = storageFolder;
        updateBatch(chatId.toString(), batchId, { folderName: queue.folderName, folderPath: folderPreview || '/', storageLabel });
        queue.folderPath = folderPreview || undefined;
        rememberTransferDestination(chatId.toString(), folderPreview || '/', storageLabel);
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
            savedBytes: queue.files.filter(file => file.status === 'success').reduce((sum, file) => sum + (file.size || 0), 0),
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

export async function handleCleanupCallback(cleanupId: string, locale: TelegramLocale = DEFAULT_LOCALE): Promise<{ success: boolean; message: string }> {
    const cleanupInfo = pendingCleanups.get(cleanupId);
    if (!cleanupInfo) {
        return { success: false, message: t(locale, 'upload.cleanup.expired') };
    }

    try {
        if (cleanupInfo.localPath && fs.existsSync(cleanupInfo.localPath)) {
            fs.unlinkSync(cleanupInfo.localPath);
        }
        pendingCleanups.delete(cleanupId);
        return {
            success: true,
            message: t(locale, 'upload.cleanup.success', { fileName: cleanupInfo.fileName, size: formatLocalizedBytes(cleanupInfo.size, locale) })
        };
    } catch (error) {
        console.error('🤖 清理垃圾缓存失败:', error);
        return { success: false, message: t(locale, 'upload.cleanup.failed', { error: (error as Error).message }) };
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
        const storageFolder = await previewTelegramStorageFolderPersistent(message.chatId?.toString() || 'unknown', automaticFolder);
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
    if (typeof source === 'object' && source !== null) {
        const id = 'channelId' in source ? source.channelId
            : 'chatId' in source ? source.chatId
                : 'userId' in source ? source.userId
                    : 'id' in source ? source.id : undefined;
        if (id !== undefined && id !== null) return String(id);
    }
    return String(source);
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
    onItemSettled?: (item: TelegramDownloadMessageRef, status: 'success' | 'failed' | 'skipped', error?: string, alreadySettled?: boolean) => Promise<void> | void,
    executionGroupKey?: string,
    getExecutionControlState?: () => Promise<'run' | 'paused' | 'cooldown' | 'cancelled'>,
    taskSignal?: AbortSignal,
    ownerUserId?: number,
    storageTarget: StorageTargetSnapshot = storageManager.getActiveTarget(),
    withItemLease?: <T>(ref: TelegramDownloadMessageRef, operation: () => Promise<T>) => Promise<T>,
    loadMoreRefs?: (limit: number) => Promise<TelegramDownloadMessageRef[]>,
): Promise<{ requested: number; found: number; skipped: number; failed: number; successful: number; successfulMessageIds: number[]; failedMessageIds: number[]; skippedMessageIds: number[]; firstId: number; lastId: number }> {
    const userClient = botClient;
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

    const appendExplicitRefs = async (refs: TelegramDownloadMessageRef[]) => {
        for (const ref of refs) {
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
    };
    if (normalizedExplicitRefs) {
        await appendExplicitRefs(normalizedExplicitRefs);
    } else {
        for (let offset = 0; offset < ids.length; offset += TG_LARGE_TASK_SEGMENT_SIZE) {
            const scanIds = ids.slice(offset, offset + TG_LARGE_TASK_SEGMENT_SIZE);
            const scanMessages = await withTelegramAccount(String(source), 'metadata', client => getTelegramMessagesWithAccess(client, sourceEntity, { ids: scanIds }), { signal: taskSignal });
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
            const firstMessage = (await withTelegramAccount(firstRef.sourceKey, 'metadata', client =>
                firstRef.origin === 'comment' && firstRef.channelPostId
                    ? getTelegramDiscussionMessagesWithAccess(client, firstRef.sourceEntity, { ids: [firstRef.id] }, { source: sourceEntity, postId: firstRef.channelPostId })
                    : getTelegramMessagesWithAccess(client, firstRef.sourceEntity, { ids: [firstRef.id] }), { signal: taskSignal }))[0];
            if (firstMessage) {
                const chatName = await getTelegramChatName(firstMessage);
                const storageRules = await getStoragePathRules();
                const automaticPreview = buildStorageFolderWithRules({
                    source: 'telegram',
                    chatName,
                    mimeType: firstRef.fileInfo.mimeType,
                    fileName: firstRef.fileInfo.fileName,
                }, storageRules);
                taskResolvedStorageFolder = (await resolveTelegramTaskStorageFolderPersistent(chatIdStr, automaticPreview)).folder;
            }
        }
        if (!executionGroupKey) {
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
            const sessionId = getSessionTaskId(chatIdStr);
            const scope = sessionId ? taskIdControlScopes.get(sessionId) : undefined;
            if (scope) (scope.groupIds ??= new Set()).add(channelGroupId);
            await refreshConsolidatedMessage(botClient, chatId, requestMessage);
        }
    }

    let completed = 0;
    let successful = 0;
    let failed = 0;
    let lastStatusRefresh = 0;

    const refreshSegmentStatus = async (force = false, currentFileName?: string) => {
        if (executionGroupKey) return;
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

    const windowSize = Math.max(1, Math.min(downloadableRefs.length, TG_LARGE_TASK_SEGMENT_SIZE));
    let nextRef = 0;
    await runRollingDownloadWindow(windowSize, async capacity => {
        taskSignal?.throwIfAborted();
        const controlState = await getExecutionControlState?.();
        if (controlState && controlState !== 'run') return [];
        if (nextRef >= downloadableRefs.length && loadMoreRefs) {
            const additional = normalizeTelegramDownloadRefs(await loadMoreRefs(capacity), sourceEntity) || [];
            ids.push(...additional.map(ref => ref.id));
            await appendExplicitRefs(additional);
        }
        const segment = downloadableRefs.slice(nextRef, nextRef + capacity);
        // Byte reservations are made per admitted download, not for the whole claimed window.
        if (segment.length === 0) return [];
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
                const firstItem = sourceItems[0];
                const segmentMessages = await withTelegramAccount(sourceKey, 'metadata', client =>
                    firstItem.origin === 'comment' && firstItem.channelPostId
                        ? getTelegramDiscussionMessagesWithAccess(client, firstItem.sourceEntity, { ids: segmentIds }, { source: sourceEntity, postId: firstItem.channelPostId })
                        : getTelegramMessagesWithAccess(client, firstItem.sourceEntity, { ids: segmentIds }), { signal: taskSignal });
                for (const segmentMessage of segmentMessages) {
                    if (segmentMessage) preloadedMessageById.set(segmentMessage.id, segmentMessage as Api.Message);
                }
            }
            for (const item of sourceItems) item.message = preloadedMessageById.get(item.id);
        }

        nextRef += segment.length;
        return segment;
    }, async item => {
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
            const message = item.message;
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
                discussion: item.origin === 'comment' && item.channelPostId ? { source: sourceEntity, postId: item.channelPostId } : undefined,
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
                    const resolved = (await resolveTelegramTaskStorageFolderPersistent(chatIdStr, automaticPreview)).folder;
                    taskResolvedStorageFolder = resolved;
                    updateBatch(chatIdStr, batchId, { folderPath: resolved || undefined });
                }
                uploadItem.folderOverride = taskResolvedStorageFolder !== undefined ? taskResolvedStorageFolder : taskFolderOverride;
                await refreshSegmentStatus(true, fileName);
                await processFileUpload(userClient, uploadItem, undefined, channelGroupId, getExecutionControlState);
                if (uploadItem.status === 'success') {
                    successful += 1;
                    successfulMessageIds.push(item.id);
                    await onItemSettled?.(item.persistentRef, 'success', undefined, uploadItem.leaseSettled);
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
                console.error(`🤖 频道分段下载任务异常: ${fileName}`, err);
                failed += 1;
                failedMessageIds.push(item.id);
                await onItemSettled?.(item.persistentRef, 'failed', err instanceof Error ? err.message : String(err));
            } finally {
                if (!uploadItem.storageCooldownUntil) {
                    completed += 1;
                    found += 1;
                }
                item.message = undefined;
                await refreshSegmentStatus(false, fileName);
            }
    });
    await refreshSegmentStatus(true);

    if (downloadableRefs.length > 0 && !executionGroupKey) {
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

const ordinaryRecoveryInFlight = new Set<string>();

export async function recoverOrdinaryTelegramTasks(client: TelegramClient): Promise<void> {
    for (const task of await readRecoverableOrdinaryTasks()) {
        if (ordinaryRecoveryInFlight.has(task.id) || downloadQueue.getGroupSnapshot(task.id)) continue;
        ordinaryRecoveryInFlight.add(task.id);
        try {
            const owner = Number(task.owner_user_id);
            if (!await isAuthenticatedAsync(owner)) {
                await updateTransferTask('telegram_bot', task.id, { status: 'failed', stage: 'failed', error: '原任务用户已无访问权限', retryable: false });
                continue;
            }
            const target = storageManager.getTarget(task.target_provider, task.target_account_id);
            const refs = Object.values(task.payload.ordinaryFiles);
            const pending: FileUploadItem[] = [];
            let completed = 0, failed = 0, cancelled = 0;
            for (const ref of refs) {
                if (ref.status === 'success') { completed++; continue; }
                if (ref.status === 'cancelled') { cancelled++; continue; }
                if (ref.status === 'failed') { failed++; continue; }
                try {
                    if (ref.status === 'saving') {
                        const indexed = ref.storedName ? await query('SELECT id FROM files WHERE stored_name=$1 AND storage_account_id IS NOT DISTINCT FROM $2::uuid', [ref.storedName, task.target_account_id]) : null;
                        if (indexed?.rows[0]) {
                            await updateOrdinaryFile(task.id, ref.messageId, { status: 'success', fileId: String(indexed.rows[0].id) });
                            completed++;
                            continue;
                        }
                        const storedPath = ref.storedPath || (ref.storedName && ['s3','aliyun_oss','webdav'].includes(task.target_provider)
                            ? [task.target_folder, ref.storedName].filter(Boolean).join('/') : undefined);
                        if (!storedPath) throw new Error('服务重启时外部保存结果未知，请核对存储后重新发送原文件');
                        await target.provider.deleteFile(storedPath);
                    }
                    const message = await rereadOrdinaryFile(client, ref);
                    await updateOrdinaryFile(task.id, ref.messageId, { status: 'pending' });
                    pending.push({ message, fileName: ref.fileName, mimeType: ref.mimeType, generatedName: ref.generatedName,
                        status: 'pending', storageTarget: target, folderOverride: task.target_folder });
                } catch (error) {
                    failed++;
                    await updateOrdinaryFile(task.id, ref.messageId, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
                }
            }
            downloadQueue.restoreGroup({ id: task.id, kind: refs.some(ref => ref.groupedId) ? 'album' : 'single', title: refs[0]?.fileName || task.id,
                chatId: task.chat_id, userId: owner, targetProvider: task.target_provider, targetAccountId: task.target_account_id,
                targetFolder: task.target_folder, expectedTotal: refs.length }, { completed, failed, cancelled, paused: task.status === 'paused' });
            for (const file of pending) {
                void processFileUpload(client, file, undefined, task.id).catch(error => console.error('普通 Telegram 文件恢复失败:', error));
            }
            console.log(`🤖 普通 Telegram 任务恢复: id=${task.id} pending=${pending.length} completed=${completed} failed=${failed} paused=${task.status === 'paused'}`);
        } catch (error) {
            await updateTransferTask('telegram_bot', task.id, { status: 'failed', stage: 'failed', error: error instanceof Error ? error.message : String(error), retryable: true });
        } finally { ordinaryRecoveryInFlight.delete(task.id); }
    }
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
        const existingQueue = mediaGroupQueues.get(queueKey) || mediaGroupQueueCreations.has(queueKey);
        const queue = await getOrCreateTelegramMediaGroupQueue(mediaGroupQueues, mediaGroupQueueCreations, queueKey, async () => {
            const chatKey = message.chatId?.toString() || String(senderId);
            const selectedTarget = await consumeOrGetTelegramTargetState(chatKey);
            const storageTarget = selectedTarget
                ? storageManager.getTarget(selectedTarget.provider, selectedTarget.accountId)
                : storageManager.getActiveTarget();
            return {
                mediaGroupId,
                queueKey,
                chatId: message.chatId,
                userId: senderId,
                client,
                files: [],
                processingStarted: false,
                storageTarget,
                createdAt: Date.now(),
                lastAddedAt: Date.now(),
            };
        });
        const albumGroupId = ordinaryGroupId('a', message.chatId!.toString(), queueKey);
        if (!await rememberOrdinaryFile(albumGroupId, message, queue.storageTarget, fileInfo, queue.storageFolder)) return;
        if (!existingQueue) {
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
                    providerName: queue.storageTarget.provider.name,
                    storageLabel: await describeStorageTarget(queue.storageTarget),
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
        const locale = await getTelegramUserLocaleOrDefault(senderId);
        const previewRules = await getStoragePathRules();
        const selectedTarget = await consumeOrGetTelegramTargetState(chatIdStr);
        const singleStorageTarget = selectedTarget
            ? storageManager.getTarget(selectedTarget.provider, selectedTarget.accountId)
            : storageManager.getActiveTarget();
        const previewFolder = await resolveTelegramStorageFolderPersistent(chatIdStr, buildStorageFolderWithRules({
            source: 'telegram',
            chatName,
            mimeType,
            fileName: finalFileName,
        }, previewRules));
        const storageLabel = await describeStorageTarget(singleStorageTarget);
        const destinationText = `\n📍 存储：${storageLabel}\n📁 保存目录：${previewFolder || '/'}\n🆔 任务：${ordinaryGroupId('s', chatIdStr, String(message.id))}`;
        const singleGroupId = ordinaryGroupId('s', chatIdStr, String(message.id));
        if (!await rememberOrdinaryFile(singleGroupId, message, singleStorageTarget, fileInfo, previewFolder)) return;
        const singleGroup: DownloadTaskGroupInput = {
            id: singleGroupId,
            kind: 'single',
            title: finalFileName,
            chatId: chatIdStr,
            userId: senderId,
            targetProvider: singleStorageTarget.provider.name,
            targetAccountId: singleStorageTarget.accountId,
            targetFolder: previewFolder,
            expectedTotal: 1,
        };
        await admitOrdinaryTransferTask(singleGroup);
        downloadQueue.ensureGroup(singleGroup);

        if (message.chatId) {
            await checkAndResetSession(client, chatId);
        }

        registerUpload(chatIdStr, uploadId, {
            fileName: finalFileName,
            typeEmoji,
            phase: 'queued',
            total: totalSize,
            groupId: singleGroupId,
            providerName: singleStorageTarget.provider.name,
            storageLabel,
            folder: previewFolder || '/',
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
                        message: buildDownloadProgress(finalFileName, 0, totalSize, typeEmoji, undefined, locale) + destinationText,
                        buttons: buildProgressControlButtons(listDownloadTaskGroups(chatIdStr, senderId)
                            .filter(group => group.id === singleGroupId)
                            .map(group => ordinaryTaskCenterItem(group, locale)).filter((item): item is TaskCenterItem => Boolean(item)), locale),
                    }) as Api.Message;
                    if (statusMsg) {
                        updateLastStatusMessageId(chatId, statusMsg.id, false);
                        registerProgressCard(chatIdStr, statusMsg.id, senderId);
                    }
                }
            });
        }

        const stats = downloadQueue.getStats();
        if (!useConsolidated() && statusMsg && (stats.active >= 2 || stats.pending > 0) && !silentSessionMap.has(chatIdStr)) {
            await runStatusAction(chatId, async () => {
                await safeEditMessage(client, chatId, {
                    message: statusMsg!.id,
                    text: buildQueuedMessage(finalFileName, stats.pending, locale) + destinationText,
                    buttons: buildProgressControlButtons(listDownloadTaskGroups(chatIdStr, senderId)
                        .filter(group => group.id === singleGroupId)
                        .map(group => ordinaryTaskCenterItem(group, locale)).filter((item): item is TaskCenterItem => Boolean(item)), locale),
                });
            });
        }

        const refreshSingleTaskCard = async () => {
            await runStatusAction(chatId, async () => {
                if (silentSessionMap.has(chatIdStr)) {
                    await refreshSilentProgress(client, chatId, senderId);
                    return;
                }
                if (useConsolidated()) {
                    await refreshConsolidatedMessage(client, chatId);
                    return;
                }
                if (!statusMsg) return;
                const group = downloadQueue.getGroup(singleGroupId, { chatId: chatIdStr, userId: senderId });
                if (!group || !['running', 'waiting', 'paused', 'pausing'].includes(group.state)) return;
                const item = ordinaryTaskCenterItem(group, locale);
                if (!item) return;
                item.storageLabel = storageLabel;
                item.targetFolder = previewFolder || '/';
                const paused = group.state === 'paused' || group.state === 'pausing';
                const text = paused
                    ? buildTaskCenterDetail(item, 0, { locale }).text
                    : buildDownloadProgress(finalFileName, group.completedBytes || 0, group.totalBytes || totalSize, typeEmoji, undefined, locale, group.speedBytesPerSecond || 0) + destinationText;
                await safeEditMessage(client, chatId, {
                    message: statusMsg.id, text, buttons: buildProgressControlButtons([item], locale),
                });
            });
        };
        singleTaskCardRefreshers.set(singleGroupId, refreshSingleTaskCard);

        let lastUpdateTime = 0;
        const onProgress = async (downloaded: number, total: number) => {
            const now = Date.now();
            if (now - lastUpdateTime < 3000) return;
            lastUpdateTime = now;

            const telemetry = downloadQueue.getGroup(singleGroupId);
            downloaded = telemetry?.completedBytes ?? downloaded;
            total = telemetry?.totalBytes ?? total;
            const speed = telemetry?.speedBytesPerSecond || 0;
            updateUploadPhase(chatIdStr, uploadId, { phase: 'downloading', downloaded, total, groupId: singleGroupId, speedBytesPerSecond: speed });

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
                await refreshSingleTaskCard();
            }
        };

        let retryCount = 0;
        const maxRetries = 1;
        let lastLocalPath: string | undefined;
        let lastError: string | undefined;
        let storageCooldownUntil: Date | undefined;
        let retryDownload = false;

        const attemptSingleUpload = (signal?: AbortSignal, reportProgress: (downloaded: number, total: number) => void = (downloaded, total) => { void onProgress(downloaded, total); }, taskId?: string): Promise<boolean> => withTemporaryUploadFiles(async () => {
            let localFilePath: string | undefined;
            let pooledDownload = false;
            let sourceDownloaded = false;
            let readingSource = false;
            const storageTarget = singleStorageTarget;
            const { provider, accountId: activeAccountId } = storageTarget;
            try {
                if (signal?.aborted) throw new Error('下载任务已停止');
                await assertStorageTargetWritable(storageTarget);
                await updateOrdinaryFile(singleGroupId, message.id, { status: 'downloading' });
                finalFileName = await getCanonicalTelegramFileName(message, finalFileName, mimeType, undefined, undefined, generatedName);
                updateUploadPhase(chatIdStr, uploadId, { fileName: finalFileName });
                const storageRules = await getStoragePathRules();
                const automaticFolder = buildStorageFolderWithRules({
                    source: 'telegram',
                    chatName,
                    mimeType,
                    fileName: finalFileName,
                }, storageRules);
                const storageFolder = previewFolder;
                downloadQueue.ensureGroup({
                    id: singleGroupId,
                    kind: 'single',
                    title: finalFileName,
                    chatId: chatIdStr,
                    userId: senderId,
                    targetProvider: singleStorageTarget.provider.name,
                    targetAccountId: singleStorageTarget.accountId,
                    targetFolder: storageFolder,
                    expectedTotal: 1,
                });
                // 关键在这里：获取唯一文件名
                const storedName = await getUniqueStoredName(finalFileName, storageFolder, activeAccountId);

                readingSource = true;
                const result = await downloadIncomingTelegramFile(client, message, fileName, undefined, reportProgress, signal, singleGroupId, taskId, () => { pooledDownload = true; });
                if (!result) {
                    lastError = '下载失败';
                    return false;
                }
                localFilePath = result.filePath;
                sourceDownloaded = true;
                readingSource = false;
                retryDownload = false;
                if (taskId) await downloadQueue.beginUpload(taskId);
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
                        rememberTransferDestination(chatIdStr, storageFolder || '/', storageLabel);
                        if (statusMsg && !silentSessionMap.has(chatIdStr)) {
                            await runStatusAction(chatId, async () => {
                                await safeEditMessage(client, chatId, {
                                    message: statusMsg!.id,
                                    text: buildDuplicateSkipped(finalFileName, storageFolder, duplicate.id, locale) + `\n📍 ${storageLabel}`,
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
                            text: buildSavingFile(finalFileName, typeEmoji, locale) + destinationText,
                        });
                    });
                }

                if (signal?.aborted) throw new Error('下载任务已停止');
                let thumbnailPath: string | null = null;
                let dimensions: { width?: number; height?: number } = {};
                // 方案A：只在本地存储生成缩略图；第三方存储不生成本地缩略图。
                if (provider.name === 'local' && (mimeType.startsWith('image/') || mimeType.startsWith('video/'))) {
                    try {
                        thumbnailPath = await generateThumbnail(localFilePath, storedName, mimeType, signal);
                        dimensions = await getImageDimensions(localFilePath, mimeType, signal);
                    } catch (thumbErr) { }
                }

                let finalPath = localFilePath;
                let indexedFileId: string | null = null;
                let sourceRef = provider.name;

                if (signal?.aborted) throw new Error('下载任务已停止');
                const saveDownloadedFile = () => withStorageAccountOperationLease(pool, activeAccountId, 'telegram_upload', () =>
                    saveAndIndexWithCompensation(provider, localFilePath!, storedName, mimeType, storageFolder, async savedPath => {
                            indexedFileId = await indexOrdinaryFile(singleGroupId, message.id, `INSERT INTO files
                                (name,stored_name,type,mime_type,size,path,thumbnail_path,width,height,source,folder,storage_account_id)
                                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
                                [finalFileName,storedName,fileType,mimeType,actualSize,savedPath,thumbnailPath,dimensions.width,dimensions.height,sourceRef,storageFolder,activeAccountId]);
                    }, { signal, beforeSave: storedPath => updateOrdinaryFile(singleGroupId, message.id, { status: 'saving', storedPath, storedName }) }),
                );
                while (true) {
                    try {
                        finalPath = await saveDownloadedFile();
                        break;
                    } catch (error) {
                        if (!isStorageQuotaCooldownError(error)) throw error;
                        await markStorageAccountCooldown(error.storageAccountId || activeAccountId, error.provider, error.reason, error.cooldownUntil, error.message);
                        const reason = formatStorageCooldownNotice(error.cooldownUntil);
                        if (taskId) downloadQueue.waitForStorage(taskId, reason);
                        updateUploadPhase(chatIdStr, uploadId, { phase: 'queued' });
                        await waitForStorageCooldownRetry(error.cooldownUntil, signal || new AbortController().signal, async () => undefined);
                        signal?.throwIfAborted();
                        if (taskId) await downloadQueue.beginUpload(taskId);
                        updateUploadPhase(chatIdStr, uploadId, { phase: 'saving' });
                    }
                }
                if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
                lastLocalPath = undefined;
                localFilePath = undefined;

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
                rememberTransferDestination(chatIdStr, storageFolder || '/', storageLabel);

                if (useConsolidated()) {
                    await runStatusAction(chatId, async () => {
                        await refreshConsolidatedMessage(client, chatId);
                    });
                } else if (statusMsg && !silentSessionMap.has(chatIdStr)) {
                    await runStatusAction(chatId, async () => {
                        await safeEditMessage(client, chatId, {
                            message: statusMsg!.id,
                            text: buildUploadSuccess(finalFileName, actualSize, fileType, storageLabel, storageFolder || '/', indexedFileId, duplicateMode === 'copy' ? 'copied' : null, locale),
                        });
                    });
                }
                return true;
            } catch (error) {
                retryDownload = readingSource && !pooledDownload && !sourceDownloaded && isTelegramTransientDownloadError(error);
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
        });

        const singleUploadTask = async (signal: AbortSignal, taskId?: string) => {
            const reportQueueProgress = (downloaded: number, total: number) => {
                if (taskId) downloadQueue.updateProgress(taskId, downloaded, total);
                void onProgress(downloaded, total);
            };
            if (taskId) downloadQueue.resetProgress(taskId);
            let success = await attemptSingleUpload(signal, reportQueueProgress, taskId);
            if (taskId) downloadQueue.stopProgress(taskId);
            if (!success && retryDownload && !signal.aborted && !storageCooldownUntil && retryCount < maxRetries) {
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
                        await safeEditMessage(client, chatId, {
                            message: statusMsg!.id,
                            text: buildRetryMessage(finalFileName, typeEmoji, locale) + destinationText,
                            buttons: buildProgressControlButtons(listDownloadTaskGroups(chatIdStr, senderId)
                                .filter(group => group.id === singleGroupId)
                                .map(group => ordinaryTaskCenterItem(group, locale)).filter((item): item is TaskCenterItem => Boolean(item)), locale),
                        });
                    });
                }
                success = await attemptSingleUpload(signal, reportQueueProgress, taskId);
            }


            if (signal.aborted) {
                lastError = '用户强制停止下载任务';
                updateUploadPhase(chatIdStr, uploadId, { phase: 'failed', error: lastError });
                if (statusMsg && !silentSessionMap.has(chatIdStr)) {
                    await runStatusAction(chatId, async () => {
                        await safeEditMessage(client, chatId, {
                            message: statusMsg!.id,
                            text: buildUploadFail(finalFileName, lastError!, locale) + destinationText
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
                        await safeEditMessage(client, chatId, {
                            message: statusMsg!.id,
                            text: buildUploadFail(finalFileName, lastError || t(locale, 'upload.error.unknown'), locale) + destinationText
                        }).catch(() => { });
                    });
                } else {
                    await safeReply(message, {
                        message: buildUploadFail(finalFileName, lastError || t(locale, 'upload.error.unknown'), locale) + destinationText
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
            await updateOrdinaryFile(singleGroupId, message.id, { status: signal.aborted ? 'cancelled' : success ? 'success' : 'failed', error: lastError });

            setTimeout(() => {
                removeUpload(chatIdStr, uploadId);
            }, 8000);
            return success
                ? { status: 'success' as const }
                : { status: 'failed' as const, error: lastError || '未知错误' };
        };

        const onSinglePendingCancelled = async () => {
            const error = '用户取消任务';
            await updateOrdinaryFile(singleGroupId, message.id, { status: 'cancelled', error });
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
                    text: buildUploadFail(finalFileName, error, locale) + destinationText,
                });
            }
            setTimeout(() => removeUpload(chatIdStr, uploadId), 8000);
        };
        downloadQueue.add(singleGroupId, finalFileName, singleUploadTask, totalSize, onSinglePendingCancelled).catch(err => {
            console.error(`🤖 单文件下载任务异常: ${finalFileName}`, err);
            removeUpload(chatIdStr, uploadId);
        }).finally(() => {
            singleTaskCardRefreshers.delete(singleGroupId);
        });
    }
}
