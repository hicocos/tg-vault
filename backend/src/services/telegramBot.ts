import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { Raw } from 'telegram/events/index.js';
import fs from 'fs';
import path from 'path';
import { storageManager } from '../services/storage.js';
import { authenticatedUsers, passwordInputState, isAuthenticated, loadAuthenticatedUsers, persistAuthenticatedUser, userStates, TelegramUserState } from './telegramState.js';
import { is2FAEnabled, generateOTPAuthUrl, verifyTOTP, activate2FA } from '../utils/security.js';
import { handleStart, handleHelp, handleStorage, handleList, handleDelete, handleTasks } from './telegramCommands.js';
import { handleFileUpload, handleCleanupCallback } from './telegramUpload.js';
import { handleYtDlpCommand } from './ytDlpDownload.js';
import { cleanupOrphanFiles, startPeriodicCleanup } from './orphanCleanup.js';
import { verifyPassword } from '../utils/telegramUtils.js';
import { MSG, buildStartPrompt, buildAuthSuccess, build2FASetupCaption, buildCleanupNotice } from '../utils/telegramMessages.js';
import { query } from '../db/index.js';

// Session File Path
const SESSION_FILE = process.env.TELEGRAM_SESSION_FILE || './data/telegram_session.txt';

// GramJS Client
let client: TelegramClient | null = null;

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
            deviceModel: 'FoomClous Bot',
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
                    new Api.BotCommand({ command: 'storage', description: '查看存储统计' }),
                    new Api.BotCommand({ command: 'list', description: '查看上传记录' }),
                    new Api.BotCommand({ command: 'tasks', description: '查看任务状态' }),
                    new Api.BotCommand({ command: 'help', description: '显示预览帮助' }),
                ]
            }));
            console.log('🤖 Bot 命令菜单已更新');
        } catch (e) {
            console.error('🤖 更新 Bot 命令菜单失败:', e);
        }

        // 启动时清理孤儿文件
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

        // 启动定期清理（每小时）
        startPeriodicCleanup();

        // Handle Messages
        client.addEventHandler(async (event: NewMessageEvent) => {
            if (!client) return;

            try {
                const message = event.message;
                if (message.out) return; // 忽略 Bot 自己发送的消息，防止递归响应

                if (!message.text && !message.media) return;

                const senderId = message.senderId?.toJSNumber();
                if (!senderId) return;

                const text = message.text || '';
                const chatId = message.chatId;

                if (!chatId) return;

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
                        const tempPath = path.join(process.cwd(), `temp_qr_${chatId}.png`);
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
                    if (!/^https?:\/\//i.test(url)) {
                        await message.reply({ message: '❌ 无效链接：必须以 http:// 或 https:// 开头' });
                        return;
                    }

                    await handleYtDlpCommand(message, url);
                    return;
                }
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
                    await handleFileUpload(client, event);
                    return;
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
            }
        }, new Raw({}));

        console.log('🤖 Telegram Bot 启动成功! (支持最大 2GB 文件)');

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
