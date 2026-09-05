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
import { forceStopDownloadTasksForScope, getDownloadQueueStats, getTaskStatus, getDownloadTaskScopeStatus, pauseDownloadTasks, resumeDownloadTasks, retryFailedDownloadTasks, getFileDownloadConcurrency, setFileDownloadConcurrency, listDownloadTaskGroups, getDownloadTaskGroup, prioritizeDownloadTaskGroup, pauseDownloadTaskGroup, resumeDownloadTaskGroup, cancelDownloadTaskGroup, getChannelExecutionGroup, prioritizeChannelExecutionGroup, pauseChannelExecutionGroup, resumeChannelExecutionGroup, cancelChannelExecutionGroup, refreshSilentProgress } from './telegramUpload.js';
import { storageManager } from './storage.js';
import { cancelTelegramBackgroundJob, listTelegramActiveTaskQueues, pauseTelegramBackgroundJob, resumeTelegramBackgroundJob, retryTelegramBackgroundJob } from './telegramChannelJobs.js';
import { getSetting, setSetting } from '../utils/settings.js';
import { DuplicateMode, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { startPeriodicCleanup, stopPeriodicCleanup } from './orphanCleanup.js';
import { safeUnlink } from '../utils/localPath.js';
import { getCurrentStorageScope, getScopedFileById, nextParam, removePhysicalFile, updateScopedFileById } from '../utils/fileScope.js';
import { canonicalTelegramChatKey, telegramChatKeyFromPeerParts } from '../utils/telegramChatKey.js';
import { clearTelegramTargetState, getTelegramTargetState, setTelegramTargetState, type TelegramTargetMode } from '../utils/telegramTargetStateStore.js';
import { buildTaskCancelConfirm, buildTaskCenterDetail, buildTaskCenterPage, channelTaskCenterItem, ordinaryTaskCenterItem, parseTaskCenterCallback, type TaskCenterButton, type TaskCenterItem, type TaskCenterSourceType, type TaskCenterView } from './telegramTaskCenter.js';
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
import {
    buildTelegramFileActionRows,
    buildTelegramFileBrowserText,
    buildTelegramFileDetail,
    encodeTelegramFileCallback,
    parseTelegramFileCallback,
    queryTelegramFiles,
} from './telegramFileBrowser.js';
import { buildTelegramStatusPanel } from './telegramStatusPanel.js';
import { getTelegramBotStatus } from './telegramBotStatus.js';
import { getTelegramNotificationPreferences, setTelegramNotificationPreferences } from './telegramNotificationPreferences.js';
import {
    buildNotificationSettingsButtonRows,
    buildNotificationSettingsText,
    notificationCallbackArgs,
    updateNotificationPreference,
} from './telegramNotificationSettings.js';
import { getTelegramUserClientStatus } from './telegramUserClientStatus.js';
import crypto from 'crypto';
import { buildStorageCapabilities } from '../utils/storageProductContract.js';
import { getSignedUrl } from '../middleware/signedUrl.js';
import { normalizeFolderPath } from '../utils/folderPath.js';
import { getTelegramUserLocaleOrDefault } from './telegramLocalePreferences.js';
import { DEFAULT_LOCALE, t, type TelegramLocale } from '../i18n/telegram.js';

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

interface PendingTelegramFileMutation {
    actorId: number;
    chatId: string;
    messageId: number;
    fileId: string;
    action: 'move' | 'rename';
    expiresAt: number;
}

interface StorageAccountSummary {
    id: string;
    name?: string | null;
    type: string;
    is_active: boolean;
    last_probe_status?: string | null;
    last_probe_error?: string | null;
    last_probed_at?: string | null;
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
}

const pendingDeleteConfirmations = new Map<string, PendingDeleteInfo>();
const pendingTelegramFileMutations = new Map<string, PendingTelegramFileMutation>();
const pendingStorageClearSnapshots = new Map<string, PendingStorageClearSnapshot>();
const pendingBulkTaskCancellations = new Map<string, PendingBulkTaskCancellation>();
const destructiveConfirmations = new DestructiveConfirmationStore();

function buildFileActionKeyboard(file: any, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: buildTelegramFileActionRows(file, locale).map(row => new Api.KeyboardButtonRow({
            buttons: row.map(button => new Api.KeyboardButtonCallback({ text: button.text, data: Buffer.from(button.data) })),
        })),
    });
}

function buildFileSearchKeyboard(files: any[]): Api.ReplyInlineMarkup | undefined {
    if (files.length === 0) return undefined;
    return new Api.ReplyInlineMarkup({
        rows: files.slice(0, 8).map(file => new Api.KeyboardButtonRow({
            buttons: [new Api.KeyboardButtonCallback({
                text: `${file.is_favorite ? '⭐ ' : ''}${String(file.name).slice(0, 38)}`,
                data: Buffer.from(encodeTelegramFileCallback('detail', String(file.id))),
            })],
        })),
    });
}

function buildDeleteConfirmKeyboard(confirmId: string, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [new Api.KeyboardButtonRow({
            buttons: [
                new Api.KeyboardButtonCallback({ text: t(locale, 'commands.deleteConfirm'), data: Buffer.from(`del_confirm_${confirmId}`) }),
                new Api.KeyboardButtonCallback({ text: t(locale, 'common.cancel'), data: Buffer.from(`del_cancel_${confirmId}`) }),
            ],
        })],
    });
}

function buildBulkTaskCancelKeyboard(confirmId: string, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [new Api.KeyboardButtonRow({
            buttons: [
                new Api.KeyboardButtonCallback({ text: t(locale, 'commands.bulkConfirm'), data: Buffer.from(`bulk_task_confirm_${confirmId}`) }),
                new Api.KeyboardButtonCallback({ text: t(locale, 'common.back'), data: Buffer.from(`bulk_task_cancel_${confirmId}`) }),
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

function buildDownloadWorkersKeyboard(current: number, confirmValue?: number, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    if (confirmValue) {
        return new Api.ReplyInlineMarkup({
            rows: [
                new Api.KeyboardButtonRow({
                    buttons: [
                        new Api.KeyboardButtonCallback({ text: t(locale, 'commands.auto135', { value0: `⚠️ ${confirmValue}` }), data: Buffer.from(`dw_confirm_${confirmValue}`) }),
                        new Api.KeyboardButtonCallback({ text: t(locale, 'common.cancel'), data: Buffer.from('dw_cancel') }),
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

function buildStorageMaintenanceKeyboard(localFileCount: number, confirmationToken?: string, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup | undefined {
    if (localFileCount <= 0) return undefined;
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: confirmationToken
                    ? [
                        new Api.KeyboardButtonCallback({ text: t(locale, 'commands.clearLocalConfirm'), data: Buffer.from(`storage_clear_confirm_${confirmationToken}`) }),
                        new Api.KeyboardButtonCallback({ text: t(locale, 'common.cancel'), data: Buffer.from(`storage_clear_cancel_${confirmationToken}`) }),
                    ]
                    : [
                        new Api.KeyboardButtonCallback({ text: t(locale, 'commands.clearLocalButton', { count: localFileCount }), data: Buffer.from('storage_clear_ask') }),
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

function buildStorageAccountKeyboard(accounts: StorageAccountSummary[], activeAccountId: string | null, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    const accountButtons = sortStorageAccounts(accounts).map(account => {
        const isActive = account.is_active || account.id === activeAccountId;
        const providerLabel = getProviderDisplayName(account.type).replace(/^[^\p{L}\p{N}]+/u, '').trim();
        const accountName = shortenStorageAccountName(account.name || t(locale, 'commands.accountUnnamed'));
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
                    text: `${!activeAccountId ? '✅' : '⬜'} 💾 ${t(locale, 'commands.localStorage')}`,
                    data: Buffer.from('storage_switch_local'),
                })],
            }),
            ...accountButtons,
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: `🔄 ${t(locale, 'commands.refreshList')}`, data: Buffer.from('storage_switch_refresh') })],
            }),
        ],
    });
}

function buildStorageSwitchText(accounts: StorageAccountSummary[], activeAccountId: string | null, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const activeAccount = accounts.find(account => account.is_active || account.id === activeAccountId);
    const activeLine = activeAccount
        ? `${getProviderDisplayName(activeAccount.type)} · ${activeAccount.name || t(locale, 'commands.accountUnnamed')}`
        : getProviderDisplayName('local');

    const accountLines = sortStorageAccounts(accounts).map(account => {
        const marker = account.id === activeAccountId || account.is_active ? '✅' : '⬜';
        return `${marker} ${getProviderDisplayName(account.type)} · ${account.name || t(locale, 'commands.accountUnnamed')}\n   ID: \`${String(account.id).slice(0, 8)}\``;
    });

    return [
        t(locale, 'commands.storageSwitchTitle'),
        '',
        t(locale, 'commands.storageSwitchCurrent', { value: activeLine }),
        '',
        t(locale, 'commands.storageSwitchHint'),
        '',
        t(locale, 'commands.storageSwitchOptions'),
        `✅/⬜ ${getProviderDisplayName('local')}`,
        ...accountLines,
        '',
        t(locale, 'commands.storageSwitchNote'),
    ].join('\n');
}

async function buildStorageSwitchView(locale: TelegramLocale = DEFAULT_LOCALE): Promise<{ text: string; buttons: Api.ReplyInlineMarkup }> {
    const accounts = await storageManager.getAccounts() as StorageAccountSummary[];
    const activeAccountId = storageManager.getActiveAccountId();
    return {
        text: buildStorageSwitchText(accounts, activeAccountId, locale),
        buttons: buildStorageAccountKeyboard(accounts, activeAccountId, locale),
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
    const locale = await getTelegramUserLocaleOrDefault(update.userId.toJSNumber());
    const view = await buildStorageSwitchView(locale);
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

function buildDownloadWorkersText(current: number, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return [
        t(locale, 'commands.auto001'),
        '',
        t(locale, 'commands.auto002', { value0: current }),
        '',
        t(locale, 'commands.auto003'),
        '',
        t(locale, 'commands.auto004'),
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

function buildFileConcurrencyKeyboard(current: number, confirmValue?: number, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    if (confirmValue) {
        return new Api.ReplyInlineMarkup({
            rows: [
                new Api.KeyboardButtonRow({
                    buttons: [
                        new Api.KeyboardButtonCallback({ text: t(locale, 'commands.auto145', { value0: `⚠️ ${confirmValue}` }), data: Buffer.from(`fc_confirm_${confirmValue}`) }),
                        new Api.KeyboardButtonCallback({ text: t(locale, 'common.cancel'), data: Buffer.from('fc_cancel') }),
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

function buildFileConcurrencyText(current: number, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const stats = getDownloadQueueStats();
    return [
        t(locale, 'commands.auto005'),
        '',
        t(locale, 'commands.auto006', { value0: current }),
        t(locale, 'commands.auto007', { value0: stats.active, value1: stats.pending }),
        '',
        t(locale, 'commands.auto008'),
        '',
        t(locale, 'commands.auto009'),
        '',
        t(locale, 'commands.auto010'),
    ].join('\n');
}

function isOn(value: unknown, defaultValue = true): boolean {
    if (value === undefined || value === null || value === '') return defaultValue;
    return ON_VALUES.has(String(value).toLowerCase());
}

async function getPathCenterState(): Promise<{ automaticBySource: boolean; automaticByType: boolean }> {
    return { automaticBySource: true, automaticByType: true };
}

function buildDuplicateModeKeyboard(mode: DuplicateMode, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: t(locale, 'commands.auto011', { value0: mode === 'skip' ? '✅' : '⬜' }), data: Buffer.from('dm_set_skip') }),
                    new Api.KeyboardButtonCallback({ text: t(locale, 'commands.auto012', { value0: mode === 'copy' ? '✅' : '⬜' }), data: Buffer.from('dm_set_copy') }),
                ],
            }),
        ],
    });
}

function buildDuplicateModeText(mode: DuplicateMode, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return [
        t(locale, 'commands.auto013'),
        '',
        t(locale, 'commands.auto014', { value0: mode === 'skip' ? t(locale, 'commands.auto011', { value0: '' }).trim() : t(locale, 'commands.auto012', { value0: '' }).trim() }),
        '',
        t(locale, 'commands.auto015'),
        t(locale, 'commands.auto016'),
        '',
        t(locale, 'commands.auto017'),
    ].join('\n');
}

async function getCleanupEnabledSetting(): Promise<boolean> {
    const value = await getSetting('auto_cleanup_orphans', process.env.AUTO_CLEANUP_ORPHANS || 'true');
    return isOn(value, true);
}

function buildCleanupSettingsKeyboard(enabled: boolean, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: t(locale, 'commands.auto018', { value0: !enabled ? '✅' : '⬜' }), data: Buffer.from('cs_set_off') }),
                    new Api.KeyboardButtonCallback({ text: t(locale, 'commands.auto019', { value0: enabled ? '✅' : '⬜' }), data: Buffer.from('cs_set_on') }),
                ],
            }),
        ],
    });
}

function buildCleanupSettingsText(enabled: boolean, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return [
        t(locale, 'commands.auto020'),
        '',
        t(locale, 'commands.auto021', { value0: enabled ? '✅ Enabled' : '⬜ Disabled' }),
        '',
        t(locale, 'commands.auto022'),
        t(locale, 'commands.auto023'),
        '',
        t(locale, 'commands.auto024'),
    ].join('\n');
}

function getCallbackChatKey(update: Api.UpdateBotCallbackQuery): string {
    try {
        return canonicalTelegramChatKey(getPeerId(update.peer as any, true));
    } catch {
        return telegramChatKeyFromPeerParts(update.peer as any, update.userId);
    }
}

export async function handleStart(message: Api.Message, senderId: number, buttons?: Api.TypeReplyMarkup, locale?: TelegramLocale): Promise<void> {
    if (await isAuthenticatedAsync(senderId)) {
        await message.reply({ message: buildWelcomeBack(locale || await getTelegramUserLocaleOrDefault(senderId)), buttons });
    } else {
        passwordInputState.set(senderId, { password: '' });
    }
}

export async function handleHelp(message: Api.Message, buttons?: Api.TypeReplyMarkup, locale?: TelegramLocale): Promise<void> {
    await message.reply({ message: buildHelp(locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0)), buttons });
}

function buildNotificationSettingsKeyboard(current: Awaited<ReturnType<typeof getTelegramNotificationPreferences>>, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: buildNotificationSettingsButtonRows(current, locale).map(row => new Api.KeyboardButtonRow({
            buttons: row.map(button => new Api.KeyboardButtonCallback({
                text: button.text,
                data: Buffer.from(button.data),
            })),
        })),
    });
}

export async function handleNotifications(message: Api.Message, args: string[] = [], locale?: TelegramLocale): Promise<void> {
    const userId = message.senderId?.toJSNumber();
    if (!userId || !(await isAuthenticatedAsync(userId))) {
        await message.reply({ message: MSG.AUTH_REQUIRED });
        return;
    }
    const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(userId);
    const chatId = canonicalTelegramChatKey(message.chatId?.toString() || userId);
    const current = await getTelegramNotificationPreferences(userId, chatId);
    if (args.length === 0) {
        await message.reply({
            message: buildNotificationSettingsText(current, resolvedLocale),
            buttons: buildNotificationSettingsKeyboard(current, resolvedLocale),
        });
        return;
    }

    try {
        const saved = await setTelegramNotificationPreferences(
            userId,
            chatId,
            updateNotificationPreference(current, args, resolvedLocale),
        );
        await message.reply({
            message: `${buildNotificationSettingsText(saved, resolvedLocale)}\n\n${t(resolvedLocale, 'commands.settingsSaved')}`,
            buttons: buildNotificationSettingsKeyboard(saved, resolvedLocale),
        });
    } catch (error) {
        await message.reply({
            message: `❌ ${t(resolvedLocale, 'commands.settingsFailed', { error: (error as Error).message })}\n\n${t(resolvedLocale, 'commands.notificationsHint')}`,
        });
    }
}

export async function handleNotificationsCallback(
    client: TelegramClient,
    update: Api.UpdateBotCallbackQuery,
    data: string,
): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: MSG.AUTH_REQUIRED,
            alert: true,
        }));
        return;
    }

    const locale = await getTelegramUserLocaleOrDefault(userId);
    try {
        const args = notificationCallbackArgs(data);
        if (!args) return;
        const chatId = getCallbackChatKey(update);
        const current = await getTelegramNotificationPreferences(userId, chatId);
        const next = updateNotificationPreference(current, args, locale);
        if (JSON.stringify(next) === JSON.stringify(current)) {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: t(locale, 'commands.alreadyCurrent'),
            }));
            return;
        }
        const saved = await setTelegramNotificationPreferences(
            userId,
            chatId,
            next,
        );
        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: buildNotificationSettingsText(saved, locale),
            buttons: buildNotificationSettingsKeyboard(saved, locale),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: t(locale, 'commands.notificationsUpdated'),
        }));
    } catch (error) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: t(locale, 'commands.settingsFailed', { error: (error as Error).message }),
            alert: true,
        }));
    }
}

export async function handleStatus(message: Api.Message, locale?: TelegramLocale): Promise<void> {
    const senderId = message.senderId?.toJSNumber();
    if (!senderId || !(await isAuthenticatedAsync(senderId))) {
        await message.reply({ message: MSG.AUTH_REQUIRED });
        return;
    }
    const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(senderId);
    const requestId = `tg-${crypto.randomBytes(6).toString('hex')}`;
    try {
        const target = storageManager.getActiveTarget();
        const accounts = await storageManager.getAccounts() as StorageAccountSummary[];
        const account = target.accountId ? accounts.find(row => row.id === target.accountId) : null;
        const diskSpace = await checkDiskSpace(path.resolve(UPLOAD_DIR));
        const queue = getDownloadQueueStats();
        const [subscriptionRows, reconciliation] = await Promise.all([
            query(`SELECT COUNT(*)::int AS enabled, MAX(last_scan_at) AS last_scan_at,
                          MAX(last_error) FILTER (WHERE last_error IS NOT NULL) AS last_error
                   FROM telegram_channel_subscriptions WHERE enabled = true`),
            query(`SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                          COUNT(*) FILTER (WHERE resolution = 'operator_required')::int AS operator_required
                   FROM (
                       SELECT status, resolution FROM telegram_write_reconciliations
                       UNION ALL SELECT status, resolution FROM chunk_upload_reconciliations
                    ) reconciliations`),
        ]);
        const subscription = subscriptionRows.rows[0] || {};
        const reconcile = reconciliation.rows[0] || {};
        await message.reply({ message: buildTelegramStatusPanel({
            requestId,
            bot: getTelegramBotStatus(),
            userClient: getTelegramUserClientStatus(),
            target: {
                provider: target.provider.name,
                accountName: account?.name || (target.provider.name === 'local' ? t(resolvedLocale, 'commands.localAccount') : target.accountId || t(resolvedLocale, 'commands.defaultAccount')),
                probeStatus: account?.last_probe_status || (target.provider.name === 'local' ? 'available' : null),
                cooldownUntil: null,
                probeError: account?.last_probe_error || null,
            },
            disk: { freeBytes: Number(diskSpace.free || 0), totalBytes: Number(diskSpace.size || 0) },
            queue: { active: queue.active, pending: queue.pending, failed: getTaskStatus().history.filter(task => task.status === 'failed').length, paused: queue.paused },
            subscriptions: { enabled: Number(subscription.enabled || 0), lastScanAt: subscription.last_scan_at || null, lastError: subscription.last_error || null },
            reconciliation: { pending: Number(reconcile.pending || 0), operatorRequired: Number(reconcile.operator_required || 0) },
        }, resolvedLocale) });
    } catch (error) {
        console.error(`🤖 status panel failed request=${requestId}:`, error);
        await message.reply({ message: t(resolvedLocale, 'commands.statusFailed', { requestId }) });
    }
}

export async function handleStorage(message: Api.Message, locale?: TelegramLocale): Promise<void> {
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
        }, locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0));

        await message.reply({
            message: reply,
            buttons: buildStorageMaintenanceKeyboard(localStats.count, undefined, locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0)),
        });
    } catch (error) {
        console.error('🤖 获取存储统计失败:', error);
        await message.reply({ message: MSG.ERR_STORAGE });
    }
}

function buildTargetKeyboard(locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({ buttons: [
                new Api.KeyboardButtonCallback({ text: t(locale, 'commands.targetNextButton'), data: Buffer.from('target_once_active') }),
                new Api.KeyboardButtonCallback({ text: t(locale, 'commands.targetSessionButton'), data: Buffer.from('target_session_active') }),
            ] }),
            new Api.KeyboardButtonRow({ buttons: [
                new Api.KeyboardButtonCallback({ text: t(locale, 'commands.targetClearButton'), data: Buffer.from('target_clear') }),
            ] }),
        ],
    });
}

export async function handleTarget(message: Api.Message, args: string[] = [], locale?: TelegramLocale): Promise<void> {
    const senderId = message.senderId?.toJSNumber();
    if (!senderId || !(await isAuthenticatedAsync(senderId))) {
        await message.reply({ message: MSG.AUTH_REQUIRED });
        return;
    }
    const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(senderId);
    const chatId = canonicalTelegramChatKey(message.chatId?.toString() || senderId);
    const modeInput = (args[0] || '').toLowerCase();
    if (modeInput === 'clear') {
        await clearTelegramTargetState(chatId);
        await message.reply({ message: t(resolvedLocale, 'commands.targetCleared') });
        return;
    }
    if (!modeInput) {
        const once = await getTelegramTargetState(undefined, chatId, 'once');
        const session = await getTelegramTargetState(undefined, chatId, 'session');
        const active = storageManager.getActiveTarget();
        await message.reply({
            message: [
                t(resolvedLocale, 'commands.targetTitle'),
                t(resolvedLocale, 'commands.targetNext', { value: once ? t(resolvedLocale, 'commands.targetSet', { value: getProviderDisplayName(once.provider) }) : t(resolvedLocale, 'commands.targetDefault') }),
                t(resolvedLocale, 'commands.targetSession', { value: session ? t(resolvedLocale, 'commands.targetSet', { value: getProviderDisplayName(session.provider) }) : t(resolvedLocale, 'commands.targetDefault') }),
                t(resolvedLocale, 'commands.targetSystem', { value: getProviderDisplayName(active.provider.name) }),
                '',
                t(resolvedLocale, 'commands.targetHint'),
            ].join('\n'),
            buttons: buildTargetKeyboard(resolvedLocale),
        });
        return;
    }
    if (!['once', 'session'].includes(modeInput) || !args[1]) {
        await message.reply({
            message: t(resolvedLocale, 'commands.targetInvalid'),
            buttons: buildTargetKeyboard(resolvedLocale),
        });
        return;
    }
    const mode = modeInput as TelegramTargetMode;
    const selector = String(args[1]);
    let provider = 'local';
    let accountId: string | null = null;
    let accountName = t(resolvedLocale, 'commands.localAccount');
    if (selector !== 'local') {
        const accounts = await storageManager.getAccounts() as StorageAccountSummary[];
        const account = accounts.find(row => String(row.id) === selector || String(row.id).startsWith(selector));
        if (!account) {
            await message.reply({ message: t(resolvedLocale, 'commands.targetAccountMissing') });
            return;
        }
        provider = account.type;
        accountId = account.id;
        accountName = account.name || account.type;
        storageManager.getTarget(provider, accountId);
    }
    const expiresAt = new Date(Date.now() + (mode === 'once' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000));
    await setTelegramTargetState(undefined, chatId, mode, provider, accountId, expiresAt);
    await message.reply({ message: t(resolvedLocale, 'commands.targetSaved', { scope: t(resolvedLocale, mode === 'once' ? 'commands.targetScopeNext' : 'commands.targetScopeSession'), provider, account: accountName }) });
}

export async function handleTargetCallback(
    client: TelegramClient,
    update: Api.UpdateBotCallbackQuery,
    data: string,
): Promise<void> {
    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const chatId = getCallbackChatKey(update);
    if (data === 'target_clear') {
        await clearTelegramTargetState(chatId);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.targetRestored') }));
    } else {
        const mode: TelegramTargetMode = data === 'target_once_active' ? 'once' : 'session';
        const active = storageManager.getActiveTarget();
        const expiresAt = new Date(Date.now() + (mode === 'once' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000));
        await setTelegramTargetState(undefined, chatId, mode, active.provider.name, active.accountId, expiresAt);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: t(locale, mode === 'once' ? 'commands.targetNextSet' : 'commands.targetSessionSet'),
        }));
    }
    const once = await getTelegramTargetState(undefined, chatId, 'once');
    const session = await getTelegramTargetState(undefined, chatId, 'session');
    const active = storageManager.getActiveTarget();
    await client.editMessage(update.peer, {
        message: Number(update.msgId),
        text: [
            t(locale, 'commands.targetTitle'),
            t(locale, 'commands.targetNext', { value: once ? t(locale, 'commands.targetSet', { value: getProviderDisplayName(once.provider) }) : t(locale, 'commands.targetDefault') }),
            t(locale, 'commands.targetSession', { value: session ? t(locale, 'commands.targetSet', { value: getProviderDisplayName(session.provider) }) : t(locale, 'commands.targetDefault') }),
            t(locale, 'commands.targetSystem', { value: getProviderDisplayName(active.provider.name) }),
            '',
            t(locale, 'commands.targetHint'),
        ].join('\n'),
        buttons: buildTargetKeyboard(locale),
    }).catch(error => {
        if (!isTelegramMessageNotModified(error)) throw error;
    });
}

export async function handleStorageSwitch(message: Api.Message, locale?: TelegramLocale): Promise<void> {
    const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0);
    try {
        const view = await buildStorageSwitchView(resolvedLocale);
        await message.reply({ message: view.text, buttons: view.buttons });
    } catch (error) {
        console.error('🤖 获取存储源切换菜单失败:', error);
        await message.reply({ message: t(resolvedLocale, 'commands.storageSwitchFailed', { error: (error as Error).message }) });
    }
}

export async function handleStorageSwitchCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        if (data === 'storage_switch_refresh') {
            await editStorageSwitchMessage(client, update, t(locale, 'commands.storageRefreshed'));
            return;
        }

        const accountId = data.replace(/^storage_switch_/, '');
        if (!accountId) {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.storageInvalid'), alert: true }));
            return;
        }

        if (accountId === 'local') {
            if (!storageManager.getActiveAccountId()) {
                await editStorageSwitchMessage(client, update, t(locale, 'commands.storageAlreadyLocal'));
                return;
            }
            await storageManager.switchAccount('local');
            await editStorageSwitchMessage(client, update, t(locale, 'commands.storageSwitchedLocal'));
            return;
        }

        const accounts = await storageManager.getAccounts() as StorageAccountSummary[];
        const selected = accounts.find(account => account.id === accountId);
        if (!selected) {
            await editStorageSwitchMessage(client, update, t(locale, 'commands.storageMissing'));
            return;
        }
        if (selected.is_active || storageManager.getActiveAccountId() === accountId) {
            await editStorageSwitchMessage(client, update, t(locale, 'commands.storageAlreadyAccount'));
            return;
        }

        await storageManager.switchAccount(accountId);
        await editStorageSwitchMessage(client, update, t(locale, 'commands.storageSwitched', { name: selected.name || getProviderDisplayName(selected.type) }));
    } catch (error) {
        console.error('🤖 切换存储源失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.storageSwitchError', { error: (error as Error).message }), alert: true }));
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

export async function handleFind(message: Api.Message, args: string[] = [], locale?: TelegramLocale): Promise<void> {
    const senderId = message.senderId?.toJSNumber();
    if (!senderId || !(await isAuthenticatedAsync(senderId))) {
        await message.reply({ message: MSG.AUTH_REQUIRED });
        return;
    }
    const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(senderId);
    const rawOptions: Record<string, string> = { limit: '8', sort: 'date', direction: 'desc' };
    const queryParts: string[] = [];
    for (const arg of args) {
        if (arg.startsWith('type:')) rawOptions.type = arg.slice(5);
        else if (arg.startsWith('folder:')) rawOptions.folder = arg.slice(7);
        else if (arg.startsWith('after:')) rawOptions.after = arg.slice(6);
        else if (arg.startsWith('before:')) rawOptions.before = arg.slice(7);
        else if (arg === 'fav' || arg === 'favorite') rawOptions.favorite = 'true';
        else queryParts.push(arg);
    }
    if (queryParts.length > 0) rawOptions.q = queryParts.join(' ');
    try {
        const page = await queryTelegramFiles(rawOptions);
        await message.reply({
            message: buildTelegramFileBrowserText(page, rawOptions.q || '', resolvedLocale),
            buttons: buildFileSearchKeyboard(page.files),
        });
    } catch (error) {
        await message.reply({ message: t(resolvedLocale, 'commands.fileSearchFailed', { error: (error as Error).message }) });
    }
}

export async function handleList(message: Api.Message, args: string[], locale?: TelegramLocale): Promise<void> {
    try {
        let limit = 10;
        let page = 1;
        if (args.length > 0) {
            const parsed = parseInt(args[0]);
            if (!isNaN(parsed) && parsed > 0) {
                limit = Math.min(parsed, 12);
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

        const reply = buildFileList(result.rows, result.rows.length, locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0));
        await message.reply({ message: reply });
    } catch (error) {
        console.error('🤖 获取文件列表失败:', error);
        await message.reply({ message: MSG.ERR_FILE_LIST });
    }
}

export async function handleTelegramFileBrowserCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const actorId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(actorId);
    if (!(await isAuthenticatedAsync(actorId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const parsed = parseTelegramFileCallback(data);
    if (!parsed) return;
    const file = await getScopedFileById(parsed.fileId);
    if (!file) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.fileUnavailable'), alert: true }));
        return;
    }
    const chatId = getCallbackChatKey(update);
    const messageId = Number(update.msgId);
    if (parsed.action === 'detail') {
        await client.editMessage(update.peer, { message: messageId, text: buildTelegramFileDetail(file, locale), buttons: buildFileActionKeyboard(file, locale) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.fileDetail') }));
        return;
    }
    if (parsed.action === 'copy') {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: String(file.id), alert: true }));
        return;
    }
    if (parsed.action === 'favorite') {
        await updateScopedFileById(String(file.id), 'is_favorite = $1, updated_at = NOW()', [!file.is_favorite]);
        file.is_favorite = !file.is_favorite;
        await client.editMessage(update.peer, { message: messageId, text: buildTelegramFileDetail(file, locale), buttons: buildFileActionKeyboard(file, locale) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, file.is_favorite ? 'commands.fileFavorited' : 'commands.fileUnfavorited') }));
        return;
    }
    if (parsed.action === 'link') {
        const capabilities = buildStorageCapabilities(String(file.source));
        if (!capabilities.share && String(file.source) !== 'local') {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.fileShareUnsupported'), alert: true }));
            return;
        }
        const relative = getSignedUrl(String(file.id), 'download', 3600);
        const base = (process.env.VITE_API_URL || process.env.OAUTH_CALLBACK_BASE_URL || '').replace(/\/$/, '');
        const link = base ? `${base}${relative}` : relative;
        await client.sendMessage(update.peer, { message: t(locale, 'commands.fileSignedLink', { link }) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.fileLinkCreated') }));
        return;
    }
    if (parsed.action === 'move' || parsed.action === 'rename') {
        const key = `${actorId}:${chatId}`;
        pendingTelegramFileMutations.set(key, { actorId, chatId, messageId, fileId: String(file.id), action: parsed.action, expiresAt: Date.now() + 5 * 60 * 1000 });
        await client.sendMessage(update.peer, { message: t(locale, parsed.action === 'move' ? 'commands.fileMovePrompt' : 'commands.fileRenamePrompt') });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, parsed.action === 'move' ? 'commands.fileAwaitFolder' : 'commands.fileAwaitName') }));
        return;
    }
    const sent = await client.sendMessage(update.peer, {
        message: [t(locale, 'commands.fileDeleteTitle'), '', `📄 ${file.name}`, `🆔 ${String(file.id).slice(0, 13)}`, '', t(locale, 'commands.fileDeleteImpact')].join('\n'),
    }) as Api.Message;
    const confirmId = destructiveConfirmations.issue({ actorId, chatId, messageId: sent.id, action: 'delete_file', objectId: String(file.id) });
    pendingDeleteConfirmations.set(confirmId, { fileId: String(file.id), name: String(file.name), size: Number(file.size || 0), selector: String(file.id), actorId, chatId, messageId: sent.id });
    await sent.edit({ text: sent.message, buttons: buildDeleteConfirmKeyboard(confirmId, locale) });
    await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.confirmRequired') }));
}

export async function applyPendingTelegramFileMutation(message: Api.Message, actorId: number, input: string): Promise<boolean> {
    const locale = await getTelegramUserLocaleOrDefault(actorId);
    const chatId = canonicalTelegramChatKey(message.chatId?.toString());
    const key = `${actorId}:${chatId}`;
    const pending = pendingTelegramFileMutations.get(key);
    if (!pending) return false;
    if (pending.expiresAt < Date.now()) {
        pendingTelegramFileMutations.delete(key);
        await message.reply({ message: t(locale, 'commands.fileMutationExpired') });
        return true;
    }
    if (input.trim() === '取消') {
        pendingTelegramFileMutations.delete(key);
        await message.reply({ message: t(locale, 'commands.fileMutationCancelled') });
        return true;
    }
    const file = await getScopedFileById(pending.fileId);
    if (!file) {
        pendingTelegramFileMutations.delete(key);
        await message.reply({ message: t(locale, 'commands.fileUnavailable') });
        return true;
    }
    if (pending.action === 'move') {
        const folder = normalizeFolderPath(input);
        await updateScopedFileById(pending.fileId, 'folder = $1, updated_at = NOW()', [folder]);
        await message.reply({ message: t(locale, 'commands.fileMoved', { folder }) });
    } else {
        const name = input.trim();
        if (!name || /[\/\\:*?"<>|]/.test(name)) throw new Error('文件名包含非法字符');
        const extension = (value: string) => path.extname(value).toLowerCase();
        if (extension(name) !== extension(String(file.name))) throw new Error('不允许修改文件后缀');
        await updateScopedFileById(pending.fileId, 'name = $1, updated_at = NOW()', [name]);
        await message.reply({ message: t(locale, 'commands.fileRenamed', { name }) });
    }
    pendingTelegramFileMutations.delete(key);
    return true;
}

export async function handleDelete(message: Api.Message, args: string[], locale?: TelegramLocale): Promise<void> {
    const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0);
    if (args.length === 0) {
        await message.reply({ message: t(resolvedLocale, 'commands.fileDeleteChoose') });
        return;
    }

    const selector = args[0].trim();

    try {
        const scope = await getCurrentStorageScope();
        if (/^\d+$/.test(selector)) {
            await message.reply({ message: t(resolvedLocale, 'commands.fileDeleteNoIndex') });
            return;
        }
        if (selector.length < 8) {
            await message.reply({ message: t(resolvedLocale, 'commands.fileIdTooShort') });
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
            await message.reply({ message: t(resolvedLocale, 'commands.fileNotFound', { selector }) });
            return;
        }
        if (result.rows.length > 1) {
            await message.reply({ message: t(resolvedLocale, 'commands.fileAmbiguous', { selector }) });
            return;
        }

        const file = result.rows[0];
        if (file.source === 'openlist') {
            await message.reply({ message: t(resolvedLocale, 'commands.fileOpenListDeleteUnsupported') });
            return;
        }
        const sent = await message.reply({
            message: [
                t(resolvedLocale, 'commands.fileDeleteTitle'),
                '',
                `📄 ${file.name}`,
                `🆔 ${String(file.id).slice(0, 12)}`,
                `📦 ${formatBytes(Number(file.size || 0), false)}`,
                file.folder ? `📁 ${file.folder}` : '',
                '',
                t(resolvedLocale, 'commands.fileDeleteHint'),
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
    const locale = await getTelegramUserLocaleOrDefault(userId);
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const match = data.match(/^del_(confirm|cancel)_(.+)$/);
    if (!match) return;
    const [, action, confirmId] = match;
    const pending = pendingDeleteConfirmations.get(confirmId);
    if (!pending) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.deleteExpired'), alert: true }));
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
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.deleteNotOwner'), alert: true }));
            return;
        }
        pendingDeleteConfirmations.delete(confirmId);
        await client.editMessage(update.peer, { message: Number(update.msgId), text: t(locale, 'commands.deleteCancelled', { name: pending.name }), buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.cancelled') }));
        return;
    }
    const consumed = destructiveConfirmations.consume(confirmId, binding);
    if (consumed.status !== 'ok') {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.deleteInvalid'), alert: true }));
        return;
    }
    pendingDeleteConfirmations.delete(confirmId);
    try {
        const scope = await getCurrentStorageScope();
        const result = await query(`SELECT * FROM files WHERE ${scope.clause} AND id = ${nextParam(scope, 1)} LIMIT 1`, [...scope.params, pending.fileId]);
        const file = result.rows[0];
        if (!file) {
            pendingDeleteConfirmations.delete(confirmId);
            await client.editMessage(update.peer, { message: Number(update.msgId), text: `❌ ${t(locale, 'commands.fileUnavailable')}.`, buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.fileMissingShort'), alert: true }));
            return;
        }
        if (file.source === 'openlist') {
            await client.editMessage(update.peer, { message: Number(update.msgId), text: `❌ ${t(locale, 'commands.fileOpenListDeleteUnsupported')}`, buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.fileDeleteUnsupportedShort'), alert: true }));
            return;
        }
        await removePhysicalFile(file);
        await query('DELETE FROM files WHERE id = $1', [file.id]);
        await client.editMessage(update.peer, { message: Number(update.msgId), text: buildDeleteSuccess(file.name, file.id, locale), buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.deleted') }));
    } catch (error) {
        console.error('🤖 确认删除文件失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.deleteFailed', { error: (error as Error).message }), alert: true }));
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
    const channelRows = await listTelegramActiveTaskQueues(userId, 1000);
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
    return [...ordinaryItems, ...channelItems];
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
    const locale = await getTelegramUserLocaleOrDefault(userId);
    await editTaskCenterView(client, update, buildTaskCenterPage(items, page, { locale }));
}

export async function handleTasks(message: Api.Message, locale?: TelegramLocale): Promise<void> {
    try {
        const senderId = message.senderId?.toJSNumber();
        const chatId = message.chatId?.toString();
        if (!senderId || !chatId) {
            await message.reply({ message: MSG.ERR_TASKS });
            return;
        }
        const items = await loadTaskCenterItems(chatId, senderId);
        const resolvedLocale: TelegramLocale = locale || await getTelegramUserLocaleOrDefault(senderId);
        const view = buildTaskCenterPage(items, 0, { locale: resolvedLocale });
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
    const locale = await getTelegramUserLocaleOrDefault(userId);
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const parsed = parseTaskCenterCallback(data);
    if (!parsed) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.taskInvalidButton'), alert: true }));
        return;
    }
    const chatId = getCallbackChatKey(update);
    const ownerKey = taskCenterCardKey(chatId, Number(update.msgId));
    const owner = taskCenterCardOwners.get(ownerKey);
    if (!owner) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.taskOldCard'), alert: true }));
        return;
    }
    if (owner.expiresAt < Date.now() || owner.userId !== userId) {
        if (owner.expiresAt < Date.now()) taskCenterCardOwners.delete(ownerKey);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.taskWrongOwner'), alert: true }));
        return;
    }
    owner.expiresAt = Date.now() + TASK_CENTER_CARD_TTL_MS;
    try {
        if (parsed.view === 'list') {
            await renderTaskCenterList(client, update, userId, chatId, parsed.page);
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.taskRefreshed') }));
            return;
        }

        const item = await findTaskCenterItem(parsed.sourceType, parsed.id, chatId, userId);
        if (!item) {
            await renderTaskCenterList(client, update, userId, chatId, parsed.page);
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.taskEnded'), alert: true }));
            return;
        }

        if (parsed.view === 'detail') {
            await editTaskCenterView(client, update, buildTaskCenterDetail(item, parsed.page, { locale }));
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
            await editTaskCenterView(client, update, buildTaskCancelConfirm(item, parsed.page, locale));
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.taskConfirmCancel') }));
            return;
        }
        if (parsed.action === 'cancel_confirm') {
            const confirmationKey = taskCenterCancelKey(userId, chatId, Number(update.msgId));
            const pending = pendingTaskCenterCancels.get(confirmationKey);
            pendingTaskCenterCancels.delete(confirmationKey);
            if (!pending || pending.expiresAt < Date.now() || pending.sourceType !== parsed.sourceType || pending.taskId !== parsed.id) {
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.taskCancelExpired'), alert: true }));
                return;
            }
        }
        if (parsed.action === 'retry') {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.taskRetryUnsupported'), alert: true }));
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
                    ? t(locale, 'commands.taskPrioritized')
                    : parsed.action === 'pause'
                        ? (result.group?.state === 'pausing' ? t(locale, 'commands.taskPausing') : t(locale, 'commands.taskPaused'))
                        : parsed.action === 'resume'
                            ? t(locale, 'commands.taskResumed')
                            : t(locale, 'commands.taskCancelled')
                : result.status === 'blocked'
                    ? t(locale, 'commands.taskProtected')
                    : result.status === 'forbidden'
                        ? t(locale, 'commands.taskForbidden')
                        : t(locale, 'commands.taskEnded');
        } else if (parsed.sourceType === 'channel') {
            const result = await operateChannelTaskCenterItem(parsed.action, userId, chatId, parsed.id);
            ok = result.ok;
            toast = result.toast;
        }

        if (parsed.action === 'cancel_confirm' || !ok) {
            await renderTaskCenterList(client, update, userId, chatId, parsed.page);
        } else {
            const refreshed = await findTaskCenterItem(parsed.sourceType, parsed.id, chatId, userId);
            if (refreshed) {
                await editTaskCenterView(client, update, buildTaskCenterDetail(refreshed, parsed.page, { locale }));
            } else {
                await renderTaskCenterList(client, update, userId, chatId, parsed.page);
            }
        }
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: toast, alert: !ok }));
    } catch (error) {
        console.error('🤖 任务中心按钮操作失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: t(locale, 'commands.taskOperationFailed', { error: (error as Error).message }),
            alert: true,
        }));
    }
}

async function getBulkTaskImpact(userId: number, chatId: string): Promise<BulkTaskImpact> {
    const ordinaryGroups = listDownloadTaskGroups(chatId, userId)
        .map(ordinaryTaskCenterItem)
        .filter((item): item is TaskCenterItem => Boolean(item));
    const channelRows = await listTelegramActiveTaskQueues(userId, 1000);
    return {
        ordinaryTasks: ordinaryGroups.length,
        ordinaryActiveFiles: ordinaryGroups.reduce((sum, item) => sum + item.active, 0),
        ordinaryPendingFiles: ordinaryGroups.reduce((sum, item) => sum + item.pending, 0),
        channelTasks: channelRows.filter(row => String(row.chat_id || '') === chatId).length,
    };
}

function bulkImpactTotal(impact: BulkTaskImpact): number {
    return impact.ordinaryTasks + impact.channelTasks;
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
    const locale = await getTelegramUserLocaleOrDefault(actorId);
    await sent.edit({ text: sent.message, buttons: buildBulkTaskCancelKeyboard(confirmId, locale) });
}

async function cancelTasksForScope(userId: number, chatId: string): Promise<BulkTaskImpact> {
    const channelRows = await listTelegramActiveTaskQueues(userId, 1000);
    let channelTasks = 0;
    for (const row of channelRows.filter(item => String(item.chat_id || '') === chatId)) {
        const cancelled = await cancelTelegramBackgroundJob(userId, String(row.id), chatId);
        if (!cancelled) continue;
        channelTasks += 1;
        cancelChannelExecutionGroup(String(row.id));
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

export async function handleDownloadWorkers(message: Api.Message, locale?: TelegramLocale): Promise<void> {
    try {
        const current = await getCurrentDownloadWorkers();
        const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0);
        await message.reply({
            message: buildDownloadWorkersText(current, resolvedLocale),
            buttons: buildDownloadWorkersKeyboard(current, undefined, resolvedLocale),
        });
    } catch (error) {
        console.error('🤖 获取分片并发设置失败:', error);
        await message.reply({ message: '❌ 暂时无法读取单文件分片并发，请稍后重试。' });
    }
}

export async function handleFileConcurrency(message: Api.Message, locale?: TelegramLocale): Promise<void> {
    try {
        const current = await getCurrentFileConcurrency();
        const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0);
        setFileDownloadConcurrency(current);
        await message.reply({
            message: buildFileConcurrencyText(current, resolvedLocale),
            buttons: buildFileConcurrencyKeyboard(current),
        });
    } catch (error) {
        console.error('🤖 获取文件级并发设置失败:', error);
        await message.reply({ message: '❌ 暂时无法读取文件并发设置，请稍后重试。' });
    }
}

export async function handlePathRules(message: Api.Message, locale?: TelegramLocale): Promise<void> {
    const pathCenterState = await getPathCenterState();
    const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0);
    await message.reply({
        message: buildPathSettingsText(pathCenterState, message.chatId?.toString() || 'unknown', resolvedLocale),
        buttons: buildPathSettingsKeyboard(pathCenterState, resolvedLocale),
    });
}

export async function handlePathOnce(message: Api.Message, args: string[]): Promise<void> {
    const folder = args.join(' ').trim();
    if (!folder) {
        await message.reply({ message: '请直接发送下一次要使用的目录名称。' });
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
        await message.reply({ message: '请直接发送本聊天要持续使用的目录名称。' });
        return;
    }
    try {
        const normalized = await setSessionTelegramPathPersistent(message.chatId?.toString() || 'unknown', folder);
        await message.reply({ message: `📍 已设置本会话下载目录：\`${normalized}\`\n${buildPathPreviewLine(normalized)}\n\n后续此聊天中的下载会优先保存到该目录；可在“保存位置”中清除。` });
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
    const locale = await getTelegramUserLocaleOrDefault(userId);
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
                    ? [t(locale, 'path.recent.title'), '', ...recent.map((item, index) => `${index + 1}. ${item}`), '', t(locale, 'path.recent.hint')].join('\n')
                    : t(locale, 'path.recent.empty')
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'path.toast.recentSent') }));
            return;
        } else if (data === 'pr_help_once' || data === 'pr_help_session') {
            const mode = data === 'pr_help_once' ? 'once' : 'session';
            setPendingTelegramPathInput(chatKey, userId, mode);
            await client.sendMessage(update.peer, { message: await buildPendingPathPromptPersistent(mode, chatKey, locale) });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'path.toast.sendFolder') }));
            return;
        }

        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: buildPathSettingsText(pathCenterState, chatKey, locale),
            buttons: buildPathSettingsKeyboard(pathCenterState, locale),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'path.toast.updated') }));
    } catch (error) {
        console.error('🤖 设置保存位置失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.settingFailedRetry'), alert: true }));
    }
}

export async function handleDuplicateMode(message: Api.Message, locale?: TelegramLocale): Promise<void> {
    const mode = await getDuplicateMode();
    const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0);
    await message.reply({
        message: buildDuplicateModeText(mode, resolvedLocale),
        buttons: buildDuplicateModeKeyboard(mode, resolvedLocale),
    });
}

export async function handleDuplicateModeCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
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
            text: buildDuplicateModeText(mode, locale),
            buttons: buildDuplicateModeKeyboard(mode, locale),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.auto125', { value0: mode === 'skip' ? t(locale, 'commands.auto011', { value0: '' }).trim() : t(locale, 'commands.auto012', { value0: '' }).trim() }) }));
    } catch (error) {
        console.error('🤖 设置重复文件处理失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.settingFailedRetry'), alert: true }));
    }
}

export async function handleCleanupSettings(message: Api.Message, locale?: TelegramLocale): Promise<void> {
    const enabled = await getCleanupEnabledSetting();
    const resolvedLocale = locale || await getTelegramUserLocaleOrDefault(message.senderId?.toJSNumber() || 0);
    await message.reply({
        message: buildCleanupSettingsText(enabled, resolvedLocale),
        buttons: buildCleanupSettingsKeyboard(enabled, resolvedLocale),
    });
}

export async function handleCleanupSettingsCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
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
            text: buildCleanupSettingsText(enabled, locale),
            buttons: buildCleanupSettingsKeyboard(enabled, locale),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, enabled ? 'commands.auto127' : 'commands.auto126') }));
    } catch (error) {
        console.error('🤖 设置自动清理失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.settingFailedRetry'), alert: true }));
    }
}

export async function handleDownloadWorkersCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
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
                text: buildDownloadWorkersText(current, locale),
                buttons: buildDownloadWorkersKeyboard(current, undefined, locale),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.cancelled') }));
            return;
        }

        const setMatch = data.match(/^dw_set_(4|8|12|16)$/);
        if (setMatch) {
            const workers = Number(setMatch[1]);
            if (workers >= 12) {
                await client.editMessage(update.peer, {
                    message: Number(update.msgId),
                    text: [
                        t(locale, 'commands.auto128', { value0: workers }),
                        '',
                        t(locale, 'commands.auto129'),
                        t(locale, 'commands.auto130'),
                        t(locale, 'commands.auto131'),
                        '- Telegram 用户账号可能被限流，极端情况下会影响账号',
                        '',
                        t(locale, 'commands.auto133'),
                    ].join('\n'),
                    buttons: buildDownloadWorkersKeyboard(workers, workers, locale),
                });
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.secondConfirm') }));
                return;
            }

            await setSetting('telegram_download_workers', String(workers));
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildDownloadWorkersText(workers, locale)}\n\n${t(locale, 'commands.auto134', { value0: '', value1: workers })}`,
                buttons: buildDownloadWorkersKeyboard(workers, undefined, locale),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.auto135', { value0: workers }) }));
            return;
        }

        const confirmMatch = data.match(/^dw_confirm_(12|16)$/);
        if (confirmMatch) {
            const workers = Number(confirmMatch[1]);
            await setSetting('telegram_download_workers', String(workers));
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildDownloadWorkersText(workers, locale)}\n\n${t(locale, 'commands.auto136', { value0: '', value1: workers })}`,
                buttons: buildDownloadWorkersKeyboard(workers, undefined, locale),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.auto137', { value0: workers }), alert: true }));
        }
    } catch (error) {
        console.error('🤖 设置并发下载 worker 失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: t(locale, 'commands.settingFailedRetry'),
            alert: true,
        }));
    }
}

export async function handleFileConcurrencyCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
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
                text: buildFileConcurrencyText(current, locale),
                buttons: buildFileConcurrencyKeyboard(current),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.cancelled') }));
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
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.secondConfirm') }));
                return;
            }

            await setSetting('telegram_file_download_concurrency', String(concurrency));
            const normalized = setFileDownloadConcurrency(concurrency);
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildFileConcurrencyText(normalized, locale)}\n\n${t(locale, 'commands.auto144', { value0: '', value1: normalized })}`,
                buttons: buildFileConcurrencyKeyboard(normalized),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.auto145', { value0: normalized }) }));
            return;
        }

        const confirmMatch = data.match(/^fc_confirm_4$/);
        if (confirmMatch) {
            await setSetting('telegram_file_download_concurrency', '4');
            const normalized = setFileDownloadConcurrency(4);
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildFileConcurrencyText(normalized, locale)}\n\n${t(locale, 'commands.auto146', { value0: '', value1: normalized })}`,
                buttons: buildFileConcurrencyKeyboard(normalized),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'commands.auto147'), alert: true }));
        }
    } catch (error) {
        console.error('🤖 设置文件级并发失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: t(locale, 'commands.settingFailedRetry'),
            alert: true,
        }));
    }
}
