import { Api, TelegramClient } from 'telegram';
import { getPeerId } from 'telegram/Utils.js';
import { query } from '../db/index.js';
import checkDiskSpaceModule from 'check-disk-space';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { formatBytes, getTypeEmoji } from '../utils/telegramUtils.js';
import {
    MSG,
    buildWelcomeBack,
    buildHelp,
    buildStorageReport,
    buildFileList,
    buildDeleteSuccess,
    getProviderDisplayName,
} from '../utils/telegramMessages.js';
import { authenticatedUsers, passwordInputState, isAuthenticatedAsync } from './telegramState.js';
import { forceStopDownloadTasksForScope, getDownloadQueueStats, getDownloadTaskScopeStatus, pauseDownloadTasks, resumeDownloadTasks, retryFailedDownloadTasks, getFileDownloadConcurrency, setFileDownloadConcurrency, listDownloadTaskGroups, getDownloadTaskGroup, prioritizeDownloadTaskGroup, pauseDownloadTaskGroup, resumeDownloadTaskGroup, cancelDownloadTaskGroup, getChannelExecutionGroup, prioritizeChannelExecutionGroup, pauseChannelExecutionGroup, resumeChannelExecutionGroup, cancelChannelExecutionGroup, refreshSilentProgress } from './telegramUpload.js';
import { storageManager } from './storage.js';
import { cancelTelegramBackgroundJob, listTelegramActiveTaskQueues, pauseTelegramBackgroundJob, resumeTelegramBackgroundJob, retryTelegramBackgroundJob } from './telegramChannelJobs.js';
import { getSetting, setSetting } from '../utils/settings.js';
import { DuplicateMode, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { startPeriodicCleanup, stopPeriodicCleanup } from './orphanCleanup.js';
import { safeUnlink } from '../utils/localPath.js';
import { getCurrentStorageScope, nextParam, removePhysicalFile } from '../utils/fileScope.js';
import { canonicalTelegramChatKey, telegramChatKeyFromPeerParts } from '../utils/telegramChatKey.js';
import { buildTaskCancelConfirm, buildTaskCenterDetail, buildTaskCenterPage, channelTaskCenterItem, ordinaryTaskCenterItem, parseTaskCenterCallback, ytdlpTaskCenterItem, type TaskCenterButton, type TaskCenterItem, type TaskCenterSourceType, type TaskCenterView } from './telegramTaskCenter.js';
import { listTransferTasks } from './transferTasks.js';
import { cancelYtDlpTask, retryYtDlpTask } from './ytDlpDownload.js';
import { DestructiveConfirmationStore } from './destructiveConfirmation.js';
import {
    buildPathSettingsKeyboard,
    buildPathSettingsText,
    buildPendingPathPromptPersistent,
    buildPathPreviewLine,
    clearTelegramPathStatePersistent,
    getRecentTelegramPathsPersistent,
    setPendingTelegramPathInput,
    setNextTelegramPathPersistent,
    setSessionTelegramPathPersistent,
} from '../utils/telegramPathSettings.js';

// ESM compatibility
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;
const DOWNLOAD_WORKER_OPTIONS = [4, 8, 12, 16];
const FILE_CONCURRENCY_OPTIONS = [1, 2, 3, 4];
const STORAGE_TYPE_ORDER = ['local', 'onedrive', 'google_drive', 'aliyun_oss', 's3', 'webdav'];
const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR || './data/thumbnails';

interface PendingDeleteInfo {
    fileId: string;
    name: string;
    size: number;
    selector: string;
    actorId: number;
    chatId: string;
    messageId: number;
}

interface StorageAccountSummary {
    id: string;
    name?: string | null;
    type: string;
    is_active: boolean;
}

interface PendingStorageClearSnapshot {
    indexedIds: string[];
    orphanPaths: string[];
}

interface PendingBulkTaskCancellation {
    actorId: number;
    chatId: string;
    messageId: number;
}

interface BulkTaskImpact {
    ordinaryTasks: number;
    ordinaryActiveFiles: number;
    ordinaryPendingFiles: number;
    channelTasks: number;
    ytdlpTasks: number;
}

const pendingDeleteConfirmations = new Map<string, PendingDeleteInfo>();
const pendingStorageClearSnapshots = new Map<string, PendingStorageClearSnapshot>();
const pendingBulkTaskCancellations = new Map<string, PendingBulkTaskCancellation>();
const destructiveConfirmations = new DestructiveConfirmationStore();

function buildDeleteConfirmKeyboard(confirmId: string): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [new Api.KeyboardButtonRow({
            buttons: [
                new Api.KeyboardButtonCallback({ text: '⚠️ 确认删除', data: Buffer.from(`del_confirm_${confirmId}`) }),
                new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from(`del_cancel_${confirmId}`) }),
            ],
        })],
    });
}

function buildBulkTaskCancelKeyboard(confirmId: string): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [new Api.KeyboardButtonRow({
            buttons: [
                new Api.KeyboardButtonCallback({ text: '⚠️ 确认取消全部', data: Buffer.from(`bulk_task_confirm_${confirmId}`) }),
                new Api.KeyboardButtonCallback({ text: '返回', data: Buffer.from(`bulk_task_cancel_${confirmId}`) }),
            ],
        })],
    });
}


function normalizeDownloadWorkers(value: unknown): number {
    const parsed = parseInt(String(value ?? '4'), 10);
    return DOWNLOAD_WORKER_OPTIONS.includes(parsed) ? parsed : 4;
}

async function getCurrentDownloadWorkers(): Promise<number> {
    const value = await getSetting('telegram_download_workers', process.env.TELEGRAM_DOWNLOAD_WORKERS || '4');
    return normalizeDownloadWorkers(value);
}

function buildDownloadWorkersKeyboard(current: number, confirmValue?: number): Api.ReplyInlineMarkup {
    if (confirmValue) {
        return new Api.ReplyInlineMarkup({
            rows: [
                new Api.KeyboardButtonRow({
                    buttons: [
                        new Api.KeyboardButtonCallback({ text: `⚠️ 确认使用 ${confirmValue}`, data: Buffer.from(`dw_confirm_${confirmValue}`) }),
                        new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('dw_cancel') }),
                    ],
                }),
            ],
        });
    }

    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${current === 4 ? '✅ ' : ''}4`, data: Buffer.from('dw_set_4') }),
                    new Api.KeyboardButtonCallback({ text: `${current === 8 ? '✅ ' : ''}8`, data: Buffer.from('dw_set_8') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${current === 12 ? '✅ ' : ''}12 ⚠️`, data: Buffer.from('dw_set_12') }),
                    new Api.KeyboardButtonCallback({ text: `${current === 16 ? '✅ ' : ''}16 ⚠️`, data: Buffer.from('dw_set_16') }),
                ],
            }),
        ],
    });
}

function buildStorageMaintenanceKeyboard(localFileCount: number, confirmationToken?: string): Api.ReplyInlineMarkup | undefined {
    if (localFileCount <= 0) return undefined;
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: confirmationToken
                    ? [
                        new Api.KeyboardButtonCallback({ text: '⚠️ 确认删除本地全部下载文件', data: Buffer.from(`storage_clear_confirm_${confirmationToken}`) }),
                        new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from(`storage_clear_cancel_${confirmationToken}`) }),
                    ]
                    : [
                        new Api.KeyboardButtonCallback({ text: `🧹 删除本地全部下载文件 (${localFileCount})`, data: Buffer.from('storage_clear_ask') }),
                    ],
            }),
        ],
    });
}

function shortenStorageAccountName(name: string, maxLength = 22): string {
    return name.length > maxLength ? `${name.slice(0, maxLength - 1)}…` : name;
}

function sortStorageAccounts(accounts: StorageAccountSummary[]): StorageAccountSummary[] {
    return [...accounts].sort((a, b) => {
        const orderDiff = STORAGE_TYPE_ORDER.indexOf(a.type) - STORAGE_TYPE_ORDER.indexOf(b.type);
        if (orderDiff !== 0) return orderDiff;
        return (a.name || '').localeCompare(b.name || '', 'zh-CN');
    });
}

function buildStorageAccountKeyboard(accounts: StorageAccountSummary[], activeAccountId: string | null): Api.ReplyInlineMarkup {
    const accountButtons = sortStorageAccounts(accounts).map(account => {
        const isActive = account.is_active || account.id === activeAccountId;
        const providerLabel = getProviderDisplayName(account.type).replace(/^[^\p{L}\p{N}]+/u, '').trim();
        const accountName = shortenStorageAccountName(account.name || '未命名账户');
        return new Api.KeyboardButtonRow({
            buttons: [new Api.KeyboardButtonCallback({
                text: `${isActive ? '✅' : '⬜'} ${providerLabel} · ${accountName}`,
                data: Buffer.from(`storage_switch_${account.id}`),
            })],
        });
    });

    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({
                    text: `${!activeAccountId ? '✅' : '⬜'} 💾 本地存储`,
                    data: Buffer.from('storage_switch_local'),
                })],
            }),
            ...accountButtons,
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: '🔄 刷新列表', data: Buffer.from('storage_switch_refresh') })],
            }),
        ],
    });
}

function buildStorageSwitchText(accounts: StorageAccountSummary[], activeAccountId: string | null): string {
    const activeAccount = accounts.find(account => account.is_active || account.id === activeAccountId);
    const activeLine = activeAccount
        ? `${getProviderDisplayName(activeAccount.type)} · ${activeAccount.name || '未命名账户'}`
        : getProviderDisplayName('local');

    const accountLines = sortStorageAccounts(accounts).map(account => {
        const marker = account.id === activeAccountId || account.is_active ? '✅' : '⬜';
        return `${marker} ${getProviderDisplayName(account.type)} · ${account.name || '未命名账户'}\n   ID: \`${String(account.id).slice(0, 8)}\``;
    });

    return [
        '🗄️ **存储源切换**',
        '',
        `当前使用：${activeLine}`,
        '',
        '点击下面按钮即可切换到已在网页端配置好的存储账户；不需要打开前端页面。',
        '',
        '**可选存储：**',
        `✅/⬜ ${getProviderDisplayName('local')}`,
        ...accountLines,
        '',
        '提示：这里只能切换已有账户；新增 OAuth/密钥配置仍需在网页端完成。',
    ].join('\n');
}

async function buildStorageSwitchView(): Promise<{ text: string; buttons: Api.ReplyInlineMarkup }> {
    const accounts = await storageManager.getAccounts() as StorageAccountSummary[];
    const activeAccountId = storageManager.getActiveAccountId();
    return {
        text: buildStorageSwitchText(accounts, activeAccountId),
        buttons: buildStorageAccountKeyboard(accounts, activeAccountId),
    };
}

function isTelegramMessageNotModified(error: unknown): boolean {
    const err = error as { code?: number; errorMessage?: string; message?: string };
    return err?.code === 400 && (
        err?.errorMessage === 'MESSAGE_NOT_MODIFIED' ||
        String(err?.message || '').includes('MESSAGE_NOT_MODIFIED')
    );
}

async function editStorageSwitchMessage(client: TelegramClient, update: Api.UpdateBotCallbackQuery, toast: string): Promise<void> {
    const view = await buildStorageSwitchView();
    try {
        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: view.text,
            buttons: view.buttons,
        });
    } catch (error) {
        // Telegram returns 400 MESSAGE_NOT_MODIFIED when the refreshed account list is
        // identical. That is a successful refresh from the user's perspective, not an
        // error popup.
        if (!isTelegramMessageNotModified(error)) {
            throw error;
        }
    }
    await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: toast }));
}

async function scanLocalDownloadFiles(): Promise<{ count: number; totalSize: number; paths: string[] }> {
    const baseDir = path.resolve(UPLOAD_DIR);
    const paths: string[] = [];
    let totalSize = 0;
    if (!fs.existsSync(baseDir)) return { count: 0, totalSize: 0, paths };

    async function walk(dir: string): Promise<void> {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                const stat = await fs.promises.stat(fullPath);
                totalSize += stat.size;
                paths.push(fullPath);
            }
        }
    }

    await walk(baseDir);
    return { count: paths.length, totalSize, paths };
}

async function pruneEmptyDirs(dir: string, baseDir = path.resolve(UPLOAD_DIR)): Promise<void> {
    if (!fs.existsSync(dir) || path.resolve(dir) === baseDir) return;
    const entries = await fs.promises.readdir(dir);
    if (entries.length === 0) {
        await fs.promises.rmdir(dir);
        await pruneEmptyDirs(path.dirname(dir), baseDir);
    }
}

function buildDownloadWorkersText(current: number): string {
    return [
        '⚙️ **Telegram 分片并发设置**',
        '',
        `当前 worker 数：**${current}**`,
        '',
        '说明：Telegram 单次请求上限仍是 512KB，这里调整的是单个文件内部的并发分片请求数。',
        '如果要调整“一次同时下载几个文件”，请使用 /file_concurrency。',
        '',
        '建议：',
        '- `4`：稳定优先',
        '- `8`：速度/稳定平衡',
        '- `12` / `16`：激进模式，可能触发风控、断流、限速，甚至账号风险，需要二次确认',
    ].join('\n');
}

function normalizeFileConcurrency(value: unknown): number {
    const parsed = parseInt(String(value ?? '2'), 10);
    return FILE_CONCURRENCY_OPTIONS.includes(parsed) ? parsed : 2;
}

async function getCurrentFileConcurrency(): Promise<number> {
    const value = await getSetting('telegram_file_download_concurrency', process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY || String(getFileDownloadConcurrency()));
    return normalizeFileConcurrency(value);
}

function buildFileConcurrencyKeyboard(current: number, confirmValue?: number): Api.ReplyInlineMarkup {
    if (confirmValue) {
        return new Api.ReplyInlineMarkup({
            rows: [
                new Api.KeyboardButtonRow({
                    buttons: [
                        new Api.KeyboardButtonCallback({ text: `⚠️ 确认同时下载 ${confirmValue} 个文件`, data: Buffer.from(`fc_confirm_${confirmValue}`) }),
                        new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('fc_cancel') }),
                    ],
                }),
            ],
        });
    }

    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${current === 1 ? '✅ ' : ''}1`, data: Buffer.from('fc_set_1') }),
                    new Api.KeyboardButtonCallback({ text: `${current === 2 ? '✅ ' : ''}2`, data: Buffer.from('fc_set_2') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${current === 3 ? '✅ ' : ''}3`, data: Buffer.from('fc_set_3') }),
                    new Api.KeyboardButtonCallback({ text: `${current === 4 ? '✅ ' : ''}4 ⚠️`, data: Buffer.from('fc_set_4') }),
                ],
            }),
        ],
    });
}

function buildFileConcurrencyText(current: number): string {
    const stats = getDownloadQueueStats();
    return [
        '📦 **Telegram 文件级并发设置**',
        '',
        `当前同时下载文件数：**${current}**`,
        `当前队列：进行中 ${stats.active}，等待中 ${stats.pending}`,
        '',
        '说明：这里控制“一次同时下载几个文件”。',
        '它不同于 /download_workers：后者控制单个文件内部的 512KB 分片并发。',
        '',
        '建议：',
        '- `1`：最稳，适合风控/限速时使用',
        '- `2`：默认推荐，速度与稳定平衡',
        '- `3`：速度优先，适合线路稳定时使用',
        '- `4`：激进模式，可能触发 Telegram 限流或云盘上传限速，需要二次确认',
        '',
        '修改后会立即影响队列中新启动的文件下载；已在进行中的文件不会被中断。',
    ].join('\n');
}

function isOn(value: unknown, defaultValue = true): boolean {
    if (value === undefined || value === null || value === '') return defaultValue;
    return ON_VALUES.has(String(value).toLowerCase());
}

async function getPathCenterState(): Promise<{ automaticBySource: boolean; automaticByType: boolean }> {
    return { automaticBySource: true, automaticByType: true };
}

function buildDuplicateModeKeyboard(mode: DuplicateMode): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${mode === 'skip' ? '✅' : '⬜'} 跳过重复`, data: Buffer.from('dm_set_skip') }),
                    new Api.KeyboardButtonCallback({ text: `${mode === 'copy' ? '✅' : '⬜'} 生成副本`, data: Buffer.from('dm_set_copy') }),
                ],
            }),
        ],
    });
}

function buildDuplicateModeText(mode: DuplicateMode): string {
    return [
        '🧬 **重复文件处理**',
        '',
        `当前模式：${mode === 'skip' ? '跳过重复' : '生成副本'}`,
        '',
        '- 跳过重复：同名 + 同目录 + 同大小时不再保存',
        '- 生成副本：自动改名为 `文件 (1).ext` 保留副本',
        '',
        '说明：修改后只影响后续新上传/转存文件。',
    ].join('\n');
}

async function getCleanupEnabledSetting(): Promise<boolean> {
    const value = await getSetting('auto_cleanup_orphans', process.env.AUTO_CLEANUP_ORPHANS || 'true');
    return isOn(value, true);
}

function buildCleanupSettingsKeyboard(enabled: boolean): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${!enabled ? '✅' : '⬜'} 关闭自动清理`, data: Buffer.from('cs_set_off') }),
                    new Api.KeyboardButtonCallback({ text: `${enabled ? '✅' : '⬜'} 开启自动清理`, data: Buffer.from('cs_set_on') }),
                ],
            }),
        ],
    });
}

function buildCleanupSettingsText(enabled: boolean): string {
    return [
        '🧹 **自动清理未索引临时文件**',
        '',
        `当前状态：${enabled ? '✅ 开启' : '⬜ 关闭'}`,
        '',
        '开启后会自动删除本地 uploads 中未登记到文件索引、且超过保护期的临时文件。',
        '这不会删除任务历史、已登记文件或第三方云端实体。',
        '',
        '如果本地 uploads 中有绕过 TG Vault 写入的文件，请保持关闭，避免其被识别为未索引临时文件。',
    ].join('\n');
}

function getCallbackChatKey(update: Api.UpdateBotCallbackQuery): string {
    try {
        return canonicalTelegramChatKey(getPeerId(update.peer as any, true));
    } catch {
        return telegramChatKeyFromPeerParts(update.peer as any, update.userId);
    }
}

export async function handleStart(message: Api.Message, senderId: number, buttons?: Api.TypeReplyMarkup): Promise<void> {
    if (await isAuthenticatedAsync(senderId)) {
        await message.reply({ message: buildWelcomeBack(), buttons });
    } else {
        passwordInputState.set(senderId, { password: '' });
    }
}

export async function handleHelp(message: Api.Message): Promise<void> {
    await message.reply({ message: buildHelp() });
}

export async function handleStorage(message: Api.Message): Promise<void> {
    try {
        const scope = await getCurrentStorageScope();
        const diskPath = os.platform() === 'win32' ? 'C:' : '/';
        const diskSpace = await checkDiskSpace(diskPath);

        // Fetch stats for the active account
        const result = await query(`
            SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size
            FROM files
            WHERE ${scope.clause}
        `, scope.params);
        const tgVaultStats = result.rows[0];
        const totalSize = parseInt(tgVaultStats.total_size);
        const fileCount = parseInt(tgVaultStats.file_count);
        const usedPercent = Math.round(((diskSpace.size - diskSpace.free) / diskSpace.size) * 100);

        const queueStats = getDownloadQueueStats();
        const localStats = await scanLocalDownloadFiles();

        const reply = buildStorageReport({
            diskTotal: diskSpace.size,
            diskFree: diskSpace.free,
            diskUsedPercent: usedPercent,
            fileCount,
            totalFileSize: totalSize,
            localFileCount: localStats.count,
            localTotalSize: localStats.totalSize,
            queueActive: queueStats.active,
            queuePending: queueStats.pending,
        });

        await message.reply({
            message: reply,
            buttons: buildStorageMaintenanceKeyboard(localStats.count),
        });
    } catch (error) {
        console.error('🤖 获取存储统计失败:', error);
        await message.reply({ message: MSG.ERR_STORAGE });
    }
}

export async function handleStorageSwitch(message: Api.Message): Promise<void> {
    try {
        const view = await buildStorageSwitchView();
        await message.reply({ message: view.text, buttons: view.buttons });
    } catch (error) {
        console.error('🤖 获取存储源切换菜单失败:', error);
        await message.reply({ message: `❌ 获取存储源切换菜单失败: ${(error as Error).message}` });
    }
}

export async function handleStorageSwitchCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        if (data === 'storage_switch_refresh') {
            await editStorageSwitchMessage(client, update, '已刷新');
            return;
        }

        const accountId = data.replace(/^storage_switch_/, '');
        if (!accountId) {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '无效的存储源选择', alert: true }));
            return;
        }

        if (accountId === 'local') {
            if (!storageManager.getActiveAccountId()) {
                await editStorageSwitchMessage(client, update, '当前已经是本地存储');
                return;
            }
            await storageManager.switchAccount('local');
            await editStorageSwitchMessage(client, update, '已切换到本地存储');
            return;
        }

        const accounts = await storageManager.getAccounts() as StorageAccountSummary[];
        const selected = accounts.find(account => account.id === accountId);
        if (!selected) {
            await editStorageSwitchMessage(client, update, '该存储账户已不存在');
            return;
        }
        if (selected.is_active || storageManager.getActiveAccountId() === accountId) {
            await editStorageSwitchMessage(client, update, '当前已经在使用该账户');
            return;
        }

        await storageManager.switchAccount(accountId);
        await editStorageSwitchMessage(client, update, `已切换到 ${selected.name || getProviderDisplayName(selected.type)}`);
    } catch (error) {
        console.error('🤖 切换存储源失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `切换失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleStorageCleanupCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const stats = await scanLocalDownloadFiles();
        const chatId = getCallbackChatKey(update);
        const messageId = Number(update.msgId);
        const tokenMatch = data.match(/^storage_clear_(confirm|cancel)_([A-Za-z0-9_-]+)$/);
        if (tokenMatch?.[1] === 'cancel') {
            const cancelled = destructiveConfirmations.cancel(tokenMatch[2], {
                actorId: userId,
                chatId,
                messageId,
                action: 'clear_local_storage',
            });
            if (!cancelled) {
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '清理确认无效或已过期', alert: true }));
                return;
            }
            pendingStorageClearSnapshots.delete(tokenMatch[2]);
            await client.editMessage(update.peer, {
                message: messageId,
                text: stats.count > 0 ? `已取消清理。当前本地下载文件：${stats.count} 个，占用 ${formatBytes(stats.totalSize)}。` : '已取消清理。当前没有本地下载文件。',
                buttons: buildStorageMaintenanceKeyboard(stats.count),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
            return;
        }

        if (data === 'storage_clear_ask') {
            const indexed = await query(`SELECT id, path, stored_name FROM files WHERE source = 'local'`);
            const indexedPaths = new Set(indexed.rows.map(file => path.resolve(file.path || path.join(UPLOAD_DIR, file.stored_name))));
            const confirmationToken = destructiveConfirmations.issue({
                actorId: userId,
                chatId,
                messageId,
                action: 'clear_local_storage',
            });
            pendingStorageClearSnapshots.set(confirmationToken, {
                indexedIds: indexed.rows.map(file => String(file.id)),
                orphanPaths: stats.paths.map(filePath => path.resolve(filePath)).filter(filePath => !indexedPaths.has(filePath)),
            });
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: [
                    '⚠️ **确认删除本地服务器全部下载文件？**',
                    '',
                    `将删除 uploads 本地目录中的 **${stats.count}** 个文件，占用 **${formatBytes(stats.totalSize)}**。`,
                    '这会删除本地实体文件及对应的本地文件索引；不会删除任务历史或任何第三方云端实体。',
                    '',
                    '如确认，请点击下方红色确认按钮。',
                ].join('\n'),
                buttons: buildStorageMaintenanceKeyboard(stats.count, confirmationToken),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '需要二次确认' }));
            return;
        }

        if (tokenMatch?.[1] === 'confirm') {
            const consumed = destructiveConfirmations.consume(tokenMatch[2], {
                actorId: userId,
                chatId,
                messageId,
                action: 'clear_local_storage',
            });
            const snapshot = pendingStorageClearSnapshots.get(tokenMatch[2]);
            pendingStorageClearSnapshots.delete(tokenMatch[2]);
            if (consumed.status !== 'ok' || !snapshot) {
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '清理确认无效、已过期或已使用', alert: true }));
                return;
            }
            let deletedCount = 0;
            let deletedBytes = 0;
            const indexed = snapshot.indexedIds.length > 0
                ? await query(`SELECT * FROM files WHERE source = 'local' AND id = ANY($1::uuid[])`, [snapshot.indexedIds])
                : { rows: [] };
            for (const file of indexed.rows) {
                const filePath = path.resolve(file.path || path.join(UPLOAD_DIR, file.stored_name));
                const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : Number(file.size || 0);
                try {
                    await removePhysicalFile(file);
                    await query('DELETE FROM files WHERE id = $1', [file.id]);
                    deletedCount += 1;
                    deletedBytes += size;
                    await pruneEmptyDirs(path.dirname(filePath));
                } catch (error) {
                    console.warn(`🤖 本地文件删除失败，保留索引等待重试: ${file.id}`, error);
                }
            }
            for (const resolved of snapshot.orphanPaths) {
                const size = fs.existsSync(resolved) ? fs.statSync(resolved).size : 0;
                if (await safeUnlink(resolved, UPLOAD_DIR)) {
                    deletedCount += 1;
                    deletedBytes += size;
                    await pruneEmptyDirs(path.dirname(resolved));
                }
            }
            const after = await scanLocalDownloadFiles();
            await client.editMessage(update.peer, {
                message: messageId,
                text: [
                    '✅ **本地服务器下载文件已清理**',
                    '',
                    `已删除：${deletedCount} 个文件`,
                    `释放空间：${formatBytes(deletedBytes)}`,
                    `剩余本地文件：${after.count} 个`,
                ].join('\n'),
                buttons: buildStorageMaintenanceKeyboard(after.count),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已删除 ${deletedCount} 个文件` }));
            return;
        }

        if (data.startsWith('storage_clear_confirm') || data.startsWith('storage_clear_cancel')) {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '旧清理按钮已失效，请重新发送 /storage', alert: true }));
        }
    } catch (error) {
        console.error('🤖 清理本地下载文件失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `清理失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleList(message: Api.Message, args: string[]): Promise<void> {
    try {
        let limit = 10;
        let page = 1;
        if (args.length > 0) {
            const parsed = parseInt(args[0]);
            if (!isNaN(parsed) && parsed > 0 && parsed <= 50) {
                limit = parsed;
            }
        }
        if (args.length > 1) {
            const parsedPage = parseInt(args[1]);
            if (!isNaN(parsedPage) && parsedPage > 0) {
                page = parsedPage;
            }
        }

        const scope = await getCurrentStorageScope();
        const offset = (page - 1) * limit;
        const result = await query(`
            SELECT id, name, type, size, folder, created_at
            FROM files
            WHERE ${scope.clause}
            ORDER BY created_at DESC
            LIMIT ${nextParam(scope, 1)} OFFSET ${nextParam(scope, 2)}
        `, [...scope.params, limit, offset]);

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
            message: '❌ 请提供要删除的文件 ID 前缀\n\n用法：/delete <至少 8 位 ID 前缀>\n提示：发送 /list 可查看最近文件及 ID，也可从 Web 文件预览复制完整 ID。'
        });
        return;
    }

    const selector = args[0].trim();

    try {
        const scope = await getCurrentStorageScope();
        if (/^\d+$/.test(selector)) {
            await message.reply({ message: '❌ 为避免误删，Telegram Bot 不支持按列表序号删除。请发送 /list 并复制至少 8 位文件 ID 前缀。' });
            return;
        }
        if (selector.length < 8) {
            await message.reply({ message: '❌ ID 前缀至少需要 8 位。请从网页端文件列表复制更长的文件 ID。' });
            return;
        }
        const result = await query(`
            SELECT *
            FROM files
            WHERE ${scope.clause} AND id::text LIKE ${nextParam(scope, 1)}
            ORDER BY created_at DESC
            LIMIT 3
        `, [...scope.params, selector + '%']);

        if (result.rows.length === 0) {
            await message.reply({ message: `❌ 未找到 ID 以 "${selector}" 开头的文件` });
            return;
        }
        if (result.rows.length > 1) {
            await message.reply({ message: `❌ ID 前缀 "${selector}" 匹配到多个文件，请复制更长的 ID 前缀后重试。` });
            return;
        }

        const file = result.rows[0];
        const sent = await message.reply({
            message: [
                '⚠️ **确认删除这个文件？**',
                '',
                `📄 ${file.name}`,
                `🆔 ${String(file.id).slice(0, 12)}`,
                `📦 ${formatBytes(Number(file.size || 0))}`,
                file.folder ? `📁 ${file.folder}` : '',
                '',
                '删除会移除数据库记录并尝试删除实际文件。请确认无误后点击按钮。',
            ].filter(Boolean).join('\n'),
        }) as Api.Message;
        const chatId = canonicalTelegramChatKey(message.chatId?.toString());
        if (!chatId || !sent?.id) throw new Error('无法绑定删除确认消息');
        const confirmId = destructiveConfirmations.issue({
            actorId: message.senderId!.toJSNumber(),
            chatId,
            messageId: sent.id,
            action: 'delete_file',
            objectId: String(file.id),
        });
        pendingDeleteConfirmations.set(confirmId, {
            fileId: file.id,
            name: file.name,
            size: Number(file.size || 0),
            selector,
            actorId: message.senderId!.toJSNumber(),
            chatId,
            messageId: sent.id,
        });
        await sent.edit({
            text: sent.message,
            buttons: buildDeleteConfirmKeyboard(confirmId),
        });
    } catch (error) {
        console.error('🤖 删除文件失败:', error);
        await message.reply({ message: `${MSG.ERR_DELETE}: ${(error as Error).message}` });
    }
}

export async function handleDeleteConfirmCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const match = data.match(/^del_(confirm|cancel)_(.+)$/);
    if (!match) return;
    const [, action, confirmId] = match;
    const pending = pendingDeleteConfirmations.get(confirmId);
    if (!pending) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '删除确认无效或已过期', alert: true }));
        return;
    }
    const binding = {
        actorId: userId,
        chatId: getCallbackChatKey(update),
        messageId: Number(update.msgId),
        action: 'delete_file' as const,
        objectId: pending.fileId,
    };
    if (action === 'cancel') {
        if (!destructiveConfirmations.cancel(confirmId, binding)) {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '删除确认不属于你或已过期', alert: true }));
            return;
        }
        pendingDeleteConfirmations.delete(confirmId);
        await client.editMessage(update.peer, { message: Number(update.msgId), text: `已取消删除：${pending.name}`, buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
        return;
    }
    const consumed = destructiveConfirmations.consume(confirmId, binding);
    if (consumed.status !== 'ok') {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '删除确认不属于你、已过期或已使用', alert: true }));
        return;
    }
    pendingDeleteConfirmations.delete(confirmId);
    try {
        const scope = await getCurrentStorageScope();
        const result = await query(`SELECT * FROM files WHERE ${scope.clause} AND id = ${nextParam(scope, 1)} LIMIT 1`, [...scope.params, pending.fileId]);
        const file = result.rows[0];
        if (!file) {
            pendingDeleteConfirmations.delete(confirmId);
            await client.editMessage(update.peer, { message: Number(update.msgId), text: '❌ 文件已不存在或不在当前存储范围内。', buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '文件不存在', alert: true }));
            return;
        }
        await removePhysicalFile(file);
        await query('DELETE FROM files WHERE id = $1', [file.id]);
        await client.editMessage(update.peer, { message: Number(update.msgId), text: buildDeleteSuccess(file.name, file.id), buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已删除' }));
    } catch (error) {
        console.error('🤖 确认删除文件失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `删除失败: ${(error as Error).message}`, alert: true }));
    }
}

function buildTaskCenterMarkup(rows: TaskCenterButton[][]): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: rows.map(row => new Api.KeyboardButtonRow({
            buttons: row.map(button => new Api.KeyboardButtonCallback({
                text: button.text,
                data: Buffer.from(button.data),
            })),
        })),
    });
}

function mergeChannelExecutionState(item: TaskCenterItem | null, row: any): TaskCenterItem | null {
    if (!item) return null;
    const executionGroup = getChannelExecutionGroup(String(row.id));
    if (!executionGroup) return item;
    item.active = executionGroup.active;
    item.pending = executionGroup.pending;
    item.currentFileName = executionGroup.currentFileName || item.currentFileName;
    if (row.status === 'paused') item.state = executionGroup.active > 0 ? 'pausing' : 'paused';
    return item;
}

async function loadTaskCenterItems(chatId: string, userId: number): Promise<TaskCenterItem[]> {
    const ordinaryItems = listDownloadTaskGroups(chatId, userId)
        .map(ordinaryTaskCenterItem)
        .filter((item): item is TaskCenterItem => Boolean(item));
    const [channelRows, ytdlpRows] = await Promise.all([
        listTelegramActiveTaskQueues(userId, 1000),
        listTransferTasks({ sourceType: 'ytdlp', ownerUserId: userId, limit: 500 }),
    ]);
    const channelItems = channelRows
        .filter(row => String(row.chat_id || '') === chatId)
        .map(row => {
            const paramsSource = row.params;
            const params = typeof paramsSource === 'string'
                ? (() => { try { const parsed = JSON.parse(paramsSource); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } })()
                : (paramsSource && typeof paramsSource === 'object' && !Array.isArray(paramsSource) ? paramsSource : {});
            const folder = row.folder_override || params.folderOverride || null;
            return mergeChannelExecutionState(channelTaskCenterItem({ ...row, folder_override: folder }), row);
        })
        .filter((item): item is TaskCenterItem => Boolean(item));
    const ytdlpItems = ytdlpRows
        .filter(task => String(task.chatId || '') === chatId)
        .map(ytdlpTaskCenterItem)
        .filter((item): item is TaskCenterItem => Boolean(item));
    return [...ordinaryItems, ...channelItems, ...ytdlpItems];
}

async function findTaskCenterItem(
    sourceType: TaskCenterSourceType,
    id: string,
    chatId: string,
    userId: number,
): Promise<TaskCenterItem | null> {
    if (sourceType === 'memory') {
        const group = getDownloadTaskGroup(id, chatId, userId);
        return group ? ordinaryTaskCenterItem(group) : null;
    }
    if (sourceType === 'ytdlp') {
        const tasks = await listTransferTasks({ sourceType: 'ytdlp', ownerUserId: userId, limit: 500 });
        const matches = tasks.filter(task => String(task.chatId || '') === chatId && task.id.toLowerCase().startsWith(id.toLowerCase()));
        return matches.length === 1 ? ytdlpTaskCenterItem(matches[0]) : null;
    }
    const rows = await listTelegramActiveTaskQueues(userId, 1000);
    const matches = rows.filter(job => String(job.chat_id || '') === chatId && String(job.id).toLowerCase().startsWith(id.toLowerCase()));
    if (matches.length !== 1) return null;
    const row = matches[0];
    if (String(row.chat_id || '') !== chatId) return null;
    const paramsSource = row.params;
    const params = typeof paramsSource === 'string'
        ? (() => { try { const parsed = JSON.parse(paramsSource); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } })()
        : (paramsSource && typeof paramsSource === 'object' && !Array.isArray(paramsSource) ? paramsSource : {});
    if (!row.folder_override && params.folderOverride) row.folder_override = params.folderOverride;
    return mergeChannelExecutionState(channelTaskCenterItem(row), row);
}

async function editTaskCenterView(
    client: TelegramClient,
    update: Api.UpdateBotCallbackQuery,
    view: TaskCenterView,
): Promise<void> {
    try {
        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: view.text,
            buttons: buildTaskCenterMarkup(view.rows),
        });
    } catch (error) {
        if (!isTelegramMessageNotModified(error)) throw error;
    }
}

async function renderTaskCenterList(
    client: TelegramClient,
    update: Api.UpdateBotCallbackQuery,
    userId: number,
    chatId: string,
    page: number,
): Promise<void> {
    const items = await loadTaskCenterItems(chatId, userId);
    await editTaskCenterView(client, update, buildTaskCenterPage(items, page));
}

export async function handleTasks(message: Api.Message): Promise<void> {
    try {
        const senderId = message.senderId?.toJSNumber();
        const chatId = message.chatId?.toString();
        if (!senderId || !chatId) {
            await message.reply({ message: MSG.ERR_TASKS });
            return;
        }
        const items = await loadTaskCenterItems(chatId, senderId);
        const view = buildTaskCenterPage(items, 0);
        const sent = await message.reply({ message: view.text, buttons: buildTaskCenterMarkup(view.rows) }) as Api.Message;
        if (sent?.id) taskCenterCardOwners.set(taskCenterCardKey(chatId, sent.id), { userId: senderId, expiresAt: Date.now() + TASK_CENTER_CARD_TTL_MS });
    } catch (error) {
        console.error('🤖 获取任务中心失败:', error);
        await message.reply({ message: MSG.ERR_TASKS });
    }
}

async function operateChannelTaskCenterItem(
    action: 'start' | 'pause' | 'resume' | 'retry' | 'cancel_confirm',
    userId: number,
    chatId: string,
    id: string,
): Promise<{ ok: boolean; toast: string }> {
    if (action === 'retry') return { ok: false, toast: '该频道任务请使用现有失败重试入口' };
    const rows = await listTelegramActiveTaskQueues(userId, 1000);
    const matches = rows.filter(job => String(job.chat_id || '') === chatId && String(job.id).toLowerCase().startsWith(id.toLowerCase()));
    if (matches.length !== 1) return { ok: false, toast: matches.length > 1 ? '任务 ID 前缀不唯一，请刷新任务列表' : '任务已结束或已失效' };
    const row = matches[0];
    const fullId = String(row.id);
    if (action === 'pause') {
        if (row.status !== 'running') return { ok: false, toast: '任务当前不在运行状态' };
        const job = await pauseTelegramBackgroundJob(userId, fullId, chatId);
        if (!job) return { ok: false, toast: '任务已结束或无法暂停' };
        const executionGroup = getChannelExecutionGroup(fullId);
        if (executionGroup) pauseChannelExecutionGroup(fullId);
        return { ok: true, toast: executionGroup?.active ? '将在完成当前文件后暂停' : '任务已暂停' };
    }
    if (action === 'resume' || action === 'start') {
        if (action === 'start' && row.status === 'running') {
            const prioritized = prioritizeChannelExecutionGroup(fullId);
            return prioritized.status === 'ok'
                ? { ok: true, toast: '已提升到等待队列前面' }
                : { ok: false, toast: '任务当前没有可优先的等待文件' };
        }
        const job = await resumeTelegramBackgroundJob(userId, fullId, chatId);
        if (!job) return { ok: false, toast: '任务不在可继续状态' };
        resumeChannelExecutionGroup(fullId);
        return { ok: true, toast: '任务已继续' };
    }
    const job = await cancelTelegramBackgroundJob(userId, fullId, chatId);
    if (!job) return { ok: false, toast: '任务已结束或无法取消' };
    cancelChannelExecutionGroup(fullId);
    return { ok: true, toast: '任务已取消' };
}

async function cancelYtDlpTaskCenterItem(userId: number, chatId: string, id: string): Promise<{ ok: boolean; toast: string }> {
    const tasks = await listTransferTasks({ sourceType: 'ytdlp', ownerUserId: userId, limit: 500 });
    const matches = tasks.filter(task => String(task.chatId || '') === chatId && task.id.toLowerCase().startsWith(id.toLowerCase()));
    if (matches.length !== 1) return { ok: false, toast: matches.length > 1 ? '任务 ID 前缀不唯一，请刷新任务列表' : '任务已结束或已失效' };
    const cancelled = await cancelYtDlpTask(matches[0].id);
    return cancelled?.status === 'cancelled'
        ? { ok: true, toast: 'yt-dlp 任务已取消' }
        : { ok: false, toast: '任务已结束或无法取消' };
}

async function retryYtDlpTaskCenterItem(userId: number, chatId: string, id: string): Promise<{ ok: boolean; toast: string }> {
    const tasks = await listTransferTasks({ sourceType: 'ytdlp', ownerUserId: userId, limit: 500 });
    const matches = tasks.filter(task => String(task.chatId || '') === chatId && task.id.toLowerCase().startsWith(id.toLowerCase()));
    if (matches.length !== 1) return { ok: false, toast: matches.length > 1 ? '任务 ID 前缀不唯一，请刷新任务列表' : '任务已结束或已失效' };
    const retried = await retryYtDlpTask(matches[0].id);
    return retried?.status === 'pending' || retried?.status === 'running'
        ? { ok: true, toast: 'yt-dlp 任务已重新排队' }
        : { ok: false, toast: '任务存在未完成对账或当前无法重试' };
}

const pendingTaskCenterCancels = new Map<string, { userId: number; chatId: string; messageId: number; sourceType: TaskCenterSourceType; taskId: string; expiresAt: number }>();
const taskCenterCardOwners = new Map<string, { userId: number; expiresAt: number }>();
const TASK_CENTER_CONFIRM_TTL_MS = 2 * 60 * 1000;
const TASK_CENTER_CARD_TTL_MS = 24 * 60 * 60 * 1000;

function taskCenterCardKey(chatId: string, messageId: number): string {
    return `${chatId}:${messageId}`;
}

function taskCenterCancelKey(userId: number, chatId: string, messageId: number): string {
    return `${userId}:${chatId}:${messageId}`;
}

export async function handleTaskCenterCallback(
    client: TelegramClient,
    update: Api.UpdateBotCallbackQuery,
    data: string,
): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const parsed = parseTaskCenterCallback(data);
    if (!parsed) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '任务按钮无效或已过期', alert: true }));
        return;
    }
    const chatId = getCallbackChatKey(update);
    const ownerKey = taskCenterCardKey(chatId, Number(update.msgId));
    const owner = taskCenterCardOwners.get(ownerKey);
    if (!owner) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '旧任务卡已失效，请重新发送 /tasks', alert: true }));
        return;
    }
    if (owner.expiresAt < Date.now() || owner.userId !== userId) {
        if (owner.expiresAt < Date.now()) taskCenterCardOwners.delete(ownerKey);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '该任务卡不属于你或已过期', alert: true }));
        return;
    }
    owner.expiresAt = Date.now() + TASK_CENTER_CARD_TTL_MS;
    try {
        if (parsed.view === 'list') {
            await renderTaskCenterList(client, update, userId, chatId, parsed.page);
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '任务列表已刷新' }));
            return;
        }

        const item = await findTaskCenterItem(parsed.sourceType, parsed.id, chatId, userId);
        if (!item) {
            await renderTaskCenterList(client, update, userId, chatId, parsed.page);
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '任务已结束或已失效', alert: true }));
            return;
        }

        if (parsed.view === 'detail') {
            await editTaskCenterView(client, update, buildTaskCenterDetail(item, parsed.page));
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
            return;
        }
        if (parsed.action === 'cancel_prompt') {
            pendingTaskCenterCancels.set(taskCenterCancelKey(userId, chatId, Number(update.msgId)), {
                userId,
                chatId,
                messageId: Number(update.msgId),
                sourceType: parsed.sourceType,
                taskId: parsed.id,
                expiresAt: Date.now() + TASK_CENTER_CONFIRM_TTL_MS,
            });
            await editTaskCenterView(client, update, buildTaskCancelConfirm(item, parsed.page));
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请确认是否取消' }));
            return;
        }
        if (parsed.action === 'cancel_confirm') {
            const confirmationKey = taskCenterCancelKey(userId, chatId, Number(update.msgId));
            const pending = pendingTaskCenterCancels.get(confirmationKey);
            pendingTaskCenterCancels.delete(confirmationKey);
            if (!pending || pending.expiresAt < Date.now() || pending.sourceType !== parsed.sourceType || pending.taskId !== parsed.id) {
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '取消确认已过期，请重新进入任务详情', alert: true }));
                return;
            }
        }
        if (parsed.action === 'retry' && parsed.sourceType !== 'ytdlp') {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '该任务类型不支持此重试按钮', alert: true }));
            return;
        }

        let ok = false;
        let toast = '';
        if (parsed.sourceType === 'memory') {
            const result = parsed.action === 'start'
                ? prioritizeDownloadTaskGroup(parsed.id, chatId, userId)
                : parsed.action === 'pause'
                    ? pauseDownloadTaskGroup(parsed.id, chatId, userId)
                    : parsed.action === 'resume'
                        ? resumeDownloadTaskGroup(parsed.id, chatId, userId)
                        : cancelDownloadTaskGroup(parsed.id, chatId, userId);
            ok = result.status === 'ok';
            if (ok && (parsed.action === 'pause' || parsed.action === 'resume')) {
                await refreshSilentProgress(client, update.peer, userId, {
                    paused: result.group?.state === 'paused',
                    pausing: result.group?.state === 'pausing',
                    reason: parsed.action === 'pause'
                        ? result.group?.state === 'pausing'
                            ? '正在完成当前文件，随后暂停'
                            : '用户已暂停任务'
                        : undefined,
                });
                if (parsed.action === 'pause' && result.group?.state === 'pausing') {
                    setTimeout(() => {
                        void refreshSilentProgress(client, update.peer, userId).catch(error => {
                            console.error('🤖 暂停状态延迟刷新失败:', error);
                        });
                    }, 1500);
                }
            }
            toast = ok
                ? parsed.action === 'start'
                    ? '已提升到等待队列前面'
                    : parsed.action === 'pause'
                        ? (result.group?.state === 'pausing' ? '将在完成当前文件后暂停' : '任务已暂停')
                        : parsed.action === 'resume'
                            ? '任务已继续'
                            : '任务已取消'
                : result.status === 'blocked'
                    ? '任务由系统保护暂停，需等待系统条件恢复'
                    : result.status === 'forbidden'
                        ? '任务不属于当前聊天'
                        : '任务已结束或已失效';
        } else if (parsed.sourceType === 'channel') {
            const result = await operateChannelTaskCenterItem(parsed.action, userId, chatId, parsed.id);
            ok = result.ok;
            toast = result.toast;
        } else if (parsed.action === 'cancel_confirm') {
            const result = await cancelYtDlpTaskCenterItem(userId, chatId, parsed.id);
            ok = result.ok;
            toast = result.toast;
        } else if (parsed.action === 'retry') {
            const result = await retryYtDlpTaskCenterItem(userId, chatId, parsed.id);
            ok = result.ok;
            toast = result.toast;
        } else {
            toast = 'yt-dlp 任务不支持该操作';
        }

        if (parsed.action === 'cancel_confirm' || !ok) {
            await renderTaskCenterList(client, update, userId, chatId, parsed.page);
        } else {
            const refreshed = await findTaskCenterItem(parsed.sourceType, parsed.id, chatId, userId);
            if (refreshed) {
                await editTaskCenterView(client, update, buildTaskCenterDetail(refreshed, parsed.page));
            } else {
                await renderTaskCenterList(client, update, userId, chatId, parsed.page);
            }
        }
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: toast, alert: !ok }));
    } catch (error) {
        console.error('🤖 任务中心按钮操作失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: `操作失败: ${(error as Error).message}`,
            alert: true,
        }));
    }
}

async function getBulkTaskImpact(userId: number, chatId: string): Promise<BulkTaskImpact> {
    const ordinaryGroups = listDownloadTaskGroups(chatId, userId)
        .map(ordinaryTaskCenterItem)
        .filter((item): item is TaskCenterItem => Boolean(item));
    const [channelRows, ytdlpRows] = await Promise.all([
        listTelegramActiveTaskQueues(userId, 1000),
        listTransferTasks({ sourceType: 'ytdlp', ownerUserId: userId, limit: 500 }),
    ]);
    return {
        ordinaryTasks: ordinaryGroups.length,
        ordinaryActiveFiles: ordinaryGroups.reduce((sum, item) => sum + item.active, 0),
        ordinaryPendingFiles: ordinaryGroups.reduce((sum, item) => sum + item.pending, 0),
        channelTasks: channelRows.filter(row => String(row.chat_id || '') === chatId).length,
        ytdlpTasks: ytdlpRows.filter(task => String(task.chatId || '') === chatId && ['pending', 'running', 'paused'].includes(task.status)).length,
    };
}

function bulkImpactTotal(impact: BulkTaskImpact): number {
    return impact.ordinaryTasks + impact.channelTasks + impact.ytdlpTasks;
}

async function requestBulkTaskCancellation(message: Api.Message): Promise<void> {
    const actorId = message.senderId?.toJSNumber();
    const chatId = canonicalTelegramChatKey(message.chatId?.toString());
    if (!actorId || !chatId) {
        await message.reply({ message: '📮 无法识别当前聊天，未取消任务' });
        return;
    }
    const impact = await getBulkTaskImpact(actorId, chatId);
    if (bulkImpactTotal(impact) === 0) {
        await message.reply({ message: '📮 当前聊天没有可取消的任务' });
        return;
    }
    const sent = await message.reply({
        message: [
            '⚠️ **确认取消当前聊天全部任务？**',
            '',
            `普通下载：${impact.ordinaryTasks} 个任务（处理中 ${impact.ordinaryActiveFiles} 个文件，等待 ${impact.ordinaryPendingFiles} 个文件）`,
            `频道任务：${impact.channelTasks} 个`,
            `yt-dlp：${impact.ytdlpTasks} 个`,
            '',
            '确认后会中止正在运行的任务并清理对应临时文件。其它聊天和其它用户的任务不受影响。',
        ].join('\n'),
    }) as Api.Message;
    if (!sent?.id) throw new Error('无法绑定批量任务确认消息');
    const confirmId = destructiveConfirmations.issue({
        actorId,
        chatId,
        messageId: sent.id,
        action: 'cancel_task_scope',
    });
    pendingBulkTaskCancellations.set(confirmId, { actorId, chatId, messageId: sent.id });
    await sent.edit({ text: sent.message, buttons: buildBulkTaskCancelKeyboard(confirmId) });
}

async function cancelTasksForScope(userId: number, chatId: string): Promise<BulkTaskImpact> {
    const [channelRows, ytdlpRows] = await Promise.all([
        listTelegramActiveTaskQueues(userId, 1000),
        listTransferTasks({ sourceType: 'ytdlp', ownerUserId: userId, limit: 500 }),
    ]);
    let channelTasks = 0;
    for (const row of channelRows.filter(item => String(item.chat_id || '') === chatId)) {
        const cancelled = await cancelTelegramBackgroundJob(userId, String(row.id), chatId);
        if (!cancelled) continue;
        channelTasks += 1;
        cancelChannelExecutionGroup(String(row.id));
    }
    let ytdlpTasks = 0;
    for (const task of ytdlpRows.filter(item => String(item.chatId || '') === chatId && ['pending', 'running', 'paused'].includes(item.status))) {
        const cancelled = await cancelYtDlpTask(task.id);
        if (cancelled?.status === 'cancelled') ytdlpTasks += 1;
    }
    const ordinaryTasks = listDownloadTaskGroups(chatId, userId)
        .map(ordinaryTaskCenterItem)
        .filter((item): item is TaskCenterItem => Boolean(item)).length;
    const ordinary = forceStopDownloadTasksForScope(chatId, userId, '用户确认取消当前聊天全部任务');
    return {
        ordinaryTasks,
        ordinaryActiveFiles: ordinary.active,
        ordinaryPendingFiles: ordinary.pending,
        channelTasks,
        ytdlpTasks,
    };
}

export async function handleBulkTaskCancelCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const match = data.match(/^bulk_task_(confirm|cancel)_([A-Za-z0-9_-]+)$/);
    if (!match) return;
    const [, action, confirmId] = match;
    const pending = pendingBulkTaskCancellations.get(confirmId);
    if (!pending) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '批量取消确认无效或已过期', alert: true }));
        return;
    }
    const binding = {
        actorId: userId,
        chatId: getCallbackChatKey(update),
        messageId: Number(update.msgId),
        action: 'cancel_task_scope' as const,
    };
    if (action === 'cancel') {
        if (!destructiveConfirmations.cancel(confirmId, binding)) {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '该确认不属于你或已过期', alert: true }));
            return;
        }
        pendingBulkTaskCancellations.delete(confirmId);
        await client.editMessage(update.peer, { message: Number(update.msgId), text: '已返回，当前聊天任务未被取消。', buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已返回' }));
        return;
    }
    const consumed = destructiveConfirmations.consume(confirmId, binding);
    pendingBulkTaskCancellations.delete(confirmId);
    if (consumed.status !== 'ok') {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '该确认不属于你、已过期或已使用', alert: true }));
        return;
    }
    try {
        const result = await cancelTasksForScope(userId, pending.chatId);
        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: [
                '🛑 **当前聊天任务已取消**',
                '',
                `普通下载：${result.ordinaryTasks} 个任务（处理中 ${result.ordinaryActiveFiles} / 等待 ${result.ordinaryPendingFiles} 个文件）`,
                `频道任务：${result.channelTasks} 个`,
                `yt-dlp：${result.ytdlpTasks} 个`,
            ].join('\n'),
            buttons: new Api.ReplyInlineMarkup({ rows: [] }),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '当前聊天任务已取消' }));
    } catch (error) {
        console.error('🤖 批量取消当前聊天任务失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `取消失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleStopTasks(message: Api.Message): Promise<void> {
    try {
        await requestBulkTaskCancellation(message);
    } catch (error) {
        console.error('🤖 强制停止任务失败:', error);
        await message.reply({ message: `❌ 强制停止任务失败: ${(error as Error).message}` });
    }
}

export async function handlePauseTasks(message: Api.Message, args: string[] = []): Promise<void> {
    const taskId = args[0];
    const senderId = message.senderId?.toJSNumber();
    const chatId = message.chatId?.toString();
    if (taskId && senderId && chatId) {
        const ordinary = pauseDownloadTaskGroup(taskId, chatId, senderId);
        if (ordinary.status === 'ok') {
            if (message.client && message.chatId) {
                await refreshSilentProgress(message.client as TelegramClient, message.chatId, senderId, {
                    paused: ordinary.group?.state === 'paused',
                    pausing: ordinary.group?.state === 'pausing',
                    reason: ordinary.group?.state === 'pausing' ? '正在完成当前文件，随后暂停' : '用户已暂停任务',
                }).catch(error => console.error('🤖 暂停命令刷新任务卡失败:', error));
            }
            await message.reply({ message: ordinary.group?.state === 'pausing' ? '⏸️ 已设置：完成当前文件后暂停该任务' : '⏸️ 已暂停该任务' });
            return;
        }
        const job = await pauseTelegramBackgroundJob(senderId, taskId, chatId);
        if (job) {
            const executionGroup = getChannelExecutionGroup(String(job.id));
            if (executionGroup) pauseChannelExecutionGroup(String(job.id));
            await message.reply({ message: `⏸️ 已暂停频道任务 ${String(job.id).slice(0, 12)}\n来源：${job.source}` });
            return;
        }
        await message.reply({ message: `📮 没有找到任务：${taskId}。未暂停当前聊天下载队列。` });
        return;
    }
    const result = pauseDownloadTasks(undefined, chatId, senderId);
    if (senderId && chatId && message.client) {
        const scopeStatus = getDownloadTaskScopeStatus(chatId, senderId);
        if (scopeStatus.paused || scopeStatus.pausing) {
            await refreshSilentProgress(message.client as TelegramClient, message.chatId!, senderId).catch(error => {
                console.error('🤖 暂停命令刷新任务卡失败:', error);
            });
        }
    }
    await message.reply({ message: taskId
        ? `📮 没有找到任务：${taskId}。未暂停当前聊天任务。`
        : `⏸️ 已暂停当前聊天的普通下载任务\n\n进行中: ${result.active}\n等待中: ${result.pending}\n\n当前正在下载的文件会继续完成，新的等待任务暂不开始。` });
}

export async function handleResumeTasks(message: Api.Message, args: string[] = []): Promise<void> {
    const taskId = args[0];
    const senderId = message.senderId?.toJSNumber();
    const chatId = message.chatId?.toString();
    if (taskId && senderId && chatId) {
        const ordinary = resumeDownloadTaskGroup(taskId, chatId, senderId);
        if (ordinary.status === 'ok') {
            if (message.client && message.chatId) {
                await refreshSilentProgress(message.client as TelegramClient, message.chatId, senderId).catch(error => {
                    console.error('🤖 继续命令刷新任务卡失败:', error);
                });
            }
            await message.reply({ message: '▶️ 已继续该任务' });
            return;
        }
        const job = await resumeTelegramBackgroundJob(senderId, taskId, chatId);
        if (job) {
            resumeChannelExecutionGroup(String(job.id));
            await message.reply({ message: `▶️ 已继续频道任务 ${String(job.id).slice(0, 12)}\n来源：${job.source}` });
            return;
        }
        await message.reply({ message: `📮 没有找到任务：${taskId}。未继续当前聊天下载队列。` });
        return;
    }
    const result = resumeDownloadTasks(undefined, chatId, senderId);
    if (senderId && message.client && message.chatId) {
        await refreshSilentProgress(message.client as TelegramClient, message.chatId, senderId).catch(error => {
            console.error('🤖 继续命令刷新任务卡失败:', error);
        });
    }
    await message.reply({ message: taskId
        ? `📮 没有找到任务：${taskId}。未继续当前聊天任务。`
        : `▶️ 已继续当前聊天的普通下载任务\n\n进行中: ${result.active}\n等待中: ${result.pending}` });
}

export async function handleCancelTask(message: Api.Message, args: string[]): Promise<void> {
    const selector = args.join(' ').trim() || 'all';
    const senderId = message.senderId?.toJSNumber();
    const chatId = message.chatId?.toString();
    if (senderId) {
        if (selector === 'all') {
            await requestBulkTaskCancellation(message);
            return;
        } else {
            if (chatId) {
                const ordinary = cancelDownloadTaskGroup(selector, chatId, senderId);
                if (ordinary.status === 'ok') {
                    await message.reply({ message: '🛑 已取消该下载任务' });
                    return;
                }
            }
            const job = await cancelTelegramBackgroundJob(senderId, selector, chatId);
            if (job) {
                cancelChannelExecutionGroup(String(job.id));
                await message.reply({ message: `🛑 已取消频道任务 ${String(job.id).slice(0, 12)}\n来源：${job.source}` });
                return;
            }
            if (chatId) {
                const ytdlpTasks = await listTransferTasks({ sourceType: 'ytdlp', ownerUserId: senderId, limit: 500 });
                const matches = ytdlpTasks.filter(task => String(task.chatId || '') === chatId && task.id.toLowerCase().startsWith(selector.toLowerCase()));
                if (matches.length === 1) {
                    const cancelled = await cancelYtDlpTask(matches[0].id);
                    if (cancelled?.status === 'cancelled') {
                        await message.reply({ message: `🛑 已取消 yt-dlp 任务 ${matches[0].id}` });
                        return;
                    }
                } else if (matches.length > 1) {
                    await message.reply({ message: '📮 yt-dlp 任务 ID 前缀不唯一，请提供更长的 ID。' });
                    return;
                }
            }
        }
    }
    await message.reply({ message: `📮 没有找到当前聊天中的匹配任务：${selector}` });
}

export async function handleChannelTaskQueueCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const match = data.match(/^ctq_(pause|resume|cancel)_([0-9a-f]{4,}|all)$/i);
    if (!match) return;
    const [, action, selector] = match;
    try {
        if (action === 'cancel') {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: '旧版取消按钮已失效，请使用新版 /tasks 重新进入任务详情并确认',
                alert: true,
            }));
            return;
        }
        const rows = await listTelegramActiveTaskQueues(userId, 1000);
        const callbackChatId = getCallbackChatKey(update);
        const matches = rows.filter(job => String(job.chat_id || '') === callbackChatId && String(job.id).toLowerCase().startsWith(selector.toLowerCase()));
        if (matches.length !== 1) {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: matches.length > 1 ? '任务 ID 前缀不唯一，请使用新版 /tasks 刷新' : '任务已结束或已失效', alert: true }));
            return;
        }
        const legacyAction = action as 'pause' | 'resume';
        const result = await operateChannelTaskCenterItem(legacyAction, userId, callbackChatId, selector);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: result.toast, alert: !result.ok }));
    } catch (error) {
        console.error('🤖 兼容频道任务按钮操作失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `操作失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleRetryFailedTasks(message: Api.Message, args: string[]): Promise<void> {
    const senderId = message.senderId?.toJSNumber();
    const jobSelector = args.find(arg => /^[0-9a-f-]{4,36}$/i.test(arg));
    const chatId = message.chatId?.toString();
    const jobRetry = senderId && jobSelector && chatId ? await retryTelegramBackgroundJob(senderId, jobSelector, chatId) : null;
    if (jobSelector) {
        if (!jobRetry) {
            await message.reply({ message: '📮 没有找到唯一的频道任务，未重试其它任务。' });
            return;
        }
        await message.reply({ message: jobRetry.retried > 0 ? `🔄 已重新加入频道任务失败项 ${jobRetry.retried} 个\n任务: ${String(jobRetry.id).slice(0, 12)}` : '📮 该频道任务没有可重试失败项' });
        return;
    }

    const taskId = args.find(arg => /^[sam][a-z0-9-]+$/i.test(arg));
    const numericArg = args.find(arg => /^\d+$/.test(arg));
    const limit = Math.max(1, Math.min(50, parseInt(numericArg || '10', 10) || 10));
    if (!senderId || !chatId) {
        await message.reply({ message: '📮 无法识别当前聊天，未执行失败任务重试。' });
        return;
    }
    if (taskId) {
        const group = getDownloadTaskGroup(taskId, chatId, senderId);
        if (!group) {
            await message.reply({ message: `📮 没有找到当前聊天中的失败任务：${taskId}` });
            return;
        }
    }
    const result = await retryFailedDownloadTasks(limit, taskId, chatId, senderId);
    await message.reply({ message: result.retried > 0 ? `🔄 已重新加入 ${result.retried} 个失败任务${taskId ? `\n任务: ${taskId}` : ''}` : '📮 最近没有可重试的失败任务' });
}

export async function handleDownloadWorkers(message: Api.Message): Promise<void> {
    try {
        const current = await getCurrentDownloadWorkers();
        await message.reply({
            message: buildDownloadWorkersText(current),
            buttons: buildDownloadWorkersKeyboard(current),
        });
    } catch (error) {
        console.error('🤖 获取分片并发设置失败:', error);
        await message.reply({ message: `❌ 获取分片并发设置失败: ${(error as Error).message}` });
    }
}

export async function handleFileConcurrency(message: Api.Message): Promise<void> {
    try {
        const current = await getCurrentFileConcurrency();
        setFileDownloadConcurrency(current);
        await message.reply({
            message: buildFileConcurrencyText(current),
            buttons: buildFileConcurrencyKeyboard(current),
        });
    } catch (error) {
        console.error('🤖 获取文件级并发设置失败:', error);
        await message.reply({ message: `❌ 获取文件级并发设置失败: ${(error as Error).message}` });
    }
}

export async function handlePathRules(message: Api.Message): Promise<void> {
    const pathCenterState = await getPathCenterState();
    await message.reply({
        message: buildPathSettingsText(pathCenterState, message.chatId?.toString() || 'unknown'),
        buttons: buildPathSettingsKeyboard(pathCenterState),
    });
}

export async function handlePathOnce(message: Api.Message, args: string[]): Promise<void> {
    const folder = args.join(' ').trim();
    if (!folder) {
        await message.reply({ message: '❌ 用法：/p <目录>\n例如：/p PIXIV/每日Top50' });
        return;
    }
    try {
        const normalized = await setNextTelegramPathPersistent(message.chatId?.toString() || 'unknown', folder);
        await message.reply({ message: `📌 已设置下一次下载目录：\`${normalized}\`\n${buildPathPreviewLine(normalized)}\n\n此设置会在下一次成功进入下载流程时自动失效。` });
    } catch (error) {
        await message.reply({ message: `❌ 路径无效：${(error as Error).message}` });
    }
}

export async function handlePathSession(message: Api.Message, args: string[]): Promise<void> {
    const folder = args.join(' ').trim();
    if (!folder) {
        await message.reply({ message: '❌ 用法：/ps <目录>\n例如：/ps 相册/2026-07' });
        return;
    }
    try {
        const normalized = await setSessionTelegramPathPersistent(message.chatId?.toString() || 'unknown', folder);
        await message.reply({ message: `📍 已设置本会话下载目录：\`${normalized}\`\n${buildPathPreviewLine(normalized)}\n\n后续此聊天中的下载会优先保存到该目录，发送 /pc 可清除。` });
    } catch (error) {
        await message.reply({ message: `❌ 路径无效：${(error as Error).message}` });
    }
}

export async function handlePathClear(message: Api.Message): Promise<void> {
    await clearTelegramPathStatePersistent(message.chatId?.toString() || 'unknown');
    await message.reply({ message: '🧹 已清除下一次/本会话自定义下载目录，后续恢复使用默认自动分类目录。' });
}

export async function handlePathRulesCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const pathCenterState = await getPathCenterState();
        const chatKey = getCallbackChatKey(update);
        if (data === 'pr_clear_custom') {
            await clearTelegramPathStatePersistent(chatKey);
        } else if (data === 'pr_recent') {
            const recent = await getRecentTelegramPathsPersistent(chatKey);
            await client.sendMessage(update.peer, {
                message: recent.length > 0
                    ? ['🕘 **最近使用目录**', '', ...recent.map((item, index) => `${index + 1}. ${item}`), '', '要使用其中一个目录，请直接复制发送，或发送 `/p <目录>` / `/ps <目录>`。'].join('\n')
                    : '🕘 暂无最近使用目录。设置过 `/p`、`/ps`、订阅专属目录或下载任务专属目录后会自动记录。'
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已发送最近目录' }));
            return;
        } else if (data === 'pr_help_once' || data === 'pr_help_session') {
            const mode = data === 'pr_help_once' ? 'once' : 'session';
            setPendingTelegramPathInput(chatKey, userId, mode);
            await client.sendMessage(update.peer, { message: await buildPendingPathPromptPersistent(mode, chatKey) });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请直接发送目录，或发送“取消”退出' }));
            return;
        }

        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: buildPathSettingsText(pathCenterState, chatKey),
            buttons: buildPathSettingsKeyboard(pathCenterState),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '保存位置已更新' }));
    } catch (error) {
        console.error('🤖 设置保存位置失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `设置失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleDuplicateMode(message: Api.Message): Promise<void> {
    const mode = await getDuplicateMode();
    await message.reply({
        message: buildDuplicateModeText(mode),
        buttons: buildDuplicateModeKeyboard(mode),
    });
}

export async function handleDuplicateModeCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const match = data.match(/^dm_set_(skip|copy)$/);
        if (!match) return;
        const mode = match[1] as DuplicateMode;
        await setSetting('duplicate_file_mode', mode);
        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: buildDuplicateModeText(mode),
            buttons: buildDuplicateModeKeyboard(mode),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已设置为${mode === 'skip' ? '跳过重复' : '生成副本'}` }));
    } catch (error) {
        console.error('🤖 设置重复文件处理失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `设置失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleCleanupSettings(message: Api.Message): Promise<void> {
    const enabled = await getCleanupEnabledSetting();
    await message.reply({
        message: buildCleanupSettingsText(enabled),
        buttons: buildCleanupSettingsKeyboard(enabled),
    });
}

export async function handleCleanupSettingsCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const enabled = data === 'cs_set_on';
        await setSetting('auto_cleanup_orphans', String(enabled));
        process.env.AUTO_CLEANUP_ORPHANS = String(enabled);
        if (enabled) {
            startPeriodicCleanup();
        } else {
            stopPeriodicCleanup();
        }
        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: buildCleanupSettingsText(enabled),
            buttons: buildCleanupSettingsKeyboard(enabled),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: enabled ? '已开启自动清理' : '已关闭自动清理' }));
    } catch (error) {
        console.error('🤖 设置自动清理失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `设置失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleDownloadWorkersCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: MSG.AUTH_REQUIRED,
            alert: true,
        }));
        return;
    }

    try {
        if (data === 'dw_cancel') {
            const current = await getCurrentDownloadWorkers();
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: buildDownloadWorkersText(current),
                buttons: buildDownloadWorkersKeyboard(current),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
            return;
        }

        const setMatch = data.match(/^dw_set_(4|8|12|16)$/);
        if (setMatch) {
            const workers = Number(setMatch[1]);
            if (workers >= 12) {
                await client.editMessage(update.peer, {
                    message: Number(update.msgId),
                    text: [
                        `⚠️ **确认使用 ${workers} workers？**`,
                        '',
                        '这是激进分片并发模式，可能出现：',
                        '- Telegram 风控或限流',
                        '- 下载断流 / 重试增多',
                        '- user session 账号风险，极端情况下可能影响账号',
                        '',
                        '如果只是日常下载，建议使用 4 或 8。',
                    ].join('\n'),
                    buttons: buildDownloadWorkersKeyboard(workers, workers),
                });
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '需要二次确认' }));
                return;
            }

            await setSetting('telegram_download_workers', String(workers));
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildDownloadWorkersText(workers)}\n\n✅ 已切换为 ${workers} workers，后续新下载任务立即生效。`,
                buttons: buildDownloadWorkersKeyboard(workers),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已设置为 ${workers}` }));
            return;
        }

        const confirmMatch = data.match(/^dw_confirm_(12|16)$/);
        if (confirmMatch) {
            const workers = Number(confirmMatch[1]);
            await setSetting('telegram_download_workers', String(workers));
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildDownloadWorkersText(workers)}\n\n⚠️ 已确认并切换为 ${workers} workers。若出现断流、限速、风控提示，请立即降回 4 或 8。`,
                buttons: buildDownloadWorkersKeyboard(workers),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已确认 ${workers} workers`, alert: true }));
        }
    } catch (error) {
        console.error('🤖 设置并发下载 worker 失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: `设置失败: ${(error as Error).message}`,
            alert: true,
        }));
    }
}

export async function handleFileConcurrencyCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: MSG.AUTH_REQUIRED,
            alert: true,
        }));
        return;
    }

    try {
        if (data === 'fc_cancel') {
            const current = await getCurrentFileConcurrency();
            setFileDownloadConcurrency(current);
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: buildFileConcurrencyText(current),
                buttons: buildFileConcurrencyKeyboard(current),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
            return;
        }

        const setMatch = data.match(/^fc_set_(1|2|3|4)$/);
        if (setMatch) {
            const concurrency = Number(setMatch[1]);
            if (concurrency === 4) {
                await client.editMessage(update.peer, {
                    message: Number(update.msgId),
                    text: [
                        '⚠️ **确认同时下载 4 个文件？**',
                        '',
                        '这是文件级激进并发模式，可能出现：',
                        '- Telegram 风控或限流',
                        '- 云盘上传限速 / 失败重试增多',
                        '- 服务器磁盘和网络压力明显增加',
                        '',
                        '如果只是日常下载，建议使用 2 或 3。',
                    ].join('\n'),
                    buttons: buildFileConcurrencyKeyboard(concurrency, concurrency),
                });
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '需要二次确认' }));
                return;
            }

            await setSetting('telegram_file_download_concurrency', String(concurrency));
            const normalized = setFileDownloadConcurrency(concurrency);
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildFileConcurrencyText(normalized)}\n\n✅ 已切换为同时下载 ${normalized} 个文件。`,
                buttons: buildFileConcurrencyKeyboard(normalized),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已设置为 ${normalized}` }));
            return;
        }

        const confirmMatch = data.match(/^fc_confirm_4$/);
        if (confirmMatch) {
            await setSetting('telegram_file_download_concurrency', '4');
            const normalized = setFileDownloadConcurrency(4);
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildFileConcurrencyText(normalized)}\n\n⚠️ 已确认并切换为同时下载 4 个文件。若出现限流、断流或上传失败，请立即降回 2 或 3。`,
                buttons: buildFileConcurrencyKeyboard(normalized),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已确认 4 个文件并发', alert: true }));
        }
    } catch (error) {
        console.error('🤖 设置文件级并发失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: `设置失败: ${(error as Error).message}`,
            alert: true,
        }));
    }
}
