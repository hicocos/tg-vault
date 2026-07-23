import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { Raw } from 'telegram/events/index.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { storageManager } from '../services/storage.js';
import { authenticatedUsers, passwordInputState, isAuthenticatedAsync, loadAuthenticatedUsers, persistAuthenticatedUser, userStates, TelegramUserState } from './telegramState.js';
import { is2FAEnabled, generateOTPAuthUrl, verifyTOTP, activate2FA } from '../utils/security.js';
import { handleStart, handleHelp, handleStorage, handleStorageSwitch, handleStorageSwitchCallback, handleList, handleDelete, handleDeleteConfirmCallback, handleTasks, handleTaskCenterCallback, handleBulkTaskCancelCallback, handleStopTasks, handlePauseTasks, handleResumeTasks, handleCancelTask, handleChannelTaskQueueCallback, handleRetryFailedTasks, handleDownloadWorkers, handleDownloadWorkersCallback, handleFileConcurrency, handleFileConcurrencyCallback, handleStorageCleanupCallback, handlePathRules, handlePathOnce, handlePathSession, handlePathClear, handlePathRulesCallback, handleDuplicateMode, handleDuplicateModeCallback, handleCleanupSettings, handleCleanupSettingsCallback } from './telegramCommands.js';
import { handleFileUpload, handleCleanupCallback, pauseDownloadTasks, resumeDownloadTasks, resolveTaskChatIdForControl, refreshSilentProgress, cancelSilentTask, canControlTask, loadFileDownloadConcurrencySetting } from './telegramUpload.js';
import { handleYtDlpCommand, setYtDlpNotifier } from './ytDlpDownload.js';
import {
    enqueueTelegramDateDownload,
    enqueueTelegramTagDownload,
    findTelegramSubscription,
    listTelegramSubscriptions,
    type TelegramJobProgressSummary,
    startTelegramJobRecoveryWorker,
    startTelegramSubscriptionWorker,
    subscribeTelegramChannel,
    unsubscribeTelegramChannel,
    updateTelegramSubscriptionFolder,
    TELEGRAM_COMMENTS_MAX_PER_POST,
} from './telegramChannelJobs.js';
import { cleanupOrphanFiles, isAutoCleanupEnabled, startPeriodicCleanup } from './orphanCleanup.js';
import { MSG, buildStartPrompt, buildAuthSuccess, build2FASetupCaption, buildCleanupNotice } from '../utils/telegramMessages.js';
import { query } from '../db/index.js';
import { getConfiguredTelegramAllowedUsers, addTelegramAllowedUser, countAuthenticatedTelegramUsers, shouldAutoAllowFirstTelegramUser, verifyTelegramPin } from '../utils/authSettings.js';
import { assertPublicHttpUrl } from '../utils/networkSecurity.js';
import { BOT_COMMANDS, buildBotCommandMenu, normalizeBotCommandText } from '../utils/telegramCommandRegistry.js';
import { rememberRecentTelegramPathPersistent, buildPathPreviewLine, applyPendingTelegramPathInputPersistent, getPendingTelegramPathInput, clearPendingTelegramPathInput } from '../utils/telegramPathSettings.js';
import { isTelegramSubscriptionVisibleInManagement } from './telegramSubscriptionVisibility.js';
import { buildTelegramSubscriptionPage, parseTelegramSubscriptionCallback } from './telegramSubscriptionManagement.js';

function buildBotStartKeyboard(): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({ buttons: [
                new Api.KeyboardButtonCallback({ text: '📤 上传说明', data: Buffer.from('home_upload') }),
                new Api.KeyboardButtonCallback({ text: '🔧 任务', data: Buffer.from('home_tasks') }),
            ] }),
            new Api.KeyboardButtonRow({ buttons: [
                new Api.KeyboardButtonCallback({ text: '📊 存储', data: Buffer.from('home_storage') }),
                new Api.KeyboardButtonCallback({ text: '☰ 更多', data: Buffer.from('home_more') }),
            ] }),
        ],
    });
}

function buildBotMoreKeyboard(): Api.ReplyInlineMarkup {
    const visible = BOT_COMMANDS.filter(command => command.help && !['start', 'tasks', 'storage', 'help'].includes(command.command));
    return new Api.ReplyInlineMarkup({
        rows: visible.slice(0, 12).map(command => new Api.KeyboardButtonRow({
            buttons: [new Api.KeyboardButtonCallback({ text: `/${command.command} · ${command.description}`, data: Buffer.from(`home_cmd_${command.command}`) })],
        })),
    });
}

async function handleBotHomeCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) return;
    if (data === 'home_tasks') return handleTasks(await client!.getMessages(update.peer, { ids: Number(update.msgId) }).then(messages => messages[0] as Api.Message));
    if (data === 'home_storage') return handleStorage(await client!.getMessages(update.peer, { ids: Number(update.msgId) }).then(messages => messages[0] as Api.Message));
    const text = data === 'home_upload'
        ? '📤 直接发送或转发任意文件即可上传。\n\n使用 /path_rules 选择保存位置，使用 /tasks 查看进度。'
        : data === 'home_more'
            ? '☰ **更多能力**\n\n请选择下方命令，或发送 /help 查看完整说明。'
            : `请发送 /${data.replace(/^home_cmd_/, '')} 使用此能力。`;
    await client!.editMessage(update.peer, { message: Number(update.msgId), text, buttons: data === 'home_more' ? buildBotMoreKeyboard() : buildBotStartKeyboard() });
}

// Session File Path
const SESSION_FILE = process.env.TELEGRAM_SESSION_FILE || './data/telegram_session.txt';

// GramJS Client
let client: TelegramClient | null = null;

type TelegramWizardKind = 'tg_sub_manage' | 'tg_download' | 'tg_date' | 'tg_tag';
type TelegramWizardStep = 'mode' | 'source' | 'path' | 'comments' | 'start_date' | 'end_date' | 'tag' | 'confirm';

interface TelegramWizardState {
    kind: TelegramWizardKind;
    step: TelegramWizardStep;
    source?: string;
    startDate?: string;
    tag?: string;
    endDate?: string;
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

function buildTelegramDownloadModeKeyboard(): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '🗓️ 按日期下载', data: Buffer.from('tgd_mode_date') }),
                    new Api.KeyboardButtonCallback({ text: '🏷️ 按标签下载', data: Buffer.from('tgd_mode_tag') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('tgd_cancel') })],
            }),
        ],
    });
}

function buildTelegramCommentsKeyboard(): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '仅频道正文', data: Buffer.from('tgd_comments_off') }),
                    new Api.KeyboardButtonCallback({ text: '频道 + 评论区', data: Buffer.from('tgd_comments_on') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('tgd_cancel') })],
            }),
        ],
    });
}

const telegramWizardStates = new Map<number, TelegramWizardState>();
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
const TELEGRAM_HEAVY_COMMANDS = new Set(['/ytdlp', '/tg_download', '/tg_date', '/tg_tag', '/cleanup_settings']);

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

function buildTelegramWizardPrompt(state: TelegramWizardState): string {
    const title = state.kind === 'tg_sub_manage'
        ? '📡 **订阅频道管理**'
        : state.kind === 'tg_tag'
            ? '🏷️ **按标签下载频道文件**'
            : state.kind === 'tg_date'
                ? '🗓️ **按日期下载频道文件**'
                : '📦 **频道文件下载**';

    if (state.step === 'mode') {
        return [
            title,
            '',
            '请选择下载方式：',
            '`日期` — 下载某个日期范围内的频道媒体',
            '`标签` — 下载带指定 #标签 的频道媒体',
            '',
            '也可以直接发送：`date` / `tag`。',
            '发送“取消”可退出。',
        ].join('\n');
    }

    if (state.step === 'source') {
        return [
            title,
            '',
            '请发送频道用户名或链接：',
            '例如：`@channel_username` 或 `https://t.me/channel_username`',
            '',
            '也可以直接发送：`@频道 comments` 或 `@频道 no-comments`。',
            '',
            '发送“取消”可退出。',
        ].join('\n');
    }

    if (state.step === 'path') {
        const scopeText = state.kind === 'tg_sub_manage' ? (state.subscriptionId ? '这个订阅' : '本次订阅') : '本次下载任务';
        return [
            title,
            `📍 频道：${state.subscriptionSource || state.source}`,
            '',
            `是否要给${scopeText}单独指定保存目录？`,
            '',
            '直接发送目录，例如：`频道备份/壁纸`',
            '发送 `跳过` / `skip` 使用默认保存路径规则。',
            '',
            `说明：这里设置的目录只对${scopeText}生效，不会改变全局 /path_rules，也不会影响其它下载。`,
            '发送“取消”可退出。',
        ].join('\n');
    }

    if (state.step === 'comments') {
        return [
            title,
            `📍 频道：${state.subscriptionSource || state.source}`,
            state.customFolder ? `📁 保存目录：${state.customFolder}` : '📁 保存策略：默认自动分类',
            '',
            '是否同时扫描频道帖子下方的评论区文件？',
            '',
            `默认关闭；开启后每个频道帖子最多扫描 ${state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST} 条评论。`,
            '文字评论、普通链接和其它无文件消息会自动忽略。',
            '',
            '也可以发送：`开` / `关` / `yes` / `no`。',
            '发送“取消”可退出。',
        ].join('\n');
    }

    if (state.step === 'confirm') {
        const range = state.kind === 'tg_tag' ? `标签：#${state.tag}` : `日期：${state.startDate} → ${state.endDate}`;
        return [title, '', '请确认任务范围：', `📍 频道：${state.source}`, `🔎 ${range}`,
            `💬 评论区：${state.includeComments ? `包含（每帖最多 ${state.commentsMaxPerPost} 条）` : '不包含'}`,
            `📁 目录：${state.customFolder || '默认自动分类'}`,
            `☁️ 固定存储：${state.targetProvider || '当前存储'} / ${state.targetAccountName || state.targetAccountId || '当前账户'}`,
            '', '估计量将在扫描中实时更新；超过服务端扫描上限时会分段继续，任务可在 /tasks 取消。',
            '发送 `确认` 开始，或发送 `取消` 放弃。'].join('\n');
    }

    if (state.step === 'tag') {
        return [
            title,
            `📍 频道：${state.subscriptionSource || state.source}`,
            '',
            '请发送要下载的标签：',
            '例如：`#壁纸` 或 `壁纸`',
            '',
            '发送“取消”可退出。',
        ].join('\n');
    }

    if (state.step === 'start_date') {
        return [
            title,
            `📍 频道：${state.subscriptionSource || state.source}`,
            '',
            '请发送开始日期：',
            '格式：`YYYY-MM-DD`，例如 `2026-06-01`',
            '',
            '发送“取消”可退出。',
        ].join('\n');
    }

    return [
        title,
        `📍 频道：${state.source}`,
        `🗓️ 开始日期：${state.startDate}`,
        '',
        '请发送结束日期：',
        '格式：`YYYY-MM-DD`，例如 `2026-06-27`',
        '',
        '发送“取消”可退出。',
    ].join('\n');
}

function isDateOnly(text: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(text.trim());
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

export function buildLegacyJobProgressPresentation(summary: TelegramJobProgressSummary): string {
    const totalDone = summary.completed + summary.failed + summary.skipped;
    const cooldownIsFloodWait = summary.status === 'cooling' && /floodwait/i.test((summary as TelegramJobProgressSummary & { error?: string }).error || '');
    const title = summary.status === 'paused'
        ? '⏸️ **频道下载已暂停**'
        : summary.status === 'cooling'
            ? (cooldownIsFloodWait ? '⏳ **Telegram FloodWait 冷却中**' : '⏸️ **存储服务保护冷却中**')
            : summary.status === 'cancelled'
                ? '🛑 **频道下载已取消**'
                : totalDone >= summary.totalMediaFound && summary.scanStatus === 'done'
                    ? '✅ **频道任务完成**'
                    : '🔎 **频道任务运行中**';
    const controls = summary.status === 'paused'
        ? `控制：/task_resume ${summary.jobId.slice(0, 12)} · /task_cancel ${summary.jobId.slice(0, 12)}`
        : summary.status === 'cooling' || summary.status === 'cancelled'
            ? ''
            : `控制：/task_pause ${summary.jobId.slice(0, 12)} · /task_cancel ${summary.jobId.slice(0, 12)}`;
    return [
        title,
        `🆔 job: ${summary.jobId.slice(0, 12)}`,
        `📍 频道：${summary.source || '未知'}`,
        ``,
        `🔎 扫描：${summary.scanStatus || 'pending'}`,
        `📄 频道正文：已扫 ${summary.channelMessagesScanned || 0} 条，发现 ${summary.channelMediaFound || 0} 个文件`,
        `💬 评论区：已扫 ${summary.commentMessagesScanned || 0} 条，发现 ${summary.commentMediaFound || 0} 个文件`,
        ``,
        `⬇️ 下载：${summary.downloadStatus}`,
        `✅ 成功 ${summary.completed || 0}　⏳ 待下载 ${summary.pending || 0}　🔄 下载中 ${summary.downloading || 0}　❌ 失败 ${summary.failed || 0}　⏭ 跳过 ${summary.skipped || 0}`,
        summary.cooldownUntil ? `${cooldownIsFloodWait ? '⏳ Telegram FloodWait' : '⏸️ 存储服务保护'}冷却到：${summary.cooldownUntil}` : '',
        controls,
    ].filter(Boolean).join('\n');
}

async function updateJobProgressMessage(statusMessage: Api.Message, summary: TelegramJobProgressSummary): Promise<void> {
    await statusMessage.edit({ text: buildLegacyJobProgressPresentation(summary) }).catch(() => undefined);
}

async function updateScanStatusMessage(statusMessage: Api.Message, summary: TelegramDownloadScanSummary): Promise<void> {
    const lines = [
        `🔎 **扫描完成，开始下载**`,
        `📍 频道：${summary.source}`,
        ``,
        `📄 频道正文：扫描 ${summary.channelMessagesScanned} 条，发现 ${summary.channelMediaFound} 个文件`,
        summary.commentsEnabled
            ? `💬 评论区：扫描 ${summary.commentMessagesScanned} 条，发现 ${summary.commentMediaFound} 个文件（每帖最多 ${summary.commentsMaxPerPost} 条）`
            : `💬 评论区：未启用`,
        `📦 待下载：${summary.totalMediaFound} 个文件`,
        ``,
        `⏳ 正在加入下载队列，可用 /tasks 查看后台任务。`,
    ];
    await statusMessage.edit({ text: lines.join('\n') }).catch(() => undefined);
}

async function replyWithJobResult(statusMessage: Api.Message, fallbackMessage: Api.Message, promise: Promise<any>, kind: 'date' | 'tag'): Promise<void> {
    promise
        .then(result => {
            const cancelled = Boolean(result.cancelled);
            const commentLine = result.commentMediaFound || result.commentMessagesScanned
                ? `\n评论区: 扫描 ${result.commentMessagesScanned || 0} 条，发现 ${result.commentMediaFound || 0} 个文件`
                : '';
            const text = cancelled
                ? `🛑 ${kind === 'tag' ? '标签' : '日期'}下载任务已取消\nID: ${String(result.jobId).slice(0, 12)}\n已完成: ${result.successful || 0}\n跳过: ${result.skipped || 0}${commentLine}`
                : kind === 'tag'
                    ? `✅ 标签下载任务完成\n标签: ${result.tag}\nID: ${String(result.jobId).slice(0, 12)}\n入队: ${result.found}\n跳过: ${result.skipped}\n失败: ${result.failed}${commentLine}`
                    : `✅ 日期范围任务完成\nID: ${String(result.jobId).slice(0, 12)}\n入队: ${result.found}\n跳过: ${result.skipped}\n失败: ${result.failed}${commentLine}`;
            statusMessage.edit({ text }).catch(() => fallbackMessage.reply({ message: text }).catch(() => undefined));
        })
        .catch(error => {
            const text = `❌ ${kind === 'tag' ? '标签' : '日期'}下载失败: ${error instanceof Error ? error.message : String(error)}`;
            statusMessage.edit({ text }).catch(() => fallbackMessage.reply({ message: text }).catch(() => undefined));
        });
}

async function startTelegramWizard(message: Api.Message, senderId: number, kind: TelegramWizardKind): Promise<void> {
    const state: TelegramWizardState = { kind, step: kind === 'tg_download' ? 'mode' : 'source' };
    telegramWizardStates.set(senderId, state);
    if (kind === 'tg_sub_manage') {
        const rows = await listManageableTelegramSubscriptions(senderId);
        await message.reply({ message: buildSubscriptionManagePanel(rows, 0), buttons: buildSubscriptionActionKeyboard(rows, 0) });
        return;
    }
    await message.reply({
        message: buildTelegramWizardPrompt(state),
        buttons: kind === 'tg_download' ? buildTelegramDownloadModeKeyboard() : undefined,
    });
}

async function handleTelegramWizardMessage(message: Api.Message, senderId: number, text: string): Promise<boolean> {
    const state = telegramWizardStates.get(senderId);
    if (!state) return false;

    const input = text.trim();
    if (!input) return true;
    if (isCancelInput(input)) {
        telegramWizardStates.delete(senderId);
        await message.reply({ message: '已取消 Telegram 频道操作向导。' });
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
            await message.reply({ message: '❌ 请发送 `date`/`日期` 或 `tag`/`标签`，也可以发送“取消”退出。' });
            return true;
        }
        await message.reply({ message: buildTelegramWizardPrompt(state) });
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
                    await message.reply({ message: '❌ 没有这个序号，请回复列表中的序号，或发送频道用户名/链接来新增订阅。' });
                    return true;
                }
                telegramWizardStates.delete(senderId);
                await sendSubscriptionCancelConfirmation(message, senderId, target, 0);
                return true;
            }

            if (!input.startsWith('@') && !/^https?:\/\/t\.me\//i.test(input) && !/^-?\d+$/.test(input)) {
                await message.reply({ message: '❌ 请回复订阅序号来取消，或发送频道用户名/链接来新增订阅，例如：`@channel_username`。' });
                return true;
            }

            state.step = 'path';
            await message.reply({ message: buildTelegramWizardPrompt(state) });
            return true;
        }
        state.step = 'path';
        await message.reply({ message: buildTelegramWizardPrompt(state) });
        return true;
    }

    if (state.step === 'path') {
        const skipPath = /^(跳过|skip|默认|default|无|不用|不指定)$/i.test(input);
        if (skipPath) {
            delete state.customFolder;
        } else {
            try {
                state.customFolder = await rememberRecentTelegramPathPersistent(message.chatId?.toString() || 'unknown', input);
            } catch (error) {
                await message.reply({ message: `❌ 路径无效：${(error as Error).message}\n\n请重新发送目录，或发送“跳过”使用默认保存路径规则。` });
                return true;
            }
        }

        if (state.kind === 'tg_sub_manage') {
            telegramWizardStates.delete(senderId);
            try {
                if (state.subscriptionId) {
                    const sub = await updateTelegramSubscriptionFolder(senderId, state.subscriptionId, state.customFolder || null);
                    const rowsAfterUpdate = await listManageableTelegramSubscriptions(senderId);
                    await message.reply({
                        message: [
                            sub ? `✅ 已更新订阅目录：${sub.title || sub.source}` : '❌ 未找到该订阅',
                            sub && state.customFolder ? `📁 专属目录：${state.customFolder}\n${buildPathPreviewLine(state.customFolder)}` : '📁 保存策略：默认自动分类',
                            '',
                            buildSubscriptionManagePanel(rowsAfterUpdate, 0),
                        ].filter(Boolean).join('\n'),
                        buttons: buildSubscriptionActionKeyboard(rowsAfterUpdate, 0),
                    });
                } else {
                    const sub = await subscribeTelegramChannel(senderId, message.chatId?.toString(), state.source!, state.customFolder);
                    await message.reply({
                        message: [
                            `✅ 已订阅 ${sub.title || sub.source}`,
                            `📍 ${sub.source}`,
                            state.customFolder ? `📁 本订阅专属保存目录：${state.customFolder}\n${buildPathPreviewLine(state.customFolder)}` : '📁 本订阅使用默认保存路径规则',
                            `从当前最新消息 ID ${sub.last_message_id || 0} 之后开始自动同步。`,
                        ].join('\n')
                    });
                }
            } catch (error) {
                await message.reply({ message: `❌ 订阅操作失败: ${error instanceof Error ? error.message : String(error)}` });
            }
            return true;
        }

        if (state.kind === 'tg_tag' || state.kind === 'tg_date') {
            state.step = state.includeComments !== undefined ? (state.kind === 'tg_tag' ? 'tag' : 'start_date') : 'comments';
            await message.reply({ message: buildTelegramWizardPrompt(state), buttons: state.step === 'comments' ? buildTelegramCommentsKeyboard() : undefined });
            return true;
        }
        return true;

    }

    if (state.step === 'comments') {
        const enabled = /^(开|开启|是|包含|评论|评论区|yes|y|on|true|1)$/i.test(input);
        const disabled = /^(关|关闭|否|不包含|仅频道|no|n|off|false|0)$/i.test(input);
        if (!enabled && !disabled) {
            await message.reply({ message: '❌ 请发送 `开`/`关`，或点击按钮选择是否包含评论区文件。' });
            return true;
        }
        state.includeComments = enabled;
        state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
        state.step = state.kind === 'tg_tag' ? 'tag' : 'start_date';
        await message.reply({ message: buildTelegramWizardPrompt(state) });
        return true;
    }

    if (state.step === 'confirm') {
        if (!/^(确认|confirm|yes|y)$/i.test(input)) {
            await message.reply({ message: '请发送 `确认` 开始任务，或发送 `取消` 放弃。' });
            return true;
        }
        telegramWizardStates.delete(senderId);
        try {
            if (state.kind === 'tg_tag') {
                const queuedMsg = await message.reply({ message: `⏳ 已确认，开始后台扫描 ${state.source} 中带有 ${state.tag?.startsWith('#') ? state.tag : `#${state.tag}`} 的媒体消息…` });
                await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramTagDownload(client!, message, senderId, state.source!, state.tag!, state.customFolder, {
                    includeComments: Boolean(state.includeComments), commentsMaxPerPost: state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
                    onScanComplete: summary => updateScanStatusMessage(queuedMsg as Api.Message, summary), onProgress: summary => updateJobProgressMessage(queuedMsg as Api.Message, summary),
                    targetProvider: state.targetProvider, targetAccountId: state.targetAccountId,
                }), 'tag');
            } else {
                const queuedMsg = await message.reply({ message: `⏳ 已确认，开始后台扫描 ${state.source}：${state.startDate} → ${state.endDate}…` });
                await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramDateDownload(client!, message, senderId, state.source!, state.startDate!, state.endDate!, state.customFolder, {
                    includeComments: Boolean(state.includeComments), commentsMaxPerPost: state.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
                    onScanComplete: summary => updateScanStatusMessage(queuedMsg as Api.Message, summary), onProgress: summary => updateJobProgressMessage(queuedMsg as Api.Message, summary),
                    targetProvider: state.targetProvider, targetAccountId: state.targetAccountId,
                }), 'date');
            }
        } catch (error) {
            await message.reply({ message: `❌ 任务提交失败: ${error instanceof Error ? error.message : String(error)}` });
        }
        return true;
    }

    if (state.step === 'tag') {
        state.tag = input;
        const target = storageManager.getActiveTarget();
        const accounts = await storageManager.getAccounts();
        state.targetProvider = target.provider.name;
        state.targetAccountId = target.accountId;
        state.targetAccountName = accounts.find(account => String(account.id) === String(target.accountId || ''))?.name || (target.provider.name === 'local' ? '服务器本地目录' : undefined);
        state.step = 'confirm';
        await message.reply({ message: buildTelegramWizardPrompt(state) });
        return true;
    }

    if (state.step === 'start_date') {
        if (!isDateOnly(input)) {
            await message.reply({ message: '❌ 日期格式必须是 YYYY-MM-DD，例如：2026-06-01' });
            return true;
        }
        state.startDate = input;
        state.step = 'end_date';
        await message.reply({ message: buildTelegramWizardPrompt(state) });
        return true;
    }

    if (!isDateOnly(input)) {
        await message.reply({ message: '❌ 日期格式必须是 YYYY-MM-DD，例如：2026-06-27' });
        return true;
    }

    state.endDate = input;
    const target = storageManager.getActiveTarget();
    const accounts = await storageManager.getAccounts();
    state.targetProvider = target.provider.name;
    state.targetAccountId = target.accountId;
    state.targetAccountName = accounts.find(account => String(account.id) === String(target.accountId || ''))?.name || (target.provider.name === 'local' ? '服务器本地目录' : undefined);
    state.step = 'confirm';
    await message.reply({ message: buildTelegramWizardPrompt(state) });
    return true;
}

async function listManageableTelegramSubscriptions(userId: number): Promise<any[]> {
    const rows = await listTelegramSubscriptions(userId, true);
    return rows.filter(isTelegramSubscriptionVisibleInManagement);
}

function buildSubscriptionActionKeyboard(rows: any[], requestedPage = 0): Api.ReplyInlineMarkup | undefined {
    const page = buildTelegramSubscriptionPage(rows, requestedPage);
    if (page.visibleRows.length === 0) return undefined;
    const actionRows = page.visibleRows.flatMap((row, localIndex) => [
        new Api.KeyboardButtonRow({
            buttons: [new Api.KeyboardButtonCallback({ text: `${page.startIndex + localIndex + 1}. ${row.title || row.source}`, data: Buffer.from(`tsub_view_${row.id}_${page.page}`) })],
        }),
        new Api.KeyboardButtonRow({
            buttons: [
                new Api.KeyboardButtonCallback({ text: '✏️ 修改专属目录', data: Buffer.from(`tsub_folder_${row.id}_${page.page}`) }),
                new Api.KeyboardButtonCallback({ text: '🧹 清除目录', data: Buffer.from(`tsub_clear_${row.id}_${page.page}`) }),
                new Api.KeyboardButtonCallback({ text: '取消订阅', data: Buffer.from(`tsub_cancel_${row.id}_${page.page}`) }),
            ],
        }),
    ]);
    const navigation: Api.TypeKeyboardButton[] = [];
    if (page.page > 0) navigation.push(new Api.KeyboardButtonCallback({ text: '◀️ 上一页', data: Buffer.from(`tsub_page_${page.page - 1}`) }));
    navigation.push(new Api.KeyboardButtonCallback({ text: '🔄 刷新', data: Buffer.from(`tsub_page_${page.page}`) }));
    if (page.page + 1 < page.totalPages) navigation.push(new Api.KeyboardButtonCallback({ text: '下一页 ▶️', data: Buffer.from(`tsub_page_${page.page + 1}`) }));
    return new Api.ReplyInlineMarkup({
        rows: [...actionRows, new Api.KeyboardButtonRow({ buttons: navigation })],
    });
}

function buildSubscriptionDisplayLines(row: any, index: number): string {
    const status = row.enabled ? '✅' : '⏸️';
    const sourceLine = row.source_original && row.source_original !== row.source
        ? `   ${row.source_original} → ${row.source} · last_id=${row.last_message_id || 0}`
        : `   ${row.source} · last_id=${row.last_message_id || 0}`;
    return [
        `${index + 1}. ${status} ${row.title || row.source_original || row.source}`,
        sourceLine,
        row.folder_override ? `   📁 专属目录：${row.folder_override}` : '   📁 保存策略：默认自动分类',
        row.last_scan_at ? `   🔎 上次扫描：${new Date(row.last_scan_at).toLocaleString('zh-CN', { hour12: false })}` : '   🔎 尚未扫描',
        row.last_success_at ? `   ✅ 上次成功：${new Date(row.last_success_at).toLocaleString('zh-CN', { hour12: false })}` : null,
        row.next_scan_at ? `   ⏭️ 下次扫描约：${new Date(row.next_scan_at).toLocaleString('zh-CN', { hour12: false })}` : null,
        row.last_result ? `   📊 最近结果：${row.last_result.status || 'unknown'}${row.last_result.found !== undefined ? `，发现 ${row.last_result.found}` : ''}${row.last_result.failed ? `，失败 ${row.last_result.failed}` : ''}` : null,
        row.last_error ? `   ⚠️ 最近错误：${row.last_error}` : null,
        !row.enabled && row.disabled_reason ? `   ⚠️ ${row.disabled_reason}` : null,
        !row.enabled && row.disabled_at ? `   暂停时间：${new Date(row.disabled_at).toLocaleString('zh-CN', { hour12: false })}` : null,
    ].filter(Boolean).join('\n');
}

function buildSubscriptionManagePanel(rows: any[], requestedPage = 0): string {
    const page = buildTelegramSubscriptionPage(rows, requestedPage);
    return [
        '📡 **频道订阅管理**',
        ...(page.totalPages > 1 ? [`第 ${page.page + 1}/${page.totalPages} 页 · 共 ${rows.length} 个订阅`] : []),
        '',
        page.visibleRows.length > 0
            ? page.visibleRows.map((row, index) => buildSubscriptionDisplayLines(row, page.startIndex + index)).join('\n')
            : '当前没有订阅。',
        '',
        rows.length > 0 ? '可直接点击订阅下方按钮修改/清除专属目录或取消订阅；系统自动暂停的订阅会保留提醒，重新添加同一来源可恢复。' : '回复频道用户名或链接可新增订阅。',
        '回复频道用户名或链接也可新增订阅。',
        '例如：`@channel_username`、`https://t.me/channel_username` 或已加入的 `https://t.me/+hash` 私密链接',
        '',
        '新增订阅时会询问是否为本订阅单独指定保存目录；该目录只影响这个订阅，不会改变全局 /path_rules。',
        '',
        '发送“取消”可退出。',
    ].join('\n');
}

function formatSubscriptionList(rows: any[]): string {
    if (rows.length === 0) return '📭 暂无频道订阅。\n\n使用 `/tg_sub @频道` 添加订阅。';
    return [
        '📡 **频道订阅**',
        '',
        ...rows.map((row, index) => [
            buildSubscriptionDisplayLines(row, index),
            `   ID: ${String(row.id).slice(0, 8)}`,
        ].join('\n')),
    ].join('\n');
}

function telegramSubscriptionPeerKey(peer: any): string {
    const value = peer?.userId || peer?.chatId || peer?.channelId;
    return String(value?.toString?.() || value || peer?.toString?.() || '').replace(/^-100/, '').replace(/^-/, '');
}

function buildSubscriptionCancelConfirm(target: any, token: string): { text: string; buttons: Api.ReplyInlineMarkup } {
    return {
        text: [
            '⚠️ **确认取消这个频道订阅？**',
            '',
            `📌 ${target.title || target.source_original || target.source}`,
            `来源：${target.source_original || target.source}`,
            target.folder_override ? `专属目录：${target.folder_override}` : '保存策略：默认自动分类',
            `当前游标：last_id=${target.last_message_id || 0}`,
            '',
            '确认后会停止自动同步，并从订阅管理列表中移除；已保存的文件不会删除。',
        ].join('\n'),
        buttons: new Api.ReplyInlineMarkup({
            rows: [new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '⚠️ 确认取消', data: Buffer.from(`tsub_confirm_${token}`) }),
                    new Api.KeyboardButtonCallback({ text: '返回订阅列表', data: Buffer.from(`tsub_back_${token}`) }),
                ],
            })],
        }),
    };
}

async function sendSubscriptionCancelConfirmation(message: Api.Message, userId: number, target: any, page: number): Promise<void> {
    const token = crypto.randomBytes(12).toString('base64url');
    const confirm = buildSubscriptionCancelConfirm(target, token);
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
    const confirm = buildSubscriptionCancelConfirm(target, token);
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
function generatePasswordKeyboard(currentLength: number): Api.ReplyInlineMarkup {
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
                    new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('pwd_clear') }),
                    new Api.KeyboardButtonCallback({ text: '0', data: Buffer.from('pwd_0') }),
                    new Api.KeyboardButtonCallback({ text: '⌫', data: Buffer.from('pwd_backspace') }),
                ]
            }),
        ],
    });
}

// Handle Password Callback
export function canTelegramUserAuthenticate(userId: number, allowedUsers: number[]): boolean {
    return allowedUsers.length > 0 && allowedUsers.includes(userId);
}

async function handlePasswordCallback(update: Api.UpdateBotCallbackQuery): Promise<void> {
    if (!client) return;

    const userId = update.userId.toJSNumber();
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
                        await client.editMessage(update.peer, {
                            message: update.msgId,
                            text: '⛔ 当前 Telegram 用户不在允许列表中，请在 TELEGRAM_ALLOWED_USER_IDS 或后台允许列表中加入你的 user id。',
                            buttons: generatePasswordKeyboard(0),
                        });
                        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '未在允许列表中', alert: true }));
                        return;
                    }

                    clearPinFailures(userId);
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
            message: result.success ? '✅ 清理成功' : '❌ 清理失败'
        }));
    } catch (error) {
        console.error('🤖 处理清理回调失败:', error);
        try {
            await client.invoke(new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: '❌ 清理失败'
            }));
        } catch (e) { /* ignore */ }
    }
}

async function handleTaskQueueCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
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
            message: '任务已完成、已失效或不属于当前聊天',
            alert: true,
        }));
        return;
    }
    try {
        if (action === 'pause') {
            const result = pauseDownloadTasks(taskId);
            await refreshSilentProgress(client, update.peer, userId);
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: result.total > 0 ? '已暂停下载队列' : '当前没有可暂停的下载任务' }));
            return;
        }
        if (action === 'resume') {
            const result = resumeDownloadTasks(taskId);
            await refreshSilentProgress(client, update.peer, userId);
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: result.total > 0 ? '已继续下载队列' : '当前没有等待中的下载任务' }));
            return;
        }
        await cancelSilentTask(client, update.peer, taskId, update.msgId, userId);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消后台任务', alert: true }));
    } catch (error) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: `操作失败: ${(error as Error).message}`,
            alert: true,
        }));
    }
}

async function handleTelegramDownloadModeCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    if (data === 'tgd_cancel') {
        telegramWizardStates.delete(userId);
        await client.editMessage(update.peer, { message: update.msgId, text: '已取消频道文件下载向导。' });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
        return;
    }
    const state = telegramWizardStates.get(userId) || { kind: 'tg_download' as TelegramWizardKind, step: 'mode' as TelegramWizardStep };
    if (data === 'tgd_mode_date') {
        state.kind = 'tg_date';
        state.step = 'source';
        telegramWizardStates.set(userId, state);
        await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '按日期下载' }));
        return;
    }
    if (data === 'tgd_mode_tag') {
        state.kind = 'tg_tag';
        state.step = 'source';
        telegramWizardStates.set(userId, state);
        await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '按标签下载' }));
        return;
    }
    if (data === 'tgd_comments_on' || data === 'tgd_comments_off') {
        state.includeComments = data === 'tgd_comments_on';
        state.commentsMaxPerPost = TELEGRAM_COMMENTS_MAX_PER_POST;
        state.step = state.kind === 'tg_tag' ? 'tag' : 'start_date';
        telegramWizardStates.set(userId, state);
        await client.editMessage(update.peer, { message: update.msgId, text: buildTelegramWizardPrompt(state) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: state.includeComments ? '将包含评论区文件' : '仅下载频道正文文件',
        }));
        return;
    }
}

async function handleTelegramSubscriptionCallback(update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    if (!client) return;
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const parsed = parseTelegramSubscriptionCallback(data);
    if (!parsed) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '订阅按钮无效或已过期', alert: true }));
        return;
    }
    const rows = await listManageableTelegramSubscriptions(userId);

    if (parsed.kind === 'page') {
        const page = buildTelegramSubscriptionPage(rows, parsed.page);
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildSubscriptionManagePanel(rows, page.page),
            buttons: buildSubscriptionActionKeyboard(rows, page.page),
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
                    buildSubscriptionManagePanel(rowsAfterCancel, page.page),
                ].join('\n'),
                buttons: buildSubscriptionActionKeyboard(rowsAfterCancel, page.page),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: sub ? '已取消订阅' : '订阅不存在或已经取消', alert: true }));
            return;
        }
        const page = buildTelegramSubscriptionPage(rows, pending.page);
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildSubscriptionManagePanel(rows, page.page),
            buttons: buildSubscriptionActionKeyboard(rows, page.page),
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
        telegramWizardStates.set(userId, state);
        await client.sendMessage(update.peer, { message: buildTelegramWizardPrompt(state) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请发送新的专属目录' }));
        return;
    }

    if (parsed.action === 'clear') {
        await updateTelegramSubscriptionFolder(userId, parsed.id, null);
        const rowsAfterClear = await listManageableTelegramSubscriptions(userId);
        const page = buildTelegramSubscriptionPage(rowsAfterClear, parsed.page);
        await client.editMessage(update.peer, {
            message: update.msgId,
            text: buildSubscriptionManagePanel(rowsAfterClear, page.page),
            buttons: buildSubscriptionActionKeyboard(rowsAfterClear, page.page),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已清除专属目录' }));
        return;
    }

    if (parsed.action === 'cancel') {
        await editSubscriptionCancelConfirmation(update, userId, target, parsed.page);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请确认是否取消订阅' }));
    }
}

export async function initTelegramBot(): Promise<void> {
    const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

    if (!apiId || !apiHash || !botToken) {
        console.log('⚠️ 未配置 Telegram API 凭证，Bot 未启动');
        console.log('   需要设置: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_BOT_TOKEN');
        return;
    }

    try {
        console.log('🤖 Telegram Bot 正在同步存储配置...');
        await storageManager.init();
        const provider = storageManager.getProvider();
        console.log(`🤖 Telegram Bot 当前存储提供商: ${provider.name}`);
    } catch (e) {
        console.error('🤖 Telegram Bot 同步存储配置失败:', e);
    }

    try {
        const sessionDir = path.dirname(SESSION_FILE);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
        }

        let sessionString = '';
        if (fs.existsSync(SESSION_FILE)) {
            sessionString = fs.readFileSync(SESSION_FILE, 'utf-8').trim();
        }

        const session = new StringSession(sessionString);
        client = new TelegramClient(session, apiId, apiHash, {
            connectionRetries: 15,
            retryDelay: 2000,
            useWSS: false,
            deviceModel: 'TG Vault Bot',
            systemVersion: '1.0.0',
            appVersion: '1.0.0',
            floodSleepThreshold: 120,
        });

        console.log('🤖 Telegram Bot 正在启动...');

        await client.start({
            botAuthToken: botToken,
        });

        const newSession = client.session.save() as unknown as string;
        fs.writeFileSync(SESSION_FILE, newSession, { mode: 0o600 });
        try { fs.chmodSync(SESSION_FILE, 0o600); } catch (e) { console.warn('🤖 修正 Telegram Bot session 文件权限失败:', e); }

        console.log('🤖 Telegram Bot 已连接!');
        setYtDlpNotifier(async (chatId, text) => {
            if (!client) return;
            await client.sendMessage(chatId, { message: text });
        });

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

        // Set Bot Commands
        try {
            await client.invoke(new Api.bots.SetBotCommands({
                scope: new Api.BotCommandScopeDefault(),
                langCode: 'zh',
                commands: buildBotCommandMenu().map(command => new Api.BotCommand(command))
            }));
            console.log('🤖 Bot 命令菜单已更新');
        } catch (e) {
            console.error('🤖 更新 Bot 命令菜单失败:', e);
        }

        try {
            const cleanupSetting = await query('SELECT value FROM system_settings WHERE key = $1', ['auto_cleanup_orphans']);
            if (cleanupSetting.rows[0]?.value !== undefined) {
                process.env.AUTO_CLEANUP_ORPHANS = String(cleanupSetting.rows[0].value);
            }
        } catch (e) {
            console.warn('🧹 读取自动清理设置失败，使用环境变量默认值:', e);
        }

        try {
            const fileConcurrency = await loadFileDownloadConcurrencySetting();
            console.log(`🤖 Telegram 文件级并发: ${fileConcurrency}`);
        } catch (e) {
            console.warn('🤖 读取文件级并发设置失败，使用环境变量默认值:', e);
        }

        // 启动时清理孤儿文件（默认开启，可通过 /cleanup_settings 关闭）
        if (isAutoCleanupEnabled()) {
            try {
                const stats = await cleanupOrphanFiles();
                if (stats.deletedCount > 0) {
                    console.log(`🧹 启动清理: 删除了 ${stats.deletedCount} 个孤儿文件，释放 ${stats.freedSpace}`);

                    // 向所有已认证用户发送清理通知
                    for (const userId of authenticatedUsers.keys()) {
                        try {
                            await client.sendMessage(userId, {
                                message: buildCleanupNotice(stats.deletedCount, stats.freedSpace)
                            });
                        } catch (e) {
                            // 用户可能已删除对话或阻止了 Bot
                        }
                    }
                }
            } catch (e) {
                console.error('🧹 启动清理失败:', e);
            }
        } else {
            console.log('🧹 启动孤儿清理已跳过：AUTO_CLEANUP_ORPHANS=false');
        }

        // 启动定期清理（每小时）
        startPeriodicCleanup();
        startTelegramSubscriptionWorker(client);
        startTelegramJobRecoveryWorker(client);

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
                    await handleStart(message, senderId, buildBotStartKeyboard());
                    if (!(await isAuthenticatedAsync(senderId))) {
                        // Send password keyboard if not authenticated
                        await message.reply({
                            message: buildStartPrompt(),
                            buttons: generatePasswordKeyboard(0),
                        });
                    }
                    return;
                }
                // 处理 /setup-2fa 命令
                if (text === '/setup_2fa' || text === '/setup-2fa') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    try {
                        const qrDataUrl = await generateOTPAuthUrl();
                        const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
                        const buffer = Buffer.from(base64Data, 'base64');
                        const tempPath = path.join(process.cwd(), `temp_qr_${senderId}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
                        fs.writeFileSync(tempPath, buffer);

                        const qrMessage = await client.sendFile(chatId, {
                            file: tempPath,
                            caption: build2FASetupCaption()
                        });

                        userStates.set(senderId, {
                            state: TelegramUserState.WAITING_2FA_SETUP,
                            qrMessageId: qrMessage.id
                        });

                        fs.unlinkSync(tempPath);
                    } catch (e) {
                        console.error('生成 2FA 二维码失败:', e);
                        await client.sendMessage(chatId, { message: MSG.AUTH_2FA_QR_FAIL });
                    }
                    return;
                }

                if (text === '/help') {
                    await handleHelp(message);
                    return;
                }

                // /ytdlp <url>
                {
                    const match = text.match(/^\s*\/ytdlp(?:@\w+)?(?:\s+([\s\S]*))?\s*$/i);
                    if (match) {
                        console.log(`🤖 /ytdlp command received from ${senderId}: messageId=${message.id}`);
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }

                        const argsText = (match[1] || '').trim();
                    if (!argsText) {
                        await message.reply({ message: '❌ 用法: /ytdlp <url>' });
                        return;
                    }

                    const parts = argsText.split(/\s+/).filter(Boolean);
                    if (parts.length !== 1) {
                        await message.reply({ message: '❌ 只允许一个链接\n\n用法: /ytdlp <url>' });
                        return;
                    }

                    const url = parts[0];
                    try {
                        await assertPublicHttpUrl(url);
                    } catch (error) {
                        await message.reply({ message: `❌ 无效链接：${error instanceof Error ? error.message : '不允许访问该地址'}` });
                        return;
                    }

                    await handleYtDlpCommand(message, url);
                    return;
                }
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
                    if (isCancelInput(text)) {
                        const pendingMode = getPendingTelegramPathInput(chatId.toString(), senderId);
                        if (pendingMode) {
                            clearPendingTelegramPathInput(chatId.toString(), senderId);
                            await message.reply({ message: '已取消保存路径设置。' });
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
                    await message.reply({ message: formatSubscriptionList(rows) });
                    return;
                }

                if (text.startsWith('/tg_sub ') || text.startsWith('/tg_subscribe ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const source = text.split(/\s+/).slice(1).join(' ').trim();
                    if (!source) {
                        await message.reply({ message: '❌ 用法：/tg_sub @频道' });
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
                        await message.reply({ message: '❌ 用法：/tg_unsub @频道 或 /tg_unsub <订阅ID前缀>' });
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
                    if (mode === 'date' || mode === '日期') {
                        if (parts.length !== 3) {
                            await message.reply({ message: '❌ 用法：/tg_download date @频道 YYYY-MM-DD YYYY-MM-DD' });
                            return;
                        }
                        try {
                            const queuedMsg = await message.reply({ message: `⏳ 已开始后台扫描 ${parts[0]}：${parts[1]} → ${parts[2]}...
完成后会自动更新结果，可用 /tasks 查看后台任务。` });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramDateDownload(client, message, senderId, parts[0], parts[1], parts[2]), 'date');
                        } catch (error) {
                            await message.reply({ message: `❌ 日期下载失败: ${error instanceof Error ? error.message : String(error)}` });
                        }
                        return;
                    }
                    if (mode === 'tag' || mode === '标签') {
                        if (parts.length !== 2) {
                            await message.reply({ message: '❌ 用法：/tg_download tag @频道 #标签' });
                            return;
                        }
                        try {
                            const queuedMsg = await message.reply({ message: `⏳ 已开始后台扫描 ${parts[0]} 中带有 ${parts[1].startsWith('#') ? parts[1] : `#${parts[1]}`} 的媒体消息...
完成后会自动更新结果，可用 /tasks 查看后台任务。` });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramTagDownload(client, message, senderId, parts[0], parts[1]), 'tag');
                        } catch (error) {
                            await message.reply({ message: `❌ 标签下载失败: ${error instanceof Error ? error.message : String(error)}` });
                        }
                        return;
                    }
                    await message.reply({ message: '❌ 用法：/tg_download date @频道 YYYY-MM-DD YYYY-MM-DD\n或：/tg_download tag @频道 #标签' });
                    return;
                }

                if (text.startsWith('/tg_date ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const parts = text.split(/\s+/).slice(1);
                    if (parts.length !== 3) {
                        await message.reply({ message: '❌ 用法：/tg_date @频道 YYYY-MM-DD YYYY-MM-DD' });
                        return;
                    }
                    try {
                        const queuedMsg = await message.reply({ message: `⏳ 已开始后台扫描 ${parts[0]}：${parts[1]} → ${parts[2]}...
完成后会自动更新结果，可用 /tasks 查看后台任务。` });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramDateDownload(client, message, senderId, parts[0], parts[1], parts[2]), 'date');
                    } catch (error) {
                        await message.reply({ message: `❌ 日期下载失败: ${error instanceof Error ? error.message : String(error)}` });
                    }
                    return;
                }

                if (text.startsWith('/tg_tag ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const parts = text.split(/\s+/).slice(1);
                    if (parts.length !== 2) {
                        await message.reply({ message: '❌ 用法：/tg_tag @频道 #标签' });
                        return;
                    }
                    try {
                        const queuedMsg = await message.reply({ message: `⏳ 已开始后台扫描 ${parts[0]} 中带有 ${parts[1].startsWith('#') ? parts[1] : `#${parts[1]}`} 的媒体消息...
完成后会自动更新结果，可用 /tasks 查看后台任务。` });
                            await replyWithJobResult(queuedMsg as Api.Message, message, enqueueTelegramTagDownload(client, message, senderId, parts[0], parts[1]), 'tag');
                    } catch (error) {
                        await message.reply({ message: `❌ 标签下载失败: ${error instanceof Error ? error.message : String(error)}` });
                    }
                    return;
                }

                if (text === '/storage') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleStorage(message);
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

                if (text === '/list' || text.startsWith('/list ')) {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleList(message, text.split(/\s+/).slice(1));
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

                if (text === '/tasks' || text === '/task') {
                    if (!(await isAuthenticatedAsync(senderId))) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleTasks(message);
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
                    await handlePathRules(message);
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
                // 处理文件删除二次确认回调
                if (data.startsWith('del_')) {
                    await handleDeleteConfirmCallback(activeClient, callbackUpdate, data);
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

        console.log('🤖 Telegram Bot 启动成功! (最大 2GB，账号级下载器不受此限制)');

    } catch (error) {
        console.error('🤖 Telegram Bot 启动失败:', error);
    }
}

// 发送安全通知给所有已认证用户
export async function sendSecurityNotification(message: string): Promise<void> {
    if (!client || !client.connected) {
        console.warn('⚠️ Telegram Client 未连接，无法发送安全通知');
        return;
    }

    const authUsers = Array.from(authenticatedUsers.keys());
    for (const userId of authUsers) {
        try {
            await client.sendMessage(userId, { message });
        } catch (e) {
            console.error(`🤖 向用户 ${userId} 发送通知失败:`, e);
        }
    }
}

export default { initTelegramBot, sendSecurityNotification };
