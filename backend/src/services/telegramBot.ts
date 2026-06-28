import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { Raw } from 'telegram/events/index.js';
import fs from 'fs';
import path from 'path';
import { storageManager } from '../services/storage.js';
import { authenticatedUsers, passwordInputState, isAuthenticated, loadAuthenticatedUsers, persistAuthenticatedUser, userStates, TelegramUserState } from './telegramState.js';
import { is2FAEnabled, generateOTPAuthUrl, verifyTOTP, activate2FA } from '../utils/security.js';
import { handleStart, handleHelp, handleStorage, handleList, handleDelete, handleTasks, handleStopTasks, handlePauseTasks, handleResumeTasks, handleCancelTask, handleRetryFailedTasks, handleDownloadWorkers, handleDownloadWorkersCallback, handlePathRules, handlePathRulesCallback, handleDuplicateMode, handleDuplicateModeCallback, handleCleanupSettings, handleCleanupSettingsCallback } from './telegramCommands.js';
import { handleFileUpload, handleCleanupCallback } from './telegramUpload.js';
import { handleYtDlpCommand } from './ytDlpDownload.js';
import {
    enqueueTelegramDateDownload,
    enqueueTelegramTagDownload,
    listTelegramBackgroundJobs,
    listTelegramSubscriptions,
    startTelegramSubscriptionWorker,
    subscribeTelegramChannel,
    unsubscribeTelegramChannel,
} from './telegramChannelJobs.js';
import { cleanupOrphanFiles, isAutoCleanupEnabled, startPeriodicCleanup } from './orphanCleanup.js';
import { verifyPassword } from '../utils/telegramUtils.js';
import { MSG, buildStartPrompt, buildAuthSuccess, build2FASetupCaption, buildCleanupNotice } from '../utils/telegramMessages.js';
import { query } from '../db/index.js';
import { assertPublicHttpUrl } from '../utils/networkSecurity.js';

// Session File Path
const SESSION_FILE = process.env.TELEGRAM_SESSION_FILE || './data/telegram_session.txt';

// GramJS Client
let client: TelegramClient | null = null;

type TelegramWizardKind = 'tg_sub_manage' | 'tg_date' | 'tg_tag';
type TelegramWizardStep = 'source' | 'start_date' | 'end_date' | 'tag';

interface TelegramWizardState {
    kind: TelegramWizardKind;
    step: TelegramWizardStep;
    source?: string;
    startDate?: string;
    tag?: string;
}

const telegramWizardStates = new Map<number, TelegramWizardState>();

interface RateBucket {
    windowStartedAt: number;
    count: number;
}

const telegramRateBuckets = new Map<string, RateBucket>();
const TELEGRAM_MESSAGE_RATE_WINDOW_MS = Math.max(10_000, parseInt(process.env.TELEGRAM_RATE_WINDOW_MS || '60000', 10) || 60_000);
const TELEGRAM_MESSAGE_RATE_MAX = Math.max(5, parseInt(process.env.TELEGRAM_RATE_MAX || '30', 10) || 30);
const TELEGRAM_HEAVY_RATE_WINDOW_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_HEAVY_RATE_WINDOW_MS || '600000', 10) || 600_000);
const TELEGRAM_HEAVY_RATE_MAX = Math.max(1, parseInt(process.env.TELEGRAM_HEAVY_RATE_MAX || '5', 10) || 5);
const TELEGRAM_HEAVY_COMMANDS = new Set(['/ytdlp', '/tg_date', '/tg_tag', '/cleanup_settings']);

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
            : '🗓️ **按日期下载频道文件**';

    if (state.step === 'source') {
        return [
            title,
            '',
            '请发送频道用户名或链接：',
            '例如：`@channel_username` 或 `https://t.me/channel_username`',
            '',
            '发送“取消”可退出。',
        ].join('\n');
    }

    if (state.step === 'tag') {
        return [
            title,
            `📍 频道：${state.source}`,
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
            `📍 频道：${state.source}`,
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

async function startTelegramWizard(message: Api.Message, senderId: number, kind: TelegramWizardKind): Promise<void> {
    const state: TelegramWizardState = { kind, step: 'source' };
    telegramWizardStates.set(senderId, state);
    if (kind === 'tg_sub_manage') {
        const rows = await listTelegramSubscriptions(senderId);
        await message.reply({ message: buildSubscriptionManagePanel(rows) });
        return;
    }
    await message.reply({ message: buildTelegramWizardPrompt(state) });
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

    if (state.step === 'source') {
        state.source = input;
        if (state.kind === 'tg_sub_manage') {
            if (/^\d+$/.test(input)) {
                const rows = await listTelegramSubscriptions(senderId);
                const index = parseInt(input, 10) - 1;
                const target = rows[index];
                if (!target) {
                    await message.reply({ message: '❌ 没有这个序号，请回复列表中的序号，或发送频道用户名/链接来新增订阅。' });
                    return true;
                }
                const sub = await unsubscribeTelegramChannel(senderId, target.id);
                telegramWizardStates.delete(senderId);
                const rowsAfterCancel = await listTelegramSubscriptions(senderId);
                await message.reply({
                    message: [
                        sub ? `✅ 已取消订阅 ${sub.title || sub.source}` : '❌ 未找到该订阅',
                        '',
                        buildSubscriptionManagePanel(rowsAfterCancel),
                    ].join('\n')
                });
                return true;
            }

            if (!input.startsWith('@') && !/^https?:\/\/t\.me\//i.test(input) && !/^-?\d+$/.test(input)) {
                await message.reply({ message: '❌ 请回复订阅序号来取消，或发送频道用户名/链接来新增订阅，例如：`@channel_username`。' });
                return true;
            }

            telegramWizardStates.delete(senderId);
            try {
                const sub = await subscribeTelegramChannel(senderId, message.chatId?.toString(), input);
                await message.reply({ message: `✅ 已订阅 ${sub.title || sub.source}\n📍 ${sub.source}\n从当前最新消息 ID ${sub.last_message_id || 0} 之后开始自动同步。` });
            } catch (error) {
                await message.reply({ message: `❌ 订阅失败: ${error instanceof Error ? error.message : String(error)}` });
            }
            return true;
        }
        if (state.kind === 'tg_tag') {
            state.step = 'tag';
        } else {
            state.step = 'start_date';
        }
        await message.reply({ message: buildTelegramWizardPrompt(state) });
        return true;
    }

    if (state.step === 'tag') {
        telegramWizardStates.delete(senderId);
        try {
            await message.reply({ message: `⏳ 正在扫描 ${state.source} 中带有 ${input.startsWith('#') ? input : `#${input}`} 的媒体消息...` });
            const result = await enqueueTelegramTagDownload(client!, message, senderId, state.source!, input);
            await message.reply({ message: `✅ 标签下载任务已提交\n标签: ${result.tag}\nID: ${String(result.jobId).slice(0, 8)}\n入队: ${result.found}\n跳过: ${result.skipped}` });
        } catch (error) {
            await message.reply({ message: `❌ 标签下载失败: ${error instanceof Error ? error.message : String(error)}` });
        }
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

    telegramWizardStates.delete(senderId);
    try {
        await message.reply({ message: `⏳ 正在按日期扫描 ${state.source}：${state.startDate} → ${input}...` });
        const result = await enqueueTelegramDateDownload(client!, message, senderId, state.source!, state.startDate!, input);
        await message.reply({ message: `✅ 日期范围任务已提交\nID: ${String(result.jobId).slice(0, 8)}\n入队: ${result.found}\n跳过: ${result.skipped}` });
    } catch (error) {
        await message.reply({ message: `❌ 日期下载失败: ${error instanceof Error ? error.message : String(error)}` });
    }
    return true;
}

function buildSubscriptionManagePanel(rows: any[]): string {
    return [
        '📡 **频道订阅管理**',
        '',
        rows.length > 0
            ? rows.map((row, index) => `${index + 1}. ${row.enabled ? '✅' : '⏸️'} ${row.title || row.source}\n   ${row.source} · last_id=${row.last_message_id || 0}`).join('\n')
            : '当前没有启用中的订阅。',
        '',
        '回复序号可取消订阅。',
        '回复频道用户名或链接可新增订阅。',
        '例如：`@channel_username` 或 `https://t.me/channel_username`',
        '',
        '发送“取消”可退出。',
    ].join('\n');
}

function formatSubscriptionList(rows: any[]): string {
    if (rows.length === 0) return '📭 暂无频道订阅。\n\n使用 `/tg_sub @频道` 添加订阅。';
    return [
        '📡 **频道订阅**',
        '',
        ...rows.map((row, index) => `${index + 1}. ${row.enabled ? '✅' : '⏸️'} ${row.title || row.source}\n   ${row.source} · last_id=${row.last_message_id || 0}\n   ID: ${String(row.id).slice(0, 8)}`),
    ].join('\n');
}

function formatJobList(rows: any[]): string {
    if (rows.length === 0) return '📭 暂无 Telegram 后台任务记录。';
    return [
        '🧾 **Telegram 后台任务**',
        '',
        ...rows.map((row, index) => [
            `${index + 1}. ${row.status} · ${row.kind} · ${row.source}`,
            `   入队 ${row.enqueued_count || 0}/${row.total_count || 0} · 跳过 ${row.skipped_count || 0} · 重复 ${row.duplicate_count || 0}`,
            row.error ? `   错误: ${row.error}` : `   ID: ${String(row.id).slice(0, 8)}`,
        ].join('\n')),
    ].join('\n');
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
async function handlePasswordCallback(update: Api.UpdateBotCallbackQuery): Promise<void> {
    if (!client) return;

    const userId = update.userId.toJSNumber();
    const data = Buffer.from(update.data || []).toString('utf-8');

    if (!data.startsWith('pwd_')) return;

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
                state.password += digit;

                // Auto verify
                if (state.password.length >= 4) {
                    if (verifyPassword(state.password)) {
                        passwordInputState.delete(userId);

                        // Check if 2FA is enabled
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

                        // Set persistent menu for user if possible (not possible with inline, needs separate command)
                        // But we can send a hint
                        return;
                    }

                    // If wrong but still < 12 chars, we might just clear or show error
                    // Original code cleared at >= 4 if correct, or waited for 12 if wrong? 
                    // Let's check original logic: 
                    // if (verified) success
                    // if (len >= 12) error

                    // Let's improve this: if 4 chars and wrong, shake or something?
                    // But for security, maybe we just let them type? 
                    // The original code checked at >= 4 for correct password. 
                    // If 4 chars is the password length, it's fine. 
                    // But if password is longer, we shouldn't fail immediately at 4.
                    // However, we don't know the password length if we just hash check.
                    // But wait, `verifyPassword` hashes the input. 
                    // If the real password is "12345", input "1234" will hash to something else.
                    // So we can check at every input? No, that allows brute force optimization.
                    // We should probably only check when user hits "Enter" or explicit length?
                    // But the UI has no Enter.
                    // The original code checked:
                    // if (len >= 4 && verify) -> success
                    // if (len >= 12) -> fail
                    // This implies the password is expected to be short (4-something) or the user has to keep typing until 12?
                    // Use the same logic for now to avoid breaking changes, but strictly usage of verifyPassword.
                }

                if (state.password.length >= 12) {
                    state.password = '';
                    await client.editMessage(update.peer, {
                        message: update.msgId,
                        text: MSG.AUTH_WRONG,
                        buttons: generatePasswordKeyboard(0),
                    });
                    await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_WRONG }));
                    return;
                }
            }
        }

        // Update keyboard
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
            fs.mkdirSync(sessionDir, { recursive: true });
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
            deviceModel: 'FlClouds Bot',
            systemVersion: '1.0.0',
            appVersion: '1.0.0',
            floodSleepThreshold: 120,
        });

        console.log('🤖 Telegram Bot 正在启动...');

        await client.start({
            botAuthToken: botToken,
        });

        const newSession = client.session.save() as unknown as string;
        fs.writeFileSync(SESSION_FILE, newSession);

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

        // Set Bot Commands
        try {
            await client.invoke(new Api.bots.SetBotCommands({
                scope: new Api.BotCommandScopeDefault(),
                langCode: 'zh',
                commands: [
                    new Api.BotCommand({ command: 'start', description: '开始使用 / 验证身份' }),
                    new Api.BotCommand({ command: 'setup_2fa', description: '配置双重验证 (2FA)' }),
                    new Api.BotCommand({ command: 'ytdlp', description: '解析并下载链接到存储源' }),
                    new Api.BotCommand({ command: 'tg_sub', description: '订阅频道自动同步' }),
                    new Api.BotCommand({ command: 'tg_date', description: '按日期下载频道文件' }),
                    new Api.BotCommand({ command: 'tg_tag', description: '按标签下载频道文件' }),
                    new Api.BotCommand({ command: 'tg_jobs', description: '查看 Telegram 后台任务' }),
                    new Api.BotCommand({ command: 'storage', description: '查看存储统计' }),
                    new Api.BotCommand({ command: 'list', description: '查看上传记录' }),
                    new Api.BotCommand({ command: 'tasks', description: '查看任务状态' }),
                    new Api.BotCommand({ command: 'stop_tasks', description: '强制停止下载任务' }),
                    new Api.BotCommand({ command: 'download_workers', description: '设置 Telegram 并发下载' }),
                    new Api.BotCommand({ command: 'path_rules', description: '设置保存路径规则' }),
                    new Api.BotCommand({ command: 'duplicate_mode', description: '设置重复文件处理' }),
                    new Api.BotCommand({ command: 'cleanup_settings', description: '设置自动清理开关' }),
                    new Api.BotCommand({ command: 'help', description: '显示预览帮助' }),
                ]
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

                const text = message.text || '';
                const chatId = message.chatId;

                if (!chatId) return;

                const rateLimit = consumeTelegramRateLimit(senderId, text);
                if (rateLimit.limited) {
                    await message.reply({ message: `⏳ 操作过于频繁，请 ${rateLimit.retryAfterSeconds} 秒后再试。` });
                    return;
                }

                console.log(`🤖 Received text from ${senderId}: ${text}`);

                // Commands
                if (text === '/start') {
                    await handleStart(message, senderId);
                    if (!isAuthenticated(senderId)) {
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
                        console.log(`🤖 /ytdlp command received from ${senderId}: ${text}`);
                    if (!isAuthenticated(senderId)) {
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
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_sub_manage');
                    return;
                }

                if (text === '/tg_date') {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_date');
                    return;
                }

                if (text === '/tg_tag') {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await startTelegramWizard(message, senderId, 'tg_tag');
                    return;
                }

                if (!text.startsWith('/')) {
                    const handledTelegramWizard = await handleTelegramWizardMessage(message, senderId, text);
                    if (handledTelegramWizard) return;
                }

                if (text === '/tg_subs' || text === '/tg_subscriptions') {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const rows = await listTelegramSubscriptions(senderId);
                    await message.reply({ message: formatSubscriptionList(rows) });
                    return;
                }

                if (text.startsWith('/tg_sub ') || text.startsWith('/tg_subscribe ')) {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const source = text.split(/\s+/).slice(1).join(' ').trim();
                    if (!source) {
                        await message.reply({ message: '❌ 用法：/tg_sub @频道' });
                        return;
                    }
                    try {
                        const sub = await subscribeTelegramChannel(senderId, chatId.toString(), source);
                        await message.reply({ message: `✅ 已订阅 ${sub.title || sub.source}\n📍 ${sub.source}\n从当前最新消息 ID ${sub.last_message_id || 0} 之后开始自动同步。` });
                    } catch (error) {
                        await message.reply({ message: `❌ 订阅失败: ${error instanceof Error ? error.message : String(error)}` });
                    }
                    return;
                }

                if (text.startsWith('/tg_unsub ') || text.startsWith('/tg_unsubscribe ')) {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const selector = text.split(/\s+/).slice(1).join(' ').trim();
                    if (!selector) {
                        await message.reply({ message: '❌ 用法：/tg_unsub @频道 或 /tg_unsub <订阅ID前缀>' });
                        return;
                    }
                    const sub = await unsubscribeTelegramChannel(senderId, selector);
                    await message.reply({ message: sub ? `✅ 已取消订阅 ${sub.title || sub.source}` : '❌ 未找到该订阅' });
                    return;
                }

                if (text.startsWith('/tg_date ')) {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const parts = text.split(/\s+/).slice(1);
                    if (parts.length !== 3) {
                        await message.reply({ message: '❌ 用法：/tg_date @频道 YYYY-MM-DD YYYY-MM-DD' });
                        return;
                    }
                    try {
                        await message.reply({ message: `⏳ 正在按日期扫描 ${parts[0]}：${parts[1]} → ${parts[2]}...` });
                        const result = await enqueueTelegramDateDownload(client, message, senderId, parts[0], parts[1], parts[2]);
                        await message.reply({ message: `✅ 日期范围任务已提交\nID: ${String(result.jobId).slice(0, 8)}\n入队: ${result.found}\n跳过: ${result.skipped}` });
                    } catch (error) {
                        await message.reply({ message: `❌ 日期下载失败: ${error instanceof Error ? error.message : String(error)}` });
                    }
                    return;
                }

                if (text.startsWith('/tg_tag ')) {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const parts = text.split(/\s+/).slice(1);
                    if (parts.length !== 2) {
                        await message.reply({ message: '❌ 用法：/tg_tag @频道 #标签' });
                        return;
                    }
                    try {
                        await message.reply({ message: `⏳ 正在扫描 ${parts[0]} 中带有 ${parts[1].startsWith('#') ? parts[1] : `#${parts[1]}`} 的媒体消息...` });
                        const result = await enqueueTelegramTagDownload(client, message, senderId, parts[0], parts[1]);
                        await message.reply({ message: `✅ 标签下载任务已提交\n标签: ${result.tag}\nID: ${String(result.jobId).slice(0, 8)}\n入队: ${result.found}\n跳过: ${result.skipped}` });
                    } catch (error) {
                        await message.reply({ message: `❌ 标签下载失败: ${error instanceof Error ? error.message : String(error)}` });
                    }
                    return;
                }

                if (text === '/tg_jobs' || text === '/tg_tasks') {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const jobs = await listTelegramBackgroundJobs(senderId);
                    await message.reply({ message: formatJobList(jobs) });
                    return;
                }

                if (text === '/storage') {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleStorage(message);
                    return;
                }

                if (text === '/list' || text.startsWith('/list ')) {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const args = text.split(' ').slice(1);
                    await handleList(message, args);
                    return;
                }

                if (text.startsWith('/delete ')) {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    const args = text.split(' ').slice(1);
                    await handleDelete(message, args);
                    return;
                }

                if (text === '/tasks' || text === '/task') {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleTasks(message);
                    return;
                }

                if (text === '/task_pause' || text.startsWith('/task_pause ')) {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePauseTasks(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/task_resume' || text.startsWith('/task_resume ')) {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleResumeTasks(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/task_cancel' || text.startsWith('/task_cancel ')) {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleCancelTask(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/tg_retry' || text.startsWith('/tg_retry ')) {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleRetryFailedTasks(message, text.split(/\s+/).slice(1));
                    return;
                }

                if (text === '/stop_tasks' || text === '/stop' || text === '/cancel_tasks') {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleStopTasks(message);
                    return;
                }

                if (text === '/download_workers' || text === '/workers') {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleDownloadWorkers(message);
                    return;
                }

                if (text === '/path_rules' || text === '/path' || text === '/save_rules') {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handlePathRules(message);
                    return;
                }

                if (text === '/duplicate_mode' || text === '/duplicate' || text === '/dup') {
                    if (!isAuthenticated(senderId)) {
                        await message.reply({ message: MSG.AUTH_REQUIRED });
                        return;
                    }
                    await handleDuplicateMode(message);
                    return;
                }

                if (text === '/cleanup_settings' || text === '/cleanup') {
                    if (!isAuthenticated(senderId)) {
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
                if (!isAuthenticated(senderId) && text && !text.startsWith('/')) {
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
