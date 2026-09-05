import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { Raw } from 'telegram/events/index.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { storageManager, type StorageTargetSnapshot } from '../services/storage.js';
import { passwordInputState, isAuthenticatedAsync, loadAuthenticatedUsers, persistAuthenticatedUser, revokeAuthenticatedUser, reconcileTelegramAllowedUsers, userStates, TelegramUserState } from './telegramState.js';
import { is2FAEnabled, generateOTPAuthUrl, verifyTOTP, activate2FA } from '../utils/security.js';
import { handleStart, handleHelp, handleNotifications, handleNotificationsCallback, handleStatus, handleStorage, handleStorageSwitch, handleStorageSwitchCallback, handleTarget, handleTargetCallback, handleFind, handleList, handleDelete, handleDeleteConfirmCallback, handleTelegramFileBrowserCallback, applyPendingTelegramFileMutation, handleTasks, handleTaskCenterCallback, handleBulkTaskCancelCallback, handleStopTasks, handlePauseTasks, handleResumeTasks, handleCancelTask, handleChannelTaskQueueCallback, handleRetryFailedTasks, handleDownloadWorkers, handleDownloadWorkersCallback, handleFileConcurrency, handleFileConcurrencyCallback, handleStorageCleanupCallback, handlePathRules, handlePathOnce, handlePathSession, handlePathClear, handlePathRulesCallback, handleDuplicateMode, handleDuplicateModeCallback, handleCleanupSettings, handleCleanupSettingsCallback } from './telegramCommands.js';
import { handleFileUpload, handleCleanupCallback, pauseDownloadTasks, resumeDownloadTasks, resolveTaskChatIdForControl, refreshSilentProgress, cancelSilentTask, canControlTask, listFailedDownloadTaskDetails, retryFailedDownloadTasks, loadFileDownloadConcurrencySetting } from './telegramUpload.js';

import { enqueueTelegramNotification, flushTelegramNotificationDigest, listTelegramNotificationDigestScopes, resolveNotificationOwnerUserId } from './telegramNotificationDelivery.js';
import { DEFAULT_LOCALE, TELEGRAM_LOCALES, t, type TelegramLocale } from '../i18n/telegram.js';
import { getTelegramUserLocale, getTelegramUserLocaleOrDefault, setTelegramUserLocale } from './telegramLocalePreferences.js';
import {
    enqueueTelegramDateDownload,
    enqueueTelegramTagDownload,
    findTelegramSubscription,
    listTelegramSubscriptions,
    type TelegramJobProgressSummary,
    startTelegramJobRecoveryWorker,
    startTelegramSubscriptionWorker,
    stopTelegramBackgroundWorkers,
    subscribeTelegramChannel,
    unsubscribeTelegramChannel,
    updateTelegramSubscriptionFolder,
    setTelegramSubscriptionEnabled,
    updateTelegramSubscriptionTarget,
    setTelegramSubscriptionFromNow,
    requestTelegramSubscriptionSync,
    retryTelegramBackgroundJob,
    TELEGRAM_COMMENTS_MAX_PER_POST,
} from './telegramChannelJobs.js';
import { MSG, buildStartPrompt, buildAuthSuccess, build2FASetupCaption } from '../utils/telegramMessages.js';
import { query } from '../db/index.js';
import { getConfiguredTelegramAllowedUsers, addTelegramAllowedUser, countAuthenticatedTelegramUsers, shouldAutoAllowFirstTelegramUser, verifyTelegramPin } from '../utils/authSettings.js';
import { assertPublicHttpUrl } from '../utils/networkSecurity.js';
import { consumeOrGetTelegramTargetState } from '../utils/telegramTargetStateStore.js';
import { BOT_COMMANDS, buildBotCommandMenu, normalizeBotCommandText } from '../utils/telegramCommandRegistry.js';
import { buildCommandHomePage } from './telegramCommandDispatcher.js';
import { rememberRecentTelegramPathPersistent, buildPathPreviewLine, applyPendingTelegramPathInputPersistent, getPendingTelegramPathInput, clearPendingTelegramPathInput } from '../utils/telegramPathSettings.js';
import { isTelegramSubscriptionVisibleInManagement } from './telegramSubscriptionVisibility.js';
import { buildTelegramSubscriptionPage, buildSubscriptionOperations, parseTelegramSubscriptionCallback } from './telegramSubscriptionManagement.js';
import { parseDateOnlyStrict, parseTelegramDateRange } from './telegramDateRange.js';
import { TelegramInteractionStore } from './telegramInteractionState.js';
import { messageChatKey, callbackChatKey, telegramSubscriptionPeerKey } from '../bot/context.js';
import { buildSubscriptionDisplayLines, buildSubscriptionManagePanel as buildSubscriptionManagePanelText } from '../bot/presentation/subscription.js';
import {
    classifyTelegramBotStartupError,
    getTelegramBotStatus,
    markTelegramBotError,
    markTelegramBotReady,
    markTelegramBotStarting,
    resetTelegramBotStatus,
} from './telegramBotStatus.js';
import { getEffectiveTelegramBotConfig, setTelegramBotIdentity, type TelegramBotCredentials } from './telegramBotConfig.js';
import { getSetting, setSetting } from '../utils/settings.js';
import { withTelegramOperationDeadline } from './telegramOperationDeadline.js';

const TELEGRAM_BOT_COMMAND_MENU_FINGERPRINT_SETTING = 'telegram_bot_command_menu_fingerprint';
const TELEGRAM_BOT_USER_ISOLATION_MIN_MS = 60_000;
const TELEGRAM_BOT_USER_ISOLATION_MAX_MS = 120_000;

let postStartupTimer: NodeJS.Timeout | null = null;
let postStartupGeneration = 0;

function cancelTelegramBotPostStartup(): void {
    postStartupGeneration += 1;
    if (postStartupTimer) clearTimeout(postStartupTimer);
    postStartupTimer = null;
}

function telegramBotPostStartupDelayMs(): number {
    const configured = Number.parseInt(process.env.TELEGRAM_BOT_USER_ISOLATION_MS || '', 10);
    if (Number.isFinite(configured) && configured >= TELEGRAM_BOT_USER_ISOLATION_MIN_MS) {
        return Math.min(10 * 60_000, configured);
    }
    return crypto.randomInt(TELEGRAM_BOT_USER_ISOLATION_MIN_MS, TELEGRAM_BOT_USER_ISOLATION_MAX_MS + 1);
}

export function scheduleTelegramBotPostStartup(restoreUserAccounts: () => Promise<void>): void {
    cancelTelegramBotPostStartup();
    const generation = postStartupGeneration;
    const activeClient = client;
    const delayMs = telegramBotPostStartupDelayMs();
    console.log(`🤖 Telegram 用户账号与后台任务将在 ${Math.ceil(delayMs / 1000)} 秒隔离窗口后恢复`);
    postStartupTimer = setTimeout(() => {
        postStartupTimer = null;
        void (async () => {
            if (generation !== postStartupGeneration) return;
            await restoreUserAccounts();
            if (generation !== postStartupGeneration || !activeClient || client !== activeClient || !activeClient.connected || getTelegramBotStatus().status !== 'ready') return;
            startTelegramSubscriptionWorker(activeClient);
            startTelegramJobRecoveryWorker(activeClient);
            console.log('🤖 Telegram 用户账号及订阅后台任务已在隔离窗口后恢复');
        })().catch(error => console.error('🤖 Telegram 启动后运行时恢复失败:', error));
    }, delayMs);
    postStartupTimer.unref?.();
}

function buildBotStartKeyboard(locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({ buttons: [
                new Api.KeyboardButtonCallback({ text: t(locale, 'keyboard.upload'), data: Buffer.from('home_upload') }),
                new Api.KeyboardButtonCallback({ text: t(locale, 'keyboard.tasks'), data: Buffer.from('home_tasks') }),
            ] }),
            new Api.KeyboardButtonRow({ buttons: [
                new Api.KeyboardButtonCallback({ text: t(locale, 'keyboard.storage'), data: Buffer.from('home_storage') }),
                new Api.KeyboardButtonCallback({ text: t(locale, 'keyboard.more'), data: Buffer.from('home_more') }),
            ] }),
        ],
    });
}

function homePageKeyboard(requestedPage: number, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    const page = buildCommandHomePage(requestedPage);
    return new Api.ReplyInlineMarkup({
        rows: page.buttons.map(row => new Api.KeyboardButtonRow({
            buttons: row.map(button => {
                const command = button.data.match(/^home_open_(.+)$/)?.[1];
                const definition = command ? BOT_COMMANDS.find(item => item.command === command) : undefined;
                return new Api.KeyboardButtonCallback({ text: definition ? t(locale, `menu.${definition.command}`) : button.text, data: Buffer.from(button.data) });
            }),
        })),
    });
}

function homePageText(requestedPage: number, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const page = buildCommandHomePage(requestedPage);
    return [`☰ **${t(locale, `bot.home.category.${page.category}`)}**`, t(locale, 'bot.home.page', { page: page.page + 1, totalPages: page.totalPages }), '', t(locale, 'bot.home.hint')].join('\n');
}


async function handleBotHomeCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) return;
    const locale = await getTelegramUserLocaleOrDefault(userId);
    const currentMessage = async () => client!.getMessages(update.peer, { ids: Number(update.msgId) }).then(messages => messages[0] as Api.Message);
    if (data === 'home_tasks' || data === 'home_open_tasks') return handleTasks(await currentMessage(), locale);
    if (data === 'home_storage' || data === 'home_open_storage') return handleStorage(await currentMessage(), locale);
    if (data === 'home_upload') {
        await client!.editMessage(update.peer, { message: Number(update.msgId), text: t(locale, 'bot.home.uploadHint'), buttons: buildBotStartKeyboard(locale) });
        return;
    }
    const pageMatch = data.match(/^home_page_(\d+)$/);
    if (data === 'home_more' || pageMatch) {
        const page = pageMatch ? Number(pageMatch[1]) : 0;
        await client!.editMessage(update.peer, { message: Number(update.msgId), text: homePageText(page, locale), buttons: homePageKeyboard(page, locale) });
        return;
    }
    const openMatch = data.match(/^home_open_([a-z0-9_]+)$/);
    if (!openMatch) return;
    const command = openMatch[1];
    const message = await currentMessage();
    if (command === 'storage_switch') return handleStorageSwitch(message);
    if (command === 'target') return handleTarget(message, []);
    if (command === 'path_rules') return handlePathRules(message, locale);
    if (command === 'tg_download') return startTelegramWizard(message, userId, 'tg_download');
    if (command === 'tg_sub') return startTelegramWizard(message, userId, 'tg_sub_manage');
    if (command === 'tg_subs') {
        const rows = await listManageableTelegramSubscriptions(userId);
        const locale = await getTelegramUserLocaleOrDefault(userId);
        await message.reply({ message: buildSubscriptionManagePanel(rows, 0, locale), buttons: buildSubscriptionActionKeyboard(rows, 0, locale) });
        return;
    }
    if (command === 'list') return handleList(message, [], locale);
    if (command === 'find') return handleFind(message, [], locale);
    if (command === 'status') return handleStatus(message, locale);
    if (command === 'notifications') return handleNotifications(message, [], locale);
    if (command === 'tasks') return handleTasks(message, locale);
    if (command === 'task_pause') return handlePauseTasks(message, []);
    if (command === 'task_resume') return handleResumeTasks(message, []);
    if (command === 'stop_tasks') return handleStopTasks(message);
    if (command === 'tg_retry') return handleRetryFailedTasks(message, []);
    if (command === 'download_workers') return handleDownloadWorkers(message, locale);
    if (command === 'file_concurrency') return handleFileConcurrency(message, locale);
    if (command === 'pc') return handlePathClear(message);
    if (command === 'duplicate_mode') return handleDuplicateMode(message, locale);
    if (command === 'cleanup_settings') return handleCleanupSettings(message, locale);
    if (command === 'help') return handleHelp(message, homePageKeyboard(0, locale), locale);
    if (command === 'logout') {
        await client!.sendMessage(update.peer, { message: t(locale, 'bot.home.logoutHint') });
        return;
    }

    if (command === 'setup_2fa') {
        await client!.sendMessage(update.peer, { message: t(locale, 'bot.home.twoFactorHint') });
        return;
    }
    if (['p', 'ps', 'delete', 'task_cancel', 'tg_unsub'].includes(command)) {
        const prompts: Record<string, string> = {
            p: 'bot.home.prompt.oncePath', ps: 'bot.home.prompt.sessionPath', delete: 'bot.home.prompt.delete',
            task_cancel: 'bot.home.prompt.cancelTask', tg_unsub: 'bot.home.prompt.unsubscribe',
        };
        await client!.sendMessage(update.peer, { message: t(locale, prompts[command]) });
        return;
    }
    const definition = BOT_COMMANDS.find(item => item.command === command);
    await client!.sendMessage(update.peer, {
        message: definition ? t(locale, 'bot.home.followPrompt', { description: t(locale, `menu.${definition.command}`) }) : t(locale, 'bot.home.unavailable'),
    });
}

// GramJS Client
let client: TelegramClient | null = null;
let digestTimer: NodeJS.Timeout | null = null;
let botLifecycle: Promise<void> = Promise.resolve();

type TelegramWizardKind = 'tg_sub_manage' | 'tg_download' | 'tg_date' | 'tg_tag';
type TelegramWizardStep = 'mode' | 'source' | 'path' | 'comments' | 'start_date' | 'end_date' | 'tag' | 'confirm';

interface TelegramWizardState {
    kind: TelegramWizardKind;
    step: TelegramWizardStep;
    source?: string;
    startDate?: string;
    tag?: string;
    endDate?: string;
    dayCount?: number;
    requiresLargeRangeConfirmation?: boolean;
    target?: StorageTargetSnapshot;
    targetProvider?: string;
    targetAccountId?: string | null;
    targetAccountName?: string;
    customFolder?: string;
    includeComments?: boolean;
    commentsMaxPerPost?: number;
    subscriptionId?: string;
    subscriptionTitle?: string;
    subscriptionSource?: string;
}

function buildTelegramDownloadModeKeyboard(locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: t(locale, 'bot.button.dateMode'), data: Buffer.from('tgd_mode_date') }),
                    new Api.KeyboardButtonCallback({ text: t(locale, 'bot.button.tagMode'), data: Buffer.from('tgd_mode_tag') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: t(locale, 'common.cancel'), data: Buffer.from('tgd_cancel') })],
            }),
        ],
    });
}

function buildTelegramCommentsKeyboard(locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: t(locale, 'bot.button.channelOnly'), data: Buffer.from('tgd_comments_off') }),
                    new Api.KeyboardButtonCallback({ text: t(locale, 'bot.button.channelComments'), data: Buffer.from('tgd_comments_on') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: t(locale, 'common.cancel'), data: Buffer.from('tgd_cancel') })],
            }),
        ],
    });
}

const TELEGRAM_INTERACTION_TTL_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_INTERACTION_TTL_MS || '900000', 10) || 900_000);
const TELEGRAM_INTERACTION_MAX_ENTRIES = Math.max(10, parseInt(process.env.TELEGRAM_INTERACTION_MAX_ENTRIES || '1000', 10) || 1_000);
const telegramWizardStates = new TelegramInteractionStore<TelegramWizardState>({
    ttlMs: TELEGRAM_INTERACTION_TTL_MS,
    maxEntries: TELEGRAM_INTERACTION_MAX_ENTRIES,
});


function putTelegramWizardState(
    userId: number,
    chatKey: string,
    state: TelegramWizardState,
    originMessageId?: number,
): void {
    telegramWizardStates.set({
        userId,
        chatKey,
        kind: state.kind,
        step: state.step,
        originMessageId,
        value: state,
    });
}
function refreshTelegramWizardState(
    userId: number,
    chatKey: string,
    state: TelegramWizardState,
    originMessageId?: number,
): void {
    telegramWizardStates.update(userId, chatKey, {
        kind: state.kind,
        step: state.step,
        value: state,
        originMessageId,
    });
}

const pendingSubscriptionCancels = new Map<string, {
    userId: number;
    peerKey: string;
    messageId: number;
    subscriptionId: string;
    page: number;
    expiresAt: number;
}>();
const TELEGRAM_SUBSCRIPTION_CONFIRM_TTL_MS = 2 * 60 * 1000;

interface RateBucket {
    windowStartedAt: number;
    count: number;
}

const telegramRateBuckets = new Map<string, RateBucket>();
const TELEGRAM_MESSAGE_RATE_WINDOW_MS = Math.max(10_000, parseInt(process.env.TELEGRAM_RATE_WINDOW_MS || '60000', 10) || 60_000);
const TELEGRAM_MESSAGE_RATE_MAX = Math.max(5, parseInt(process.env.TELEGRAM_RATE_MAX || '30', 10) || 30);
const TELEGRAM_HEAVY_RATE_WINDOW_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_HEAVY_RATE_WINDOW_MS || '600000', 10) || 600_000);
const TELEGRAM_HEAVY_RATE_MAX = Math.max(1, parseInt(process.env.TELEGRAM_HEAVY_RATE_MAX || '5', 10) || 5);
const TELEGRAM_HEAVY_COMMANDS = new Set(['/tg_download', '/tg_date', '/tg_tag', '/cleanup_settings']);

interface PinFailureState {
    windowStartedAt: number;
    failed: number;
    lockedUntil?: number;
}

const pinFailureState = new Map<number, PinFailureState>();
const TELEGRAM_PIN_FAIL_WINDOW_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_PIN_FAIL_WINDOW_MS || '900000', 10) || 900_000);
const TELEGRAM_PIN_FAIL_MAX = Math.max(3, parseInt(process.env.TELEGRAM_PIN_FAIL_MAX || '5', 10) || 5);
const TELEGRAM_PIN_LOCK_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_PIN_LOCK_MS || '900000', 10) || 900_000);
const TELEGRAM_PIN_REQUIRED_LENGTH = 4;

function getPinLockSeconds(userId: number): number {
    const state = pinFailureState.get(userId);
    if (!state?.lockedUntil) return 0;
    const remaining = state.lockedUntil - Date.now();
    if (remaining <= 0) {
        pinFailureState.delete(userId);
        return 0;
    }
    return Math.ceil(remaining / 1000);
}

function recordPinFailure(userId: number): { locked: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const current = pinFailureState.get(userId);
    const state: PinFailureState = !current || now - current.windowStartedAt >= TELEGRAM_PIN_FAIL_WINDOW_MS
        ? { windowStartedAt: now, failed: 0 }
        : current;
    state.failed += 1;
    if (state.failed >= TELEGRAM_PIN_FAIL_MAX) {
        state.lockedUntil = now + TELEGRAM_PIN_LOCK_MS;
    }
    pinFailureState.set(userId, state);
    return { locked: Boolean(state.lockedUntil && state.lockedUntil > now), retryAfterSeconds: state.lockedUntil ? Math.ceil((state.lockedUntil - now) / 1000) : 0 };
}

function clearPinFailures(userId: number): void {
    pinFailureState.delete(userId);
}


function consumeTelegramRateLimit(userId: number, text: string): { limited: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const normalized = text.trim().split(/\s+/, 1)[0].replace(/@\w+$/, '').toLowerCase();
    const checks = [
        { key: `${userId}:all`, windowMs: TELEGRAM_MESSAGE_RATE_WINDOW_MS, max: TELEGRAM_MESSAGE_RATE_MAX },
    ];

    if (TELEGRAM_HEAVY_COMMANDS.has(normalized)) {
        checks.push({ key: `${userId}:heavy:${normalized}`, windowMs: TELEGRAM_HEAVY_RATE_WINDOW_MS, max: TELEGRAM_HEAVY_RATE_MAX });
    }

    let longestRetryAfter = 0;
    for (const check of checks) {
        const bucket = telegramRateBuckets.get(check.key);
        if (!bucket || now - bucket.windowStartedAt >= check.windowMs) {
            telegramRateBuckets.set(check.key, { windowStartedAt: now, count: 1 });
            continue;
        }
        if (bucket.count >= check.max) {
            longestRetryAfter = Math.max(longestRetryAfter, Math.ceil((check.windowMs - (now - bucket.windowStartedAt)) / 1000));
            continue;
        }
        bucket.count += 1;
    }

    // Opportunistic cleanup to avoid unbounded growth in long-running bots.
    for (const [key, bucket] of telegramRateBuckets) {
        if (now - bucket.windowStartedAt > Math.max(TELEGRAM_MESSAGE_RATE_WINDOW_MS, TELEGRAM_HEAVY_RATE_WINDOW_MS) * 2) {
            telegramRateBuckets.delete(key);
        }
    }

    return { limited: longestRetryAfter > 0, retryAfterSeconds: longestRetryAfter };
}

function isCancelInput(text: string): boolean {
    return /^(取消|cancel|退出|stop)$/i.test(text.trim());
}

function buildTelegramWizardPrompt(state: TelegramWizardState, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const title = state.kind === 'tg_sub_manage'
        ? t(locale, 'bot.wizard.title.subscription')
        : state.kind === 'tg_tag'
            ? t(locale, 'bot.wizard.title.tag')
            : state.kind === 'tg_date'
                ? t(locale, 'bot.wizard.title.date')
                : t(locale, 'bot.wizard.title.download');

    if (state.step === 'mode') {
        return t(locale, 'bot.wizard.mode', { title });
    }

    if (state.step === 'source') {
        return t(locale, 'bot.wizard.source', { title });
    }

    if (state.step === 'path') {
        const scope = state.kind === 'tg_sub_manage'
            ? t(locale, state.subscriptionId ? 'bot.wizard.scope.subscription' : 'bot.wizard.scope.newSubscription')
            : t(locale, 'bot.wizard.scope.download');
        return t(locale, 'bot.wizard.path', { title, source: state.subscriptionSource || state.source, scope });
    }

    if (state.step === 'comments') {
        const folder = state.customFolder
            ? t(locale, 'bot.wizard.folder.custom', { folder: state.customFolder })
            : t(locale, 'bot.wizard.folder.default');
        return t(locale, 'bot.wizard.comments', { title, source: state.subscriptionSource || state.source, folder, count: state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST });
    }

    if (state.step === 'confirm') {
        const range = state.kind === 'tg_tag'
            ? t(locale, 'bot.wizard.confirmTagRange', { tag: state.tag })
            : t(locale, 'bot.wizard.confirmDateRange', { startDate: state.startDate, endDate: state.endDate });
        const dateRangeLines = state.kind === 'tg_date'
            ? [
                t(locale, 'bot.wizard.confirmDays', { days: state.dayCount || 0 }),
                state.requiresLargeRangeConfirmation ? t(locale, 'bot.wizard.confirmLargeRange') : null,
            ]
            : [];
        return [title, '', t(locale, 'bot.wizard.confirmTitle'), t(locale, 'bot.wizard.confirmSource', { source: state.source }), `🔎 ${range}`,
            ...dateRangeLines,
            t(locale, 'bot.wizard.confirmComments', { value: state.includeComments ? t(locale, 'bot.wizard.confirmCommentsOn', { count: state.commentsMaxPerPost }) : t(locale, 'bot.wizard.confirmCommentsOff') }),
            t(locale, 'bot.wizard.confirmFolder', { folder: state.customFolder || t(locale, 'bot.wizard.folder.defaultValue') }),
            t(locale, 'bot.wizard.confirmStorage', { provider: state.targetProvider || t(locale, 'bot.wizard.storage.current'), account: state.targetAccountName || state.targetAccountId || t(locale, 'bot.wizard.storage.currentAccount') }),
            '', t(locale, 'bot.wizard.confirmNote'),
            t(locale, 'bot.wizard.confirmInput')].join('\n');
    }

    if (state.step === 'tag') {
        return t(locale, 'bot.wizard.tag', { title, source: state.subscriptionSource || state.source });
    }

    if (state.step === 'start_date') {
        return t(locale, 'bot.wizard.startDate', { title, source: state.subscriptionSource || state.source });
    }

    return t(locale, 'bot.wizard.endDate', { title, source: state.source, startDate: state.startDate });
}

function isDateOnly(text: string): boolean {
    try {
        parseDateOnlyStrict(text.trim());
        return true;
    } catch {
        return false;
    }
}


interface TelegramDownloadScanSummary {
    source: string;
    mode: 'date' | 'tag';
    channelMessagesScanned: number;
    channelMediaFound: number;
    commentMessagesScanned: number;
    commentMediaFound: number;
    totalMediaFound: number;
    commentsEnabled: boolean;
    commentsMaxPerPost: number;
}

export function buildLegacyJobProgressPresentation(summary: TelegramJobProgressSummary, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const totalDone = summary.completed + summary.failed + summary.skipped;
    const cooldownIsFloodWait = summary.status === 'cooling' && /floodwait/i.test((summary as TelegramJobProgressSummary & { error?: string }).error || '');
    const title = summary.status === 'paused'
        ? t(locale, 'bot.legacy.pausedTitle')
        : summary.status === 'cooling'
            ? (cooldownIsFloodWait ? t(locale, 'bot.legacy.floodWaitTitle') : t(locale, 'bot.legacy.storageCooldownTitle'))
            : summary.status === 'cancelled'
                ? t(locale, 'bot.legacy.cancelledTitle')
                : totalDone >= summary.totalMediaFound && summary.scanStatus === 'done'
                    ? t(locale, 'bot.legacy.completedTitle')
                    : t(locale, 'bot.legacy.runningTitle');
    const controls = summary.status === 'paused'
        ? t(locale, 'bot.legacy.controlsPaused')
        : summary.status === 'cooling' || summary.status === 'cancelled'
            ? ''
            : t(locale, 'bot.legacy.controlsActive');
    return [
        title,
        t(locale, 'bot.legacy.job', { jobId: summary.jobId.slice(0, 12) }),
        t(locale, 'bot.legacy.source', { source: summary.source || t(locale, 'status.state.unknown') }),
        ``,
        t(locale, 'bot.legacy.scan', { status: summary.scanStatus || 'pending' }),
        t(locale, 'bot.legacy.channelScan', { scanned: summary.channelMessagesScanned || 0, found: summary.channelMediaFound || 0 }),
        t(locale, 'bot.legacy.commentScan', { scanned: summary.commentMessagesScanned || 0, found: summary.commentMediaFound || 0 }),
        ``,
        t(locale, 'bot.legacy.download', { status: summary.downloadStatus }),
        t(locale, 'bot.legacy.counts', { completed: summary.completed || 0, pending: summary.pending || 0, downloading: summary.downloading || 0, failed: summary.failed || 0, skipped: summary.skipped || 0 }),
        summary.cooldownUntil ? t(locale, cooldownIsFloodWait ? 'bot.legacy.floodWait' : 'bot.legacy.storageCooldown', { until: summary.cooldownUntil }) : '',
        controls,
    ].filter(Boolean).join('\n');
}

async function updateJobProgressMessage(statusMessage: Api.Message, summary: TelegramJobProgressSummary, locale: TelegramLocale = DEFAULT_LOCALE): Promise<void> {
    await statusMessage.edit({ text: buildLegacyJobProgressPresentation(summary, locale) }).catch(() => undefined);
}

async function updateScanStatusMessage(statusMessage: Api.Message, summary: TelegramDownloadScanSummary, locale: TelegramLocale = DEFAULT_LOCALE): Promise<void> {
    const lines = [
        t(locale, 'bot.legacy.scanComplete'),
        t(locale, 'bot.legacy.source', { source: summary.source }),
        ``,
        t(locale, 'bot.legacy.channelScanned', { scanned: summary.channelMessagesScanned, found: summary.channelMediaFound }),
        summary.commentsEnabled
            ? t(locale, 'bot.legacy.commentsScanned', { scanned: summary.commentMessagesScanned, found: summary.commentMediaFound, max: summary.commentsMaxPerPost })
            : t(locale, 'bot.legacy.commentsDisabled'),
        t(locale, 'bot.legacy.pending', { count: summary.totalMediaFound }),
        ``,
        t(locale, 'bot.legacy.queueing'),
    ];
    await statusMessage.edit({ text: lines.join('\n') }).catch(() => undefined);
}

async function replyWithJobResult(statusMessage: Api.Message, fallbackMessage: Api.Message, promise: Promise<any>, kind: 'date' | 'tag', locale: TelegramLocale = DEFAULT_LOCALE): Promise<void> {
    promise
        .then(result => {
            const cancelled = Boolean(result.cancelled);
            const commentLine = result.commentMediaFound || result.commentMessagesScanned
                ? `\n${t(locale, 'bot.legacy.commentLine', { scanned: result.commentMessagesScanned || 0, found: result.commentMediaFound || 0 })}`
                : '';
            const text = cancelled
                ? t(locale, 'bot.legacy.cancelledResult', { mode: t(locale, kind === 'tag' ? 'bot.wizard.modeTag' : 'bot.wizard.modeDate'), jobId: String(result.jobId).slice(0, 12), successful: result.successful || 0, skipped: result.skipped || 0, commentLine })
                : kind === 'tag'
                    ? t(locale, 'bot.legacy.tagResult', { tag: result.tag, jobId: String(result.jobId).slice(0, 12), found: result.found, skipped: result.skipped, failed: result.failed, commentLine })
                    : t(locale, 'bot.legacy.dateResult', { jobId: String(result.jobId).slice(0, 12), found: result.found, skipped: result.skipped, failed: result.failed, commentLine });
            statusMessage.edit({ text }).catch(() => fallbackMessage.reply({ message: text }).catch(() => undefined));
        })
        .catch(error => {
            const text = t(locale, 'bot.legacy.failed', { mode: kind === 'tag' ? t(locale, 'bot.wizard.modeTag') : t(locale, 'bot.wizard.modeDate'), error: error instanceof Error ? error.message : String(error) });
            statusMessage.edit({ text }).catch(() => fallbackMessage.reply({ message: text }).catch(() => undefined));
        });
}

async function startTelegramWizard(message: Api.Message, senderId: number, kind: TelegramWizardKind): Promise<void> {
    const locale = await getTelegramUserLocaleOrDefault(senderId);
    const state: TelegramWizardState = { kind, step: kind === 'tg_download' ? 'mode' : 'source' };
    const chatKey = messageChatKey(message, senderId);
    let originMessageId: number | undefined;
    if (kind === 'tg_sub_manage') {
        const rows = await listManageableTelegramSubscriptions(senderId);
        const locale = await getTelegramUserLocaleOrDefault(senderId);
        const reply = await message.reply({ message: buildSubscriptionManagePanel(rows, 0, locale), buttons: buildSubscriptionActionKeyboard(rows, 0, locale) });
        originMessageId = (reply as Api.Message).id;
        putTelegramWizardState(senderId, chatKey, state, originMessageId);
        return;
    }
    const reply = await message.reply({
        message: buildTelegramWizardPrompt(state, locale),
        buttons: kind === 'tg_download' ? buildTelegramDownloadModeKeyboard(locale) : undefined,
    });
    originMessageId = (reply as Api.Message).id;
    putTelegramWizardState(senderId, chatKey, state, originMessageId);
}

async function handleTelegramWizardMessage(message: Api.Message, senderId: number, text: string): Promise<boolean> {
    const locale = await getTelegramUserLocaleOrDefault(senderId);
    const chatKey = messageChatKey(message, senderId);
    const lookup = telegramWizardStates.lookup(senderId, chatKey);
    if (lookup.status === 'expired') {
        await message.reply({ message: t(locale, 'bot.wizard.expired') });
        return true;
    }
    if (lookup.status === 'missing') return false;
    const state = lookup.record.value;

    const input = text.trim();
    if (!input) return true;
    refreshTelegramWizardState(senderId, chatKey, state, lookup.record.originMessageId);
    if (isCancelInput(input)) {
        telegramWizardStates.delete(senderId, chatKey);
        await message.reply({ message: t(locale, 'bot.wizard.cancelled') });
        return true;
    }

    if (state.step === 'mode') {
        const normalizedMode = input.toLowerCase();
        if (['date', '日期', '按日期'].includes(normalizedMode)) {
            state.kind = 'tg_date';
            state.step = 'source';
        } else if (['tag', '标签', '按标签'].includes(normalizedMode)) {
            state.kind = 'tg_tag';
            state.step = 'source';
        } else {
            await message.reply({ message: t(locale, 'bot.wizard.invalidMode') });
            return true;
        }
        await message.reply({ message: buildTelegramWizardPrompt(state, locale) });
        return true;
    }

    if (state.step === 'source') {
        const sourceParts = input.split(/\s+/).filter(Boolean);
        const commentFlag = sourceParts[sourceParts.length - 1]?.toLowerCase();
        if (['comments', '--comments', 'include-comments', '评论', '评论区'].includes(commentFlag)) {
            state.includeComments = true;
            state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
            sourceParts.pop();
        } else if (['no-comments', '--no-comments', 'channel-only', '仅频道'].includes(commentFlag)) {
            state.includeComments = false;
            state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
            sourceParts.pop();
        }
        state.source = sourceParts.join(' ') || input;
        if (state.kind === 'tg_sub_manage') {
            if (/^\d+$/.test(input)) {
                const rows = await listManageableTelegramSubscriptions(senderId);
                const index = parseInt(input, 10) - 1;
                const target = rows[index];
                if (!target) {
                    await message.reply({ message: t(locale, 'bot.wizard.subscriptionIndexInvalid') });
                    return true;
                }
                telegramWizardStates.delete(senderId, chatKey);
                await sendSubscriptionCancelConfirmation(message, senderId, target, 0);
                return true;
            }

            if (!input.startsWith('@') && !/^https?:\/\/t\.me\//i.test(input) && !/^-?\d+$/.test(input)) {
                await message.reply({ message: t(locale, 'bot.wizard.subscriptionInputInvalid') });
                return true;
            }

            state.step = 'path';
            await message.reply({ message: buildTelegramWizardPrompt(state, locale) });
            return true;
        }
        state.step = 'path';
        await message.reply({ message: buildTelegramWizardPrompt(state, locale) });
        return true;
    }

    if (state.step === 'path') {
        const skipPath = /^(跳过|skip|默认|default|无|不用|不指定)$/i.test(input);
        if (skipPath) {
            delete state.customFolder;
        } else {
            try {
                state.customFolder = await rememberRecentTelegramPathPersistent(message.chatId?.toString() || 'unknown', input, locale);
            } catch (error) {
                await message.reply({ message: t(locale, 'bot.wizard.pathInvalid', { error: (error as Error).message }) });
                return true;
            }
        }

        if (state.kind === 'tg_sub_manage') {
            telegramWizardStates.delete(senderId, chatKey);
            try {
                if (state.subscriptionId) {
                    const sub = await updateTelegramSubscriptionFolder(senderId, state.subscriptionId, state.customFolder || null);
                    const rowsAfterUpdate = await listManageableTelegramSubscriptions(senderId);
                    await message.reply({
                        message: [
                            sub ? t(locale, 'bot.wizard.subscriptionUpdated', { source: sub.title || sub.source }) : t(locale, 'bot.wizard.subscriptionNotFound'),
                            sub && state.customFolder ? t(locale, 'bot.wizard.subscriptionFolder', { folder: state.customFolder, preview: buildPathPreviewLine(state.customFolder, locale) }) : t(locale, 'bot.wizard.defaultFolder'),
                            '',
                            buildSubscriptionManagePanel(rowsAfterUpdate, 0, locale),
                        ].filter(Boolean).join('\n'),
                        buttons: buildSubscriptionActionKeyboard(rowsAfterUpdate, 0, locale),
                    });
                } else {
                    const sub = await subscribeTelegramChannel(senderId, message.chatId?.toString(), state.source!, state.customFolder);
                    await message.reply({
                        message: [
                            t(locale, 'bot.wizard.subscribed', { source: sub.title || sub.source }),
                            `📍 ${sub.source}`,
                            state.customFolder ? t(locale, 'bot.wizard.subscriptionFolderLabel', { folder: state.customFolder, preview: buildPathPreviewLine(state.customFolder, locale) }) : t(locale, 'bot.wizard.subscriptionDefaultLabel'),
                            t(locale, 'bot.wizard.subscriptionStart', { messageId: sub.last_message_id || 0 }),
                        ].join('\n')
                    });
                }
            } catch (error) {
                await message.reply({ message: t(locale, 'bot.wizard.subscriptionFailed', { error: error instanceof Error ? error.message : String(error) }) });
            }
            return true;
        }

        if (state.kind === 'tg_tag' || state.kind === 'tg_date') {
            state.step = state.includeComments !== undefined ? (state.kind === 'tg_tag' ? 'tag' : 'start_date') : 'comments';
            await message.reply({ message: buildTelegramWizardPrompt(state, locale), buttons: state.step === 'comments' ? buildTelegramCommentsKeyboard(locale) : undefined });
            return true;
        }
        return true;

    }

    if (state.step === 'comments') {
        const enabled = /^(开|开启|是|包含|评论|评论区|yes|y|on|true|1)$/i.test(input);
        const disabled = /^(关|关闭|否|不包含|仅频道|no|n|off|false|0)$/i.test(input);
        if (!enabled && !disabled) {
            await message.reply({ message: t(locale, 'bot.wizard.invalidComments') });
            return true;
        }
        state.includeComments = enabled;
        state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
        state.step = state.kind === 'tg_tag' ? 'tag' : 'start_date';
        await message.reply({ message: buildTelegramWizardPrompt(state, locale) });
        return true;
    }

    if (state.step === 'confirm') {
        if (!/^(确认|confirm|yes|y)$/i.test(input)) {
            await message.reply({ message: t(locale, 'bot.wizard.confirmInput') });
            return true;
        }
        telegramWizardStates.delete(senderId, chatKey);
        try {
            if (state.kind === 'tg_tag') {
                const queuedMsg = await message.reply({ message: t(locale, 'bot.legacy.confirmTag', { source: state.source, tag: state.tag?.startsWith('#') ? state.tag : `#${state.tag}` }) });
                await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramTagDownload(client!, message, senderId, state.source!, state.tag!, state.customFolder, {
                    includeComments: Boolean(state.includeComments), commentsMaxPerPost: state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
                    onScanComplete: summary => updateScanStatusMessage(queuedMsg as Api.Message, summary, locale), onProgress: summary => updateJobProgressMessage(queuedMsg as Api.Message, summary, locale),
                    target: state.target,
                }), 'tag', locale);
            } else {
                const queuedMsg = await message.reply({ message: t(locale, 'bot.legacy.confirmDate', { source: state.source, startDate: state.startDate, endDate: state.endDate }) });
                await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramDateDownload(client!, message, senderId, state.source!, state.startDate!, state.endDate!, state.customFolder, {
                    includeComments: Boolean(state.includeComments), commentsMaxPerPost: state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
                    onScanComplete: summary => updateScanStatusMessage(queuedMsg as Api.Message, summary, locale), onProgress: summary => updateJobProgressMessage(queuedMsg as Api.Message, summary, locale),
                    target: state.target,
                }), 'date', locale);
            }
        } catch (error) {
            await message.reply({ message: t(locale, 'bot.legacy.submitFailed', { error: error instanceof Error ? error.message : String(error) }) });
        }
        return true;
    }

    if (state.step === 'tag') {
        state.tag = input;
        const selectedTarget = await consumeOrGetTelegramTargetState(chatKey);
        const target = selectedTarget
            ? storageManager.getTarget(selectedTarget.provider, selectedTarget.accountId)
            : storageManager.getActiveTarget();
        const accounts = await storageManager.getAccounts();
        state.target = target;
        state.targetProvider = target.provider.name;
        state.targetAccountId = target.accountId;
        state.targetAccountName = accounts.find(account => String(account.id) === String(target.accountId || ''))?.name || (target.provider.name === 'local' ? '服务器本地目录' : undefined);
        state.step = 'confirm';
        await message.reply({ message: buildTelegramWizardPrompt(state, locale) });
        return true;
    }

    if (state.step === 'start_date') {
        if (!isDateOnly(input)) {
            await message.reply({ message: t(locale, 'bot.wizard.invalidDate', { example: '2026-06-01' }) });
            return true;
        }
        state.startDate = input;
        state.step = 'end_date';
        await message.reply({ message: buildTelegramWizardPrompt(state, locale) });
        return true;
    }

    if (!isDateOnly(input)) {
        await message.reply({ message: t(locale, 'bot.wizard.invalidDate', { example: '2026-06-27' }) });
        return true;
    }

    let dateRange;
    try {
        dateRange = parseTelegramDateRange(state.startDate!, input);
    } catch (error) {
        await message.reply({ message: `❌ ${error instanceof Error ? error.message : t(locale, 'bot.wizard.invalidRange')}` });
        return true;
    }

    state.endDate = input;
    state.dayCount = dateRange.dayCount;
    state.requiresLargeRangeConfirmation = dateRange.requiresLargeRangeConfirmation;
    const selectedTarget = await consumeOrGetTelegramTargetState(chatKey);
    const target = selectedTarget
        ? storageManager.getTarget(selectedTarget.provider, selectedTarget.accountId)
        : storageManager.getActiveTarget();
    const accounts = await storageManager.getAccounts();
    state.target = target;
    state.targetProvider = target.provider.name;
    state.targetAccountId = target.accountId;
    state.targetAccountName = accounts.find(account => String(account.id) === String(target.accountId || ''))?.name || (target.provider.name === 'local' ? '服务器本地目录' : undefined);
    state.step = 'confirm';
    await message.reply({ message: buildTelegramWizardPrompt(state, locale) });
    return true;
}

async function listManageableTelegramSubscriptions(userId: number): Promise<any[]> {
    const rows = await listTelegramSubscriptions(userId, true);
    return rows.filter(isTelegramSubscriptionVisibleInManagement);
}

function buildSubscriptionActionKeyboard(rows: any[], requestedPage = 0, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    const page = buildTelegramSubscriptionPage(rows, requestedPage);
    const actionRows = page.visibleRows.flatMap((row, localIndex) => [
        new Api.KeyboardButtonRow({
            buttons: [new Api.KeyboardButtonCallback({ text: `${page.startIndex + localIndex + 1}. ${row.title || row.source}`, data: Buffer.from(`tsub_view_${row.id}_${page.page}`) })],
        }),
        ...[0, 2, 5].map((start, index, starts) => new Api.KeyboardButtonRow({
            buttons: buildSubscriptionOperations(row, locale).slice(start, starts[index + 1]).map(operation => new Api.KeyboardButtonCallback({
                text: operation.label,
                data: Buffer.from(`tsub_${operation.action}_${row.id}_${page.page}`),
            })),
        })),
        new Api.KeyboardButtonRow({
            buttons: [
                new Api.KeyboardButtonCallback({ text: t(locale, 'bot.button.editFolder'), data: Buffer.from(`tsub_folder_${row.id}_${page.page}`) }),
                new Api.KeyboardButtonCallback({ text: t(locale, 'bot.button.clearFolder'), data: Buffer.from(`tsub_clear_${row.id}_${page.page}`) }),
                new Api.KeyboardButtonCallback({ text: t(locale, 'bot.button.unsubscribe'), data: Buffer.from(`tsub_cancel_${row.id}_${page.page}`) }),
            ],
        }),
    ]);
    const navigation: Api.TypeKeyboardButton[] = [];
    if (page.page > 0) navigation.push(new Api.KeyboardButtonCallback({ text: t(locale, 'bot.button.previous'), data: Buffer.from(`tsub_page_${page.page - 1}`) }));
    navigation.push(new Api.KeyboardButtonCallback({ text: `🔄 ${t(locale, 'common.refresh')}`, data: Buffer.from(`tsub_page_${page.page}`) }));
    if (page.page + 1 < page.totalPages) navigation.push(new Api.KeyboardButtonCallback({ text: t(locale, 'bot.button.next'), data: Buffer.from(`tsub_page_${page.page + 1}`) }));
    return new Api.ReplyInlineMarkup({
        rows: [
            ...actionRows,
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: t(locale, 'bot.button.addSubscription'), data: Buffer.from('tsub_add') })],
            }),
            new Api.KeyboardButtonRow({ buttons: navigation }),
        ],
    });
}

function buildSubscriptionManagePanel(rows: any[], requestedPage = 0, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return buildSubscriptionManagePanelText(rows, buildTelegramSubscriptionPage(rows, requestedPage), locale);
}

function buildSubscriptionCancelConfirm(target: any, token: string, locale: TelegramLocale = DEFAULT_LOCALE): { text: string; buttons: Api.ReplyInlineMarkup } {
    return {
        text: [
            t(locale, 'bot.subscription.confirmTitle'),
            '',
            `📌 ${target.title || target.source_original || target.source}`,
            t(locale, 'bot.subscription.source', { source: target.source_original || target.source }),
            target.folder_override ? t(locale, 'bot.subscription.folder', { folder: target.folder_override }) : t(locale, 'bot.subscription.defaultFolder'),
            t(locale, 'bot.subscription.position', { messageId: target.last_message_id || 0 }),
            '',
            t(locale, 'bot.subscription.confirmBody'),
        ].join('\n'),
        buttons: new Api.ReplyInlineMarkup({
            rows: [new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: t(locale, 'bot.subscription.confirmButton'), data: Buffer.from(`tsub_confirm_${token}`) }),
                    new Api.KeyboardButtonCallback({ text: t(locale, 'bot.subscription.backButton'), data: Buffer.from(`tsub_back_${token}`) }),
                ],
            })],
        }),
    };
}

async function sendSubscriptionCancelConfirmation(message: Api.Message, userId: number, target: any, page: number): Promise<void> {
    const token = crypto.randomBytes(12).toString('base64url');
    const locale = await getTelegramUserLocaleOrDefault(userId);
    const confirm = buildSubscriptionCancelConfirm(target, token, locale);
    const sent = await message.reply({ message: confirm.text, buttons: confirm.buttons }) as Api.Message;
    const messageId = Number(sent.id);
    pendingSubscriptionCancels.set(token, {
        userId,
        peerKey: telegramSubscriptionPeerKey(sent.peerId || message.peerId),
        messageId,
        subscriptionId: String(target.id),
        page,
        expiresAt: Date.now() + TELEGRAM_SUBSCRIPTION_CONFIRM_TTL_MS,
    });
}

async function editSubscriptionCancelConfirmation(update: Api.UpdateBotCallbackQuery, userId: number, target: any, page: number): Promise<void> {
    const token = crypto.randomBytes(12).toString('base64url');
    pendingSubscriptionCancels.set(token, {
        userId,
        peerKey: telegramSubscriptionPeerKey(update.peer),
        messageId: Number(update.msgId),
        subscriptionId: String(target.id),
        page,
        expiresAt: Date.now() + TELEGRAM_SUBSCRIPTION_CONFIRM_TTL_MS,
    });
    const locale = await getTelegramUserLocaleOrDefault(userId);
    const confirm = buildSubscriptionCancelConfirm(target, token, locale);
    await client!.editMessage(update.peer, { message: Number(update.msgId), text: confirm.text, buttons: confirm.buttons });
}

function getPendingSubscriptionCancel(update: Api.UpdateBotCallbackQuery, token: string, userId: number) {
    const pending = pendingSubscriptionCancels.get(token);
    if (!pending) return null;
    if (pending.expiresAt < Date.now()) {
        pendingSubscriptionCancels.delete(token);
        return null;
    }
    if (pending.userId !== userId || pending.peerKey !== telegramSubscriptionPeerKey(update.peer) || pending.messageId !== Number(update.msgId)) return null;
    return pending;
}

// Generate Password Keyboard
function generatePasswordKeyboard(currentLength: number, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    const display = '●'.repeat(currentLength) + '-'.repeat(Math.max(0, 4 - currentLength));
    const displayWithSpaces = display.split('').join(' ');

    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `🔒  ${displayWithSpaces}`, data: Buffer.from('pwd_display') })
                ]
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '1', data: Buffer.from('pwd_1') }),
                    new Api.KeyboardButtonCallback({ text: '2', data: Buffer.from('pwd_2') }),
                    new Api.KeyboardButtonCallback({ text: '3', data: Buffer.from('pwd_3') }),
                ]
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '4', data: Buffer.from('pwd_4') }),
                    new Api.KeyboardButtonCallback({ text: '5', data: Buffer.from('pwd_5') }),
                    new Api.KeyboardButtonCallback({ text: '6', data: Buffer.from('pwd_6') }),
                ]
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '7', data: Buffer.from('pwd_7') }),
                    new Api.KeyboardButtonCallback({ text: '8', data: Buffer.from('pwd_8') }),
                    new Api.KeyboardButtonCallback({ text: '9', data: Buffer.from('pwd_9') }),
                ]
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: t(locale, 'keyboard.cancel'), data: Buffer.from('pwd_clear') }),
                    new Api.KeyboardButtonCallback({ text: '0', data: Buffer.from('pwd_0') }),
                    new Api.KeyboardButtonCallback({ text: '⌫', data: Buffer.from('pwd_backspace') }),
                ]
            }),
        ],
    });
}



export function canTelegramUserAuthenticate(userId: number, allowedUsers: number[]): boolean {
    return allowedUsers.length > 0 && allowedUsers.includes(userId);
}

export function languageKeyboard(locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [
        new Api.KeyboardButtonCallback({ text: t(locale, 'language.chinese'), data: Buffer.from('lang_zh-CN') }),
        new Api.KeyboardButtonCallback({ text: t(locale, 'language.english'), data: Buffer.from('lang_en') }),
        new Api.KeyboardButtonCallback({ text: t(locale, 'language.russian'), data: Buffer.from('lang_ru') }),
    ] })] });
}

function languagePanel(locale: TelegramLocale): string {
    return [t(locale, 'language.title'), '', t(locale, 'language.current', { language: TELEGRAM_LOCALES[locale].nativeName }), t(locale, 'language.hint')].join('\n');
}

async function renderStartAfterLocale(update: Api.UpdateBotCallbackQuery, userId: number, locale: TelegramLocale): Promise<void> {
    const authenticated = await isAuthenticatedAsync(userId);
    await client!.editMessage(update.peer, {
        message: Number(update.msgId),
        text: authenticated ? t(locale, 'auth.welcomeBack') : t(locale, 'auth.startPrompt'),
        buttons: authenticated ? buildBotStartKeyboard(locale) : generatePasswordKeyboard(0, locale),
    });
}

async function handleLanguageSelection(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    const locale: TelegramLocale = data === 'lang_en' ? 'en' : data === 'lang_ru' ? 'ru' : 'zh-CN';
    await getTelegramUserLocale(userId);
    await setTelegramUserLocale(userId, locale);
    await renderStartAfterLocale(update, userId, locale);
    await client!.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'language.changed') }));
}

async function handlePasswordCallback(update: Api.UpdateBotCallbackQuery): Promise<void> {
    if (!client) return;

    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
    const data = Buffer.from(update.data || []).toString('utf-8');

    if (!data.startsWith('pwd_')) return;

    const lockSeconds = getPinLockSeconds(userId);
    if (lockSeconds > 0) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: `密码错误次数过多，请 ${lockSeconds} 秒后再试`,
            alert: true,
        }));
        return;
    }

    let state = passwordInputState.get(userId);
    if (!state) {
        state = { password: '' };
        passwordInputState.set(userId, state);
    }

    try {
        if (data === 'pwd_display') {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
            return;
        }

        if (data === 'pwd_backspace') {
            state.password = state.password.slice(0, -1);
        } else if (data === 'pwd_clear') {
            state.password = '';
            passwordInputState.delete(userId);
            await client.editMessage(update.peer, {
                message: update.msgId,
                text: MSG.AUTH_CANCELLED,
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
            return;
        } else {
            const digit = data.replace('pwd_', '');
            if (/^[0-9]$/.test(digit)) {
                state.password = (state.password + digit).slice(0, TELEGRAM_PIN_REQUIRED_LENGTH);

                if (state.password.length >= TELEGRAM_PIN_REQUIRED_LENGTH) {
                    const pinOk = await verifyTelegramPin(state.password);
                    if (!pinOk) {
                        state.password = '';
                        const failure = recordPinFailure(userId);
                        const text = failure.locked
                            ? `❌ 密码错误次数过多，已临时锁定 ${failure.retryAfterSeconds} 秒。`
                            : MSG.AUTH_WRONG;
                        await client.editMessage(update.peer, {
                            message: update.msgId,
                            text,
                            buttons: generatePasswordKeyboard(0),
                        });
                        await client.invoke(new Api.messages.SetBotCallbackAnswer({
                            queryId: update.queryId,
                            message: failure.locked ? '已临时锁定' : '密码错误',
                            alert: failure.locked,
                        }));
                        return;
                    }

                    let allowedUsers = await getConfiguredTelegramAllowedUsers();
                    if (!canTelegramUserAuthenticate(userId, allowedUsers)) {
                        const authenticatedUserCount = await countAuthenticatedTelegramUsers();
                        if (shouldAutoAllowFirstTelegramUser(allowedUsers, authenticatedUserCount)) {
                            allowedUsers = await addTelegramAllowedUser(userId);
                        }
                    }

                    if (!canTelegramUserAuthenticate(userId, allowedUsers)) {
                        state.password = '';
                        const locale = await getTelegramUserLocaleOrDefault(userId);
                        await client.editMessage(update.peer, {
                            message: update.msgId,
                            text: t(locale, 'bot.auth.notAllowed'),
                            buttons: generatePasswordKeyboard(0, locale),
                        });
                        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'bot.auth.notAllowedShort'), alert: true }));
                        return;
                    }
                    passwordInputState.delete(userId);

                    if (await is2FAEnabled()) {
                        userStates.set(userId, {
                            state: TelegramUserState.WAITING_2FA_LOGIN,
                            promptMessageId: update.msgId
                        });
                        await client.editMessage(update.peer, {
                            message: update.msgId,
                            text: MSG.AUTH_2FA_PROMPT,
                        });
                        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_2FA_TOAST }));
                        return;
                    }

                    await persistAuthenticatedUser(userId);
                    await client.editMessage(update.peer, {
                        message: update.msgId,
                        text: buildAuthSuccess(),
                    });
                    await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_SUCCESS }));
                    return;
                }
            }
        }

        await client.editMessage(update.peer, {
            message: update.msgId,
            text: MSG.AUTH_INPUT_PROMPT,
            buttons: generatePasswordKeyboard(state.password.length),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
    } catch (error) {
        console.error('🤖 处理密码回调失败:', error);
        try {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId }));
        } catch (e) { /* ignore */ }
    }
}

// Handle Cleanup Button Callback
async function handleCleanupButtonCallback(update: Api.UpdateBotCallbackQuery, cleanupId: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const result = await handleCleanupCallback(cleanupId);

        // 更新原消息显示清理结果
        try {
            await client.editMessage(update.peer, {
                message: update.msgId,
                text: result.message,
            });
        } catch (e) {
            console.error('🤖 更新清理结果消息失败:', e);
        }

        // 发送回调应答
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: result.success ? t(locale, 'bot.callback.cleanupSuccess') : t(locale, 'bot.callback.cleanupFailed')
        }));
    } catch (error) {
        console.error('🤖 处理清理回调失败:', error);
        try {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: t(locale, 'bot.callback.cleanupFailed')
            }));
        } catch (e) { /* ignore */ }
    }
}

async function handleUploadReceiptCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const match = data.match(/^receipt_(retry|failures)_([A-Za-z0-9_-]+)$/);
    if (!match) return;
    const [, action, taskId] = match;
    const chatId = resolveTaskChatIdForControl(taskId);
    const callbackChatId = callbackChatKey(update, userId);
    if (!chatId || callbackChatId !== messageChatKey(({ chatId } as unknown) as Api.Message, userId) || !canControlTask(taskId, chatId, userId)) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'bot.callback.taskCardInvalid'), alert: true }));
        return;
    }
    if (action === 'retry') {
        const result = await retryFailedDownloadTasks(50, taskId, chatId, userId);
        await refreshSilentProgress(client, update.peer, userId);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: result.retried > 0 ? t(locale, 'bot.callback.retryCount', { count: result.retried }) : t(locale, 'bot.callback.noRetry') }));
        return;
    }
    const details = listFailedDownloadTaskDetails(taskId, chatId, userId);
    await client.sendMessage(update.peer, { message: [t(locale, 'bot.callback.failureDetailsTitle'), '', ...(details.length ? details.slice(0, 30).map(item => `• ${item}`) : [t(locale, 'bot.callback.failureDetailsEmpty')])].join('\n') });
    await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'bot.callback.failureDetailsSent') }));
}

async function handleTaskQueueCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    if (!client) return;
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

    const match = data.match(/^tq_(pause|resume|cancel)_(.+)$/);
    if (!match) return;
    const [, action, taskId] = match;
    const controlChatId = resolveTaskChatIdForControl(taskId);
    const callbackChatId = (() => {
        const peer: any = update.peer as any;
        const value = peer?.userId || peer?.chatId || peer?.channelId;
        if (value && typeof value.toString === 'function') return value.toString().replace(/^-100/, '').replace(/^-/, '');
        return String(value || '');
    })();
    const canonicalControlChatId = String(controlChatId || '').replace(/^-100/, '').replace(/^-/, '');
    if (!controlChatId || callbackChatId !== canonicalControlChatId || !canControlTask(taskId, controlChatId, userId)) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: t(locale, 'bot.callback.taskUnavailable'),
            alert: true,
        }));
        return;
    }
    try {
        if (action === 'pause') {
            const result = pauseDownloadTasks(taskId);
            await refreshSilentProgress(client, update.peer, userId);
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: result.total > 0 ? t(locale, 'bot.callback.queuePaused') : t(locale, 'bot.callback.noPausableTasks') }));
            return;
        }
        if (action === 'resume') {
            const result = resumeDownloadTasks(taskId);
            await refreshSilentProgress(client, update.peer, userId);
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: result.total > 0 ? t(locale, 'bot.callback.queueResumed') : t(locale, 'bot.callback.noWaitingTasks') }));
            return;
        }
        await cancelSilentTask(client, update.peer, taskId, update.msgId, userId);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'bot.callback.backgroundCancelled'), alert: true }));
    } catch (error) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: t(locale, 'bot.callback.operationFailed', { error: (error as Error).message }),
            alert: true,
        }));
    }
}

async function handleTelegramDownloadModeCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const chatKey = callbackChatKey(update, userId);
    const action = data.replace(/^tgd_/, '');
    const validation = telegramWizardStates.validateCallback({
        userId,
        chatKey,
        messageId: Number(update.msgId),
        action,
        allowedActions: ['cancel', 'mode_date', 'mode_tag', 'comments_on', 'comments_off'],
    });
    if (!validation.ok) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'bot.wizard.callbackExpired'), alert: true }));
        return;
    }
    const record = telegramWizardStates.get(userId, chatKey)!;
    const state = record.value;
    if (data === 'tgd_cancel') {
        telegramWizardStates.delete(userId, chatKey);
        await client.editMessage(update.peer, { message: update.msgId, text: t(locale, 'bot.wizard.downloadCancelled') });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'bot.callback.cancelled') }));
        return;
    }
    if (data === 'tgd_mode_date') {
        state.kind = 'tg_date';
        state.step = 'source';
        putTelegramWizardState(userId, chatKey, state, record.originMessageId);
        await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state, locale) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'bot.wizard.modeDate') }));
        return;
    }
    if (data === 'tgd_mode_tag') {
        state.kind = 'tg_tag';
        state.step = 'source';
        putTelegramWizardState(userId, chatKey, state, record.originMessageId);
        await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state, locale) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: t(locale, 'bot.wizard.modeTag') }));
        return;
    }
    if (data === 'tgd_comments_on' || data === 'tgd_comments_off') {
        state.includeComments = data === 'tgd_comments_on';
        state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
        state.step = state.kind === 'tg_tag' ? 'tag' : 'start_date';
        putTelegramWizardState(userId, chatKey, state, record.originMessageId);
        await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state, locale) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: t(locale, state.includeComments ? 'bot.wizard.commentsOn' : 'bot.wizard.commentsOff'),
        }));
    }
}

async function handleTelegramSubscriptionCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
    const locale = await getTelegramUserLocaleOrDefault(userId);
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const parsed = parseTelegramSubscriptionCallback(data);
    if (data === 'tsub_add') {
        const state: TelegramWizardState = { kind: 'tg_sub_manage', step: 'source' };
        putTelegramWizardState(userId, callbackChatKey(update, userId), state, Number(update.msgId));
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildTelegramWizardPrompt(state, locale),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请发送频道' }));
        return;
    }
    if (!parsed) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '订阅按钮无效或已过期', alert: true }));
        return;
    }
    const rows = await listManageableTelegramSubscriptions(userId);

    if (parsed.kind === 'page') {
        const page = buildTelegramSubscriptionPage(rows, parsed.page);
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildSubscriptionManagePanel(rows, page.page, await getTelegramUserLocaleOrDefault(userId)),
            buttons: buildSubscriptionActionKeyboard(rows, page.page, await getTelegramUserLocaleOrDefault(userId)),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '订阅列表已刷新' }));
        return;
    }

    if (parsed.kind === 'confirm' || parsed.kind === 'back') {
        const pending = getPendingSubscriptionCancel(update, parsed.token, userId);
        if (!pending) {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '取消确认无效或已过期，请刷新订阅列表', alert: true }));
            return;
        }
        pendingSubscriptionCancels.delete(parsed.token);
        if (parsed.kind === 'confirm') {
            const target = rows.find(row => String(row.id) === pending.subscriptionId);
            const sub = target ? await unsubscribeTelegramChannel(userId, pending.subscriptionId) : null;
            const rowsAfterCancel = await listManageableTelegramSubscriptions(userId);
            const page = buildTelegramSubscriptionPage(rowsAfterCancel, pending.page);
            await client.editMessage(update.peer, {
                message: update.msgId,
                text: [
                    sub ? `✅ 已取消订阅 ${sub.title || sub.source}` : '❌ 订阅不存在或已经取消',
                    '',
                    buildSubscriptionManagePanel(rowsAfterCancel, page.page, locale),
                ].join('\n'),
                buttons: buildSubscriptionActionKeyboard(rowsAfterCancel, page.page, locale),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: sub ? '已取消订阅' : '订阅不存在或已经取消', alert: true }));
            return;
        }
        const page = buildTelegramSubscriptionPage(rows, pending.page);
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildSubscriptionManagePanel(rows, page.page, await getTelegramUserLocaleOrDefault(userId)),
            buttons: buildSubscriptionActionKeyboard(rows, page.page, await getTelegramUserLocaleOrDefault(userId)),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已返回订阅列表' }));
        return;
    }

    if (parsed.kind !== 'action') {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '订阅按钮无效或已过期', alert: true }));
        return;
    }

    const target = rows.find(row => String(row.id) === parsed.id);
    if (!target) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '订阅不存在或已取消', alert: true }));
        return;
    }

    if (parsed.action === 'sync') {
        await requestTelegramSubscriptionSync(userId, parsed.id);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已请求立即同步' }));
        return;
    }
    if (parsed.action === 'pause' || parsed.action === 'resume') {
        await setTelegramSubscriptionEnabled(userId, parsed.id, parsed.action === 'resume');
        const refreshed = await listManageableTelegramSubscriptions(userId);
        await client.editMessage(update.peer, { message: update.msgId, text: buildSubscriptionManagePanel(refreshed, parsed.page, locale), buttons: buildSubscriptionActionKeyboard(refreshed, parsed.page, locale) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: parsed.action === 'resume' ? '已恢复订阅' : '已暂停订阅' }));
        return;
    }
    if (parsed.action === 'from_now') {
        await setTelegramSubscriptionFromNow(userId, parsed.id);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '游标已更新为当前最新消息' }));
        return;
    }
    if (parsed.action === 'target') {
        const current = target.target_mode === 'fixed';
        await updateTelegramSubscriptionTarget(userId, parsed.id, current
            ? { mode: 'follow_global' }
            : { mode: 'fixed', provider: storageManager.getActiveTarget().provider.name, accountId: storageManager.getActiveTarget().accountId });
        const refreshed = await listManageableTelegramSubscriptions(userId);
        await client.editMessage(update.peer, { message: update.msgId, text: buildSubscriptionManagePanel(refreshed, parsed.page, locale), buttons: buildSubscriptionActionKeyboard(refreshed, parsed.page, locale) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: current ? '已改为跟随全局' : '已固定为当前目标' }));
        return;
    }
    if (parsed.action === 'result') {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: target.last_result ? JSON.stringify(target.last_result).slice(0, 180) : '暂无运行结果', alert: true }));
        return;
    }
    if (parsed.action === 'retry') {
        const failed = await query(`SELECT id FROM telegram_background_jobs WHERE kind = 'subscription_sync' AND params->>'subscriptionId' = $1 AND status IN ('failed','completed_with_errors') ORDER BY updated_at DESC LIMIT 1`, [String(target.id)]);
        const retried = failed.rows[0] ? await retryTelegramBackgroundJob(userId, String(failed.rows[0].id), target.chat_id?.toString()) : null;
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: retried ? '已重试最近失败项' : '没有可重试失败项' }));
        return;
    }
    if (parsed.action === 'backfill') {
        const state: TelegramWizardState = { kind: 'tg_date', step: 'start_date', source: target.source };
        const sent = await client.sendMessage(update.peer, { message: buildTelegramWizardPrompt(state, locale) });
        putTelegramWizardState(userId, callbackChatKey(update, userId), state, sent.id);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请输入补抓开始日期' }));
        return;
    }

    if (parsed.action === 'view') {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: target.folder_override ? `专属目录：${target.folder_override}` : '当前使用默认保存路径',
            alert: true,
        }));
        return;
    }

    if (parsed.action === 'folder') {
        const state: TelegramWizardState = {
            kind: 'tg_sub_manage',
            step: 'path',
            source: target.source,
            subscriptionId: target.id,
            subscriptionTitle: target.title,
            subscriptionSource: target.source,
        };
        const sent = await client.sendMessage(update.peer, { message: buildTelegramWizardPrompt(state, locale) });
        putTelegramWizardState(userId, callbackChatKey(update, userId), state, sent.id);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请发送新的专属目录' }));
        return;
    }

    if (parsed.action === 'clear') {
        await updateTelegramSubscriptionFolder(userId, parsed.id, null);
        const rowsAfterClear = await listManageableTelegramSubscriptions(userId);
        const page = buildTelegramSubscriptionPage(rowsAfterClear, parsed.page);
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildSubscriptionManagePanel(rowsAfterClear, page.page, locale),
            buttons: buildSubscriptionActionKeyboard(rowsAfterClear, page.page, locale),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已清除专属目录' }));
        return;
    }

    if (parsed.action === 'cancel') {
        await editSubscriptionCancelConfirmation(update, userId, target, parsed.page);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请确认是否取消订阅' }));
    }
}

export async function initTelegramBot(credentialsOverride?: TelegramBotCredentials): Promise<void> {
    const effective = credentialsOverride ? null : await getEffectiveTelegramBotConfig();
    const credentials = credentialsOverride || effective?.credentials || null;
    const apiId = credentials?.apiId || 0;
    const apiHash = credentials?.apiHash || '';
    const botToken = credentials?.botToken || '';

    if (!credentials || (!credentialsOverride && effective && !effective.enabled)) {
        resetTelegramBotStatus(false);
        console.log('⚠️ Telegram Bot 未配置或已停用');
        return;
    }
    markTelegramBotStarting();

    // Bot session is intentionally not read here. TELEGRAM_SESSION_FILE is a
    // legacy/operational setting; fresh token startup prevents stale DC sessions.
    const configuredStartupTimeoutMs = Number.parseInt(process.env.TELEGRAM_BOT_STARTUP_TIMEOUT_MS || '', 10);
    const startupTimeoutMs = Number.isFinite(configuredStartupTimeoutMs) && configuredStartupTimeoutMs >= 5_000
        ? Math.min(configuredStartupTimeoutMs, 120_000)
        : 30_000;
    console.log(`🤖 Telegram Bot 应用级启动超时: ${startupTimeoutMs}ms`);

    try {
        console.log('🤖 Telegram Bot 正在同步存储配置...');
        await storageManager.init();
        const provider = storageManager.getProvider();
        console.log(`🤖 Telegram Bot 当前存储提供商: ${provider.name}`);
    } catch (e) {
        console.error('🤖 Telegram Bot 同步存储配置失败:', e);
    }

    try {
        client = new TelegramClient(new StringSession(''), apiId, apiHash, {
            connectionRetries: 5,
            reconnectRetries: 5,
            retryDelay: 1000,
            autoReconnect: true,
            useWSS: false,
            deviceModel: 'TG Vault Bot',
            systemVersion: '1.0.0',
            appVersion: '1.0.0',
            floodSleepThreshold: 120,
        });

        console.log('🤖 Telegram Bot 正在启动...');
        await withTelegramOperationDeadline(client.start({ botAuthToken: botToken }), startupTimeoutMs, 'Telegram Bot 启动超时，请稍后重试');
        await withTelegramOperationDeadline(client.getMe(), 10_000, 'Telegram Bot 身份读取超时，请稍后重试');

        console.log('🤖 Telegram Bot 已连接!');

        // Ensure database table exists
        try {
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_auth (
                    user_id BIGINT PRIMARY KEY,
                    authenticated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await loadAuthenticatedUsers();
        } catch (e) {
            console.error('🤖 初始化 Telegram 认证表失败:', e);
        }

        // Keep command registration out of the critical readiness path and do
        // it only when this Bot identity or the menu content changes.
        try {
            const menuLocales: Array<{ locale: TelegramLocale; langCode: string }> = [
                { locale: DEFAULT_LOCALE, langCode: '' },
                { locale: 'zh-CN', langCode: 'zh' },
                { locale: 'en', langCode: 'en' },
                { locale: 'ru', langCode: 'ru' },
            ];
            const commandMenuFingerprint = crypto.createHash('sha256').update(JSON.stringify({
                tokenOwner: botToken.split(':', 1)[0],
                menus: menuLocales.map(({ locale, langCode }) => ({ langCode, commands: buildBotCommandMenu(locale) })),
            })).digest('hex');
            const savedFingerprint = await getSetting<string>(TELEGRAM_BOT_COMMAND_MENU_FINGERPRINT_SETTING, '');
            if (savedFingerprint !== commandMenuFingerprint) {
                for (const { locale, langCode } of menuLocales) {
                    const commands = buildBotCommandMenu(locale).map(command => new Api.BotCommand(command));
                    await withTelegramClientDeadline(client.invoke(new Api.bots.SetBotCommands({
                        scope: new Api.BotCommandScopeDefault(), langCode, commands,
                    })), 10_000, 'Telegram Bot 命令菜单注册超时，请稍后重试');
                }
                await setSetting(TELEGRAM_BOT_COMMAND_MENU_FINGERPRINT_SETTING, commandMenuFingerprint);
                console.log('🤖 Bot 命令菜单已更新');
            } else {
                console.log('🤖 Bot 命令菜单未变化，跳过重复注册');
            }
        } catch (error) {
            console.warn('🤖 Bot 命令菜单同步失败，Bot 继续运行:', error);
        }

        try {
            const fileConcurrency = await loadFileDownloadConcurrencySetting();
            console.log(`🤖 Telegram 文件级并发: ${fileConcurrency}`);
        } catch (e) {
            console.warn('🤖 读取文件级并发设置失败，使用环境变量默认值:', e);
        }

        // 后台任务由应用级编排显式启动；Bot 凭证绑定只安装交互处理器，
        // 避免仅保存凭证就触发订阅扫描、任务恢复或主动消息。

        // Handle Messages
        client.addEventHandler(async (event: NewMessageEvent) => {
            if (!client) return;

            try {
                const message = event.message;
                if (message.out) return; // 忽略 Bot 自己发送的消息，防止递归响应

                if (!message.text && !message.media) return;

                const senderId = message.senderId?.toJSNumber();
                if (!senderId) return;

                // 忽略过旧的消息，防止 Bot 重启时重复处理 pending updates
                const messageAge = Date.now() / 1000 - message.date;
                if (messageAge > 300) { // 超过 5 分钟的消息直接跳过
                    console.log(`🤖 跳过过旧消息 (${Math.round(messageAge)}s ago, id=${message.id})`);
                    return;
                }

                let text = message.text || '';
                text = normalizeBotCommandText(text);
                const chatId = message.chatId;

                if (!chatId) return;

                const rateLimit = consumeTelegramRateLimit(senderId, text);
                if (rateLimit.limited) {
                    await message.reply({ message: `⏳ 操作过于频繁，请 ${rateLimit.retryAfterSeconds} 秒后再试。` });
                    return;
                }

                const commandName = text.trim().split(/\s+/, 1)[0].replace(/@\w+$/, '') || 'text';
                console.log(`🤖 Received Telegram message from ${senderId}: command=${commandName} messageId=${message.id}`);

                // Commands
                if (text === '/start') {
                    const savedLocale = await getTelegramUserLocale(senderId);
                    if (!savedLocale) {
                        await message.reply({ message: t(DEFAULT_LOCALE, 'language.choose'), buttons: languageKeyboard(DEFAULT_LOCALE) });
                        return;
                    }
                    await handleStart(message, senderId, buildBotStartKeyboard(savedLocale), savedLocale);
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({
                            message: buildStartPrompt(savedLocale),
                            buttons: generatePasswordKeyboard(0, savedLocale),
                        });
                    }
                    return;
                }
                if (text === '/language' || text === '/lang') {
                    const locale = await getTelegramUserLocaleOrDefault(senderId);
                    await message.reply({ message: languagePanel(locale), buttons: languageKeyboard() });
                    return;
                }
                // 处理 /setup-2fa 命令
                if (text === '/setup_2fa' || text === '/setup-2fa') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    let tempPath: string | null = null;
                    try {
                        if (await is2FAEnabled()) {
                            await message.reply({ message: '🔐 双重验证已启用。为保护现有密钥，Bot 不会再次显示二维码。' });
                            return;
                        }
                        const qrDataUrl = await generateOTPAuthUrl();
                        const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
                        const buffer = Buffer.from(base64Data, 'base64');
                        tempPath = path.join(process.cwd(), `temp_qr_${senderId}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.png`);
                        fs.writeFileSync(tempPath, buffer, { mode: 0o600 });

                        const qrMessage = await client.sendFile(chatId, {
                            file: tempPath,
                            caption: build2FASetupCaption()
                        });

                        userStates.set(senderId, {
                            state: TelegramUserState.WAITING_2FA_SETUP,
                            qrMessageId: qrMessage.id
                        });
                    } catch (e) {
                        console.error('生成 2FA 二维码失败:', e);
                        await client.sendMessage(chatId, { message: MSG.AUTH_2FA_QR_FAIL });
                    } finally {
                        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    }
                    return;
                }

                if (text === '/help') {
                    await handleHelp(message, homePageKeyboard(0, await getTelegramUserLocaleOrDefault(senderId)), await getTelegramUserLocaleOrDefault(senderId));
                    return;
                }

                if (text === '/logout') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    try {
                        await revokeAuthenticatedUser(senderId);
                        passwordInputState.delete(senderId);
                        userStates.delete(senderId);
                        telegramWizardStates.delete(senderId, messageChatKey(message, senderId));
                        await message.reply({ message: '✅ 当前 Telegram 用户的 Bot 认证已撤销。发送 /start 可重新认证。' });
                    } catch (error) {
                        const operationId = crypto.randomUUID().slice(0, 8);
                        console.error(`🤖 撤销 Telegram 认证失败 operationId=${operationId}:`, error);
                        await message.reply({ message: `❌ 退出失败，请稍后重试。\n操作 ID：${operationId}` });
                    }
                    return;
                }


                if (text === '/tg_sub' || text === '/tg_subscribe') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_sub_manage');
                    return;
                }

                if (text === '/tg_download' || text === '/tg_dl') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_download');
                    return;
                }

                // 兼容旧命令，但不再展示在 Telegram 菜单中
                if (text === '/tg_date') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_date');
                    return;
                }

                if (text === '/tg_tag') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_tag');
                    return;
                }

                if (!text.startsWith('/')) {

                    try {
                        if (await applyPendingTelegramFileMutation(message, senderId, text)) return;
                    } catch (error) {
                        await message.reply({ message: `❌ 文件操作失败：${(error as Error).message}\n请重新输入或发送“取消”。` });
                        return;
                    }
                    if (isCancelInput(text)) {
                        const pendingMode = getPendingTelegramPathInput(chatId.toString(), senderId);
                        if (pendingMode) {
                            clearPendingTelegramPathInput(chatId.toString(), senderId);
                            const locale = await getTelegramUserLocaleOrDefault(senderId);
                            await message.reply({ message: t(locale, 'path.toast.cancelled') });
                            return;
                        }
                    } else {
                        try {
                            const appliedPath = await applyPendingTelegramPathInputPersistent(chatId.toString(), senderId, text);
                            if (appliedPath) {
                                await message.reply({
                                    message: appliedPath.mode === 'once'
                                        ? `📌 已设置下一次下载目录：\`${appliedPath.folder}\`\n${buildPathPreviewLine(appliedPath.folder)}\n\n此设置会在下一次成功进入下载流程时自动失效。`
                                        : `📍 已设置本会话下载目录：\`${appliedPath.folder}\`\n${buildPathPreviewLine(appliedPath.folder)}\n\n后续此聊天中的下载会优先保存到该目录，发送 /pc 可清除。`,
                                });
                                return;
                            }
                        } catch (error) {
                            await message.reply({ message: `❌ 路径无效：${(error as Error).message}\n\n请重新发送目录，或发送“取消”退出本次设置。` });
                            return;
                        }
                    }

                    const handledTelegramWizard = await handleTelegramWizardMessage(message, senderId, text);
                    if (handledTelegramWizard) return;
                }

                if (text === '/tg_subs' || text === '/tg_subscriptions') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const rows = await listManageableTelegramSubscriptions(senderId);
                    await message.reply({
                        message: buildSubscriptionManagePanel(rows, 0, await getTelegramUserLocaleOrDefault(senderId)),
                        buttons: buildSubscriptionActionKeyboard(rows, 0, await getTelegramUserLocaleOrDefault(senderId)),
                    });
                    return;
                }

                if (text.startsWith('/tg_sub ') || text.startsWith('/tg_subscribe ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const source = text.split(/\s+/).slice(1).join(' ').trim();
                    if (!source) {
                        await startTelegramWizard(message, senderId, 'tg_sub_manage');
                        return;
                    }
                    try {
                        const sub = await subscribeTelegramChannel(senderId, chatId.toString(), source, null);
                        await message.reply({ message: `✅ 已订阅 ${sub.title || sub.source}\n📍 ${sub.source}\n从当前最新消息 ID ${sub.last_message_id || 0} 之后开始自动同步。` });
                    } catch (error) {
                        await message.reply({ message: `❌ 订阅失败: ${error instanceof Error ? error.message : String(error)}` });
                    }
                    return;
                }

                if (text.startsWith('/tg_unsub ') || text.startsWith('/tg_unsubscribe ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const selector = text.split(/\s+/).slice(1).join(' ').trim();
                    if (!selector) {
                        await message.reply({ message: '请从频道订阅面板选择要取消的订阅。' });
                        return;
                    }
                    const target = await findTelegramSubscription(senderId, selector);
                    if (!target || !isTelegramSubscriptionVisibleInManagement(target)) {
                        await message.reply({ message: '❌ 未找到该订阅' });
                        return;
                    }
                    await sendSubscriptionCancelConfirmation(message, senderId, target, 0);
                    return;
                }

                if (text.startsWith('/tg_download ') || text.startsWith('/tg_dl ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const parts = text.split(/\s+/).slice(1);
                    const mode = (parts.shift() || '').toLowerCase();
                    const locale = await getTelegramUserLocaleOrDefault(senderId);
                    if (mode === 'date' || mode === '日期') {
                        if (parts.length !== 3) {
                            await startTelegramWizard(message, senderId, 'tg_download');
                            return;
                        }
                        try {
                            const queuedMsg = await message.reply({ message: t(locale, 'bot.legacy.confirmDate', { source: parts[0], startDate: parts[1], endDate: parts[2] }) });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramDateDownload(client, message, senderId, parts[0], parts[1], parts[2]), 'date', locale);
                        } catch (error) {
                            await message.reply({ message: t(locale, 'bot.legacy.failed', { mode: t(locale, 'bot.wizard.modeDate'), error: error instanceof Error ? error.message : String(error) }) });
                        }
                        return;
                    }
                    if (mode === 'tag' || mode === '标签') {
                        if (parts.length !== 2) {
                            await startTelegramWizard(message, senderId, 'tg_download');
                            return;
                        }
                        try {
                            const queuedMsg = await message.reply({ message: t(locale, 'bot.legacy.confirmTag', { source: parts[0], tag: parts[1].startsWith('#') ? parts[1] : `#${parts[1]}` }) });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramTagDownload(client, message, senderId, parts[0], parts[1]), 'tag', locale);
                        } catch (error) {
                            await message.reply({ message: t(locale, 'bot.legacy.failed', { mode: t(locale, 'bot.wizard.modeTag'), error: error instanceof Error ? error.message : String(error) }) });
                        }
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_download');
                    return;
                }

                if (text.startsWith('/tg_date ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const parts = text.split(/\s+/).slice(1);
                    const locale = await getTelegramUserLocaleOrDefault(senderId);
                    if (parts.length !== 3) {
                        await message.reply({ message: t(locale, 'bot.legacy.usageDate') });
                        return;
                    }
                    try {
                        const queuedMsg = await message.reply({ message: t(locale, 'bot.legacy.confirmDate', { source: parts[0], startDate: parts[1], endDate: parts[2] }) });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramDateDownload(client, message, senderId, parts[0], parts[1], parts[2]), 'date', locale);
                    } catch (error) {
                        await message.reply({ message: t(locale, 'bot.legacy.failed', { mode: t(locale, 'bot.wizard.modeDate'), error: error instanceof Error ? error.message : String(error) }) });
                    }
                    return;
                }

                if (text.startsWith('/tg_tag ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const parts = text.split(/\s+/).slice(1);
                    const locale = await getTelegramUserLocaleOrDefault(senderId);
                    if (parts.length !== 2) {
                        await message.reply({ message: t(locale, 'bot.legacy.usageTag') });
                        return;
                    }
                    try {
                        const queuedMsg = await message.reply({ message: t(locale, 'bot.legacy.confirmTag', { source: parts[0], tag: parts[1].startsWith('#') ? parts[1] : `#${parts[1]}` }) });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramTagDownload(client, message, senderId, parts[0], parts[1]), 'tag', locale);
                    } catch (error) {
                        await message.reply({ message: t(locale, 'bot.legacy.failed', { mode: t(locale, 'bot.wizard.modeTag'), error: error instanceof Error ? error.message : String(error) }) });
                    }
                    return;
                }

                if (text === '/storage') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleStorage(message, await getTelegramUserLocaleOrDefault(senderId));
                    return;
                }

                if (text === '/storage_switch' || text === '/switch_storage' || text === '/storage_source') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleStorageSwitch(message);
                    return;
                }

                if (text === '/target' || text.startsWith('/target ')) {
                    await handleTarget(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/find' || text.startsWith('/find ')) {
                    await handleFind(message, text.split(/\s+/).slice(1), await getTelegramUserLocaleOrDefault(senderId));
                    return;
                }

                if (text === '/list' || text.startsWith('/list ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleList(message, text.split(/\s+/).slice(1), await getTelegramUserLocaleOrDefault(senderId));
                    return;
                }

                if (text.startsWith('/delete ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const args = text.split(' ').slice(1);
                    await handleDelete(message, args);
                    return;
                }

                if (text === '/notifications' || text.startsWith('/notifications ')) {
                    try {
                        await handleNotifications(message, text.split(/\s+/).slice(1), await getTelegramUserLocaleOrDefault(senderId));
                    } catch (error) {
                        await message.reply({ message: `❌ 通知设置失败：${(error as Error).message}` });
                    }
                    return;
                }

                if (text === '/status') {
                    await handleStatus(message, await getTelegramUserLocaleOrDefault(senderId));
                    return;
                }

                if (text === '/tasks' || text === '/task') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleTasks(message, await getTelegramUserLocaleOrDefault(senderId));
                    return;
                }

                if (text === '/task_pause' || text.startsWith('/task_pause ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePauseTasks(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/task_resume' || text.startsWith('/task_resume ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleResumeTasks(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/task_cancel' || text.startsWith('/task_cancel ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleCancelTask(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/tg_retry' || text.startsWith('/tg_retry ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleRetryFailedTasks(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/stop_tasks' || text === '/stop' || text === '/cancel_tasks') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleStopTasks(message);
                    return;
                }

                if (text === '/download_workers' || text === '/workers') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleDownloadWorkers(message);
                    return;
                }

                if (text === '/file_concurrency' || text === '/file_workers' || text === '/download_files') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleFileConcurrency(message);
                    return;
                }

                if (text === '/path_rules' || text === '/path' || text === '/save_rules') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePathRules(message, await getTelegramUserLocaleOrDefault(senderId));
                    return;
                }

                if (text === '/pc') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePathClear(message);
                    return;
                }

                if (text.startsWith('/p ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePathOnce(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text.startsWith('/ps ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePathSession(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/duplicate_mode' || text === '/duplicate' || text === '/dup') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleDuplicateMode(message);
                    return;
                }

                if (text === '/cleanup_settings' || text === '/cleanup') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleCleanupSettings(message);
                    return;
                }

                // Handle 2FA Verification (Setup or Login)
                const userState = userStates.get(senderId);
                if (userState && (userState.state === TelegramUserState.WAITING_2FA_SETUP || userState.state === TelegramUserState.WAITING_2FA_LOGIN)) {
                    // Try to extract 6 digit code from text (allow spaces or dashes)
                    const cleanText = text.replace(/[\s-]/g, '');
                    if (/^\d{6}$/.test(cleanText)) {
                        const verified = await verifyTOTP(cleanText);

                        if (verified) {
                            if (userState.state === TelegramUserState.WAITING_2FA_SETUP) {
                                if (!(await isAuthenticatedAsync(senderId))) {
                                    userStates.delete(senderId);
                                    await message.reply({ message: MSG.AUTH_REQUIRED });
                                    return;
                                }
                                await activate2FA();
                                await message.reply({ message: MSG.AUTH_2FA_ACTIVATED });
                            } else {
                                await persistAuthenticatedUser(senderId);
                                await message.reply({ message: MSG.AUTH_2FA_LOGIN_OK });
                            }

                            // Clean up sensitive messages
                            try {
                                const messagesToDelete = [message.id]; // User's code message
                                if (userState.qrMessageId) messagesToDelete.push(userState.qrMessageId);
                                if (userState.promptMessageId) messagesToDelete.push(userState.promptMessageId);

                                await client.deleteMessages(chatId, messagesToDelete, { revoke: true });
                            } catch (e) {
                                console.error('🤖 删除 2FA 相关消息失败:', e);
                            }

                            userStates.delete(senderId);
                            return;
                        } else {
                            const errorMsg = await message.reply({ message: MSG.AUTH_2FA_WRONG });

                            // Delete invalid code message and error message potentially? 
                            // Let's at least delete user message
                            try {
                                await client.deleteMessages(chatId, [message.id], { revoke: true });
                            } catch (e) { }
                            return;
                        }
                    }
                }

                // File Handling
                if (message.media) {
                    // 处理文件上传
                    await handleFileUpload(client, event);
                }
                // Unauthenticated User Text
                if (!(await isAuthenticatedAsync(senderId)) && text && !text.startsWith('/')) {
                    await message.reply({ message: MSG.UNKNOWN_TEXT });
                }
            } catch (error) {
                console.error('🤖 处理消息时发生意外错误:', error);
            }
        }, new NewMessage({ incoming: true }));

        // Handle Callbacks
        client.addEventHandler(async (update: Api.TypeUpdate) => {
            if (update.className === 'UpdateBotCallbackQuery') {
                if (!client) return;
                const activeClient = client;
                const callbackUpdate = update as Api.UpdateBotCallbackQuery;
                const data = Buffer.from(callbackUpdate.data || []).toString('utf-8');

                if (data.startsWith('lang_')) {
                    await handleLanguageSelection(callbackUpdate, data);
                    return;
                }

                if (data.startsWith('home_')) {
                    await handleBotHomeCallback(callbackUpdate, data);
                    return;
                }

                // 处理密码回调
                if (data.startsWith('pwd_')) {
                    await handlePasswordCallback(callbackUpdate);
                    return;
                }


                // 处理垃圾缓存清理回调
                if (data.startsWith('cleanup_')) {
                    await handleCleanupButtonCallback(callbackUpdate, data);
                    return;
                }

                // 处理并发下载 worker 设置回调
                if (data.startsWith('dw_')) {
                    await handleDownloadWorkersCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理文件级并发设置回调
                if (data.startsWith('fc_')) {
                    await handleFileConcurrencyCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理存储统计/本地文件清理/存储源切换回调
                if (data.startsWith('storage_switch_')) {
                    await handleStorageSwitchCallback(activeClient, callbackUpdate, data);
                    return;
                }

                if (data.startsWith('storage_')) {
                    await handleStorageCleanupCallback(activeClient, callbackUpdate, data);
                    return;
                }
                // 处理文件详情和操作卡回调
                if (data.startsWith('fb_')) {
                    await handleTelegramFileBrowserCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理文件删除二次确认回调
                if (data.startsWith('del_')) {
                    await handleDeleteConfirmCallback(activeClient, callbackUpdate, data);
                    return;
                }


                // 处理当前聊天存储目标快捷按钮
                if (data.startsWith('target_')) {
                    await handleTargetCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理通知偏好快捷按钮
                if (data.startsWith('nt_')) {
                    await handleNotificationsCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理保存路径规则回调
                if (data.startsWith('pr_')) {
                    await handlePathRulesCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理重复文件策略回调
                if (data.startsWith('dm_')) {
                    await handleDuplicateModeCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理频道下载模式选择回调
                if (data.startsWith('tgd_')) {
                    await handleTelegramDownloadModeCallback(callbackUpdate, data);
                    return;
                }

                // 处理频道订阅管理回调
                if (data.startsWith('tsub_')) {
                    await handleTelegramSubscriptionCallback(callbackUpdate, data);
                    return;
                }

                // 处理新版 /tasks 任务中心导航与控制
                if (data.startsWith('tc_')) {
                    await handleTaskCenterCallback(activeClient, callbackUpdate, data);
                    return;
                }

                if (data.startsWith('bulk_task_')) {
                    await handleBulkTaskCancelCallback(activeClient, callbackUpdate, data);
                    return;
                }

                // 处理旧版 /tasks 频道任务队列按钮（兼容历史消息）
                if (data.startsWith('ctq_')) {
                    await handleChannelTaskQueueCallback(activeClient, callbackUpdate, data);
                    return;
                }

                if (data.startsWith('receipt_')) {
                    await handleUploadReceiptCallback(callbackUpdate, data);
                    return;
                }

                // 处理任务队列控制回调
                if (data.startsWith('tq_')) {
                    await handleTaskQueueCallback(callbackUpdate, data);
                    return;
                }

                // 处理自动清理设置回调
                if (data.startsWith('cs_')) {
                    await handleCleanupSettingsCallback(activeClient, callbackUpdate, data);
                    return;
                }
            }
        }, new Raw({}));

        const me: any = await withTelegramClientDeadline(
            client.getMe(),
            10_000,
            'Telegram Bot 身份读取超时，请稍后重试',
        );
        setTelegramBotIdentity({
            username: me?.username ? String(me.username) : null,
            displayName: [me?.firstName, me?.lastName].filter(Boolean).join(' ') || null,
        });
        markTelegramBotReady();

        digestTimer = setInterval(() => {
            if (!client) return;
            void listTelegramNotificationDigestScopes().then(scopes => Promise.all(scopes.map(scope =>
                flushTelegramNotificationDigest(scope.userId, scope.chatId, {
                    send: async (chatId, message) => { await client!.sendMessage(chatId, { message }); },
                }).catch(() => 0),
            ))).catch(() => undefined);
        }, 60_000);
        digestTimer.unref?.();
        console.log('🤖 Telegram Bot 启动成功! (最大 2GB，账号级下载器不受此限制)');

    } catch (error) {
        if (digestTimer) clearInterval(digestTimer);
        digestTimer = null;

        const failedClient = client;
        client = null;
        if (failedClient) {
            await failedClient.disconnect().catch(() => undefined);
            await failedClient.destroy().catch(() => undefined);
        }
        const status = classifyTelegramBotStartupError(error);
        const message = error instanceof Error ? error.message : String(error);
        markTelegramBotError(
            status,
            message,
            status === 'auth_failed' ? 'Telegram Bot Token 已失效，请在网页端更换凭证' : '检查网络与后端日志后重试',
        );
        console.error('🤖 Telegram Bot 启动失败:', error);
        throw error;
    }
}

async function withTelegramClientDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return withTelegramOperationDeadline(operation, timeoutMs, message);
}

async function stopTelegramBotInternal(): Promise<void> {
    cancelTelegramBotPostStartup();
    const activeClient = client;
    if (digestTimer) clearInterval(digestTimer);
    digestTimer = null;

    await stopTelegramBackgroundWorkers();
    client = null;
    if (activeClient) {
        await activeClient.disconnect().catch(() => undefined);
        await activeClient.destroy().catch(() => undefined);
    }
    resetTelegramBotStatus(false);
}

export interface TelegramBotLifecycleControls {
    stop(): Promise<void>;
    restart(credentialsOverride?: TelegramBotCredentials): Promise<void>;
}

export function withTelegramBotLifecycle<T>(operation: (controls: TelegramBotLifecycleControls) => Promise<T>): Promise<T> {
    const controls: TelegramBotLifecycleControls = {
        stop: () => stopTelegramBotInternal(),
        restart: async (credentialsOverride?: TelegramBotCredentials) => {
            // Explicit Web/API replacement restarts only the Bot. Existing user
            // downloader sessions are left untouched. Background workers resume
            // only after the same isolation window, without reconnecting users.
            await stopTelegramBotInternal();
            await initTelegramBot(credentialsOverride);
            scheduleTelegramBotPostStartup(async () => undefined);
        },
    };
    const result = botLifecycle.catch(() => undefined).then(() => operation(controls));
    botLifecycle = result.then(() => undefined, () => undefined);
    return result;
}

export async function stopTelegramBot(): Promise<void> {
    return withTelegramBotLifecycle(controls => controls.stop());
}

export async function restartTelegramBot(credentialsOverride?: TelegramBotCredentials): Promise<void> {
    return withTelegramBotLifecycle(controls => controls.restart(credentialsOverride));
}

export async function sendUpdateNotificationToUser(userId: number, message: string): Promise<void> {
    if (!client || !client.connected || getTelegramBotStatus().status !== 'ready') {
        throw new Error('Telegram Bot 当前离线');
    }
    const locale = await getTelegramUserLocaleOrDefault(userId);
    await client.sendMessage(userId, { message: t(locale, 'bot.notification.passthrough', { message }) });
}

// 发送安全通知给所有已认证用户
export async function sendSecurityNotification(message: string): Promise<void> {
    if (!client || !client.connected) {
        console.warn('⚠️ Telegram Client 未连接，无法发送安全通知');
        return;
    }

    const allowedUsers = await getConfiguredTelegramAllowedUsers();
    if (allowedUsers.length === 0) return;
    const { recipients } = await reconcileTelegramAllowedUsers(allowedUsers);
    for (const userId of recipients) {
        try {
            const locale = await getTelegramUserLocaleOrDefault(userId);
            await client.sendMessage(userId, { message: t(locale, 'bot.notification.securityLogin', { message }) });
        } catch (e) {
            console.error(`🤖 向用户 ${userId} 发送通知失败:`, e);
        }
    }
}

export default { initTelegramBot, restartTelegramBot, stopTelegramBot, sendSecurityNotification, sendUpdateNotificationToUser };
