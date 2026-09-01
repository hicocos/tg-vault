import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const config = fs.readFileSync(new URL('./telegramBotConfig.ts', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
const jobs = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../routes/storage.ts', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../utils/settings.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

test('Web Telegram credentials stay outside process.env and decrypt fail closed', () => {
    assert.doesNotMatch(config, /process\.env\.TELEGRAM_(?:BOT_TOKEN|API_ID|API_HASH)\s*=/);
    assert.match(config, /getSettingStrict/);
    assert.match(settings, /export async function getSettingStrict/);
    assert.match(config, /凭证不完整，已拒绝回退到环境变量/);
});

test('all Bot lifecycle mutations share one serialized operation', () => {
    assert.match(bot, /withTelegramBotLifecycle/);
    for (const route of ['put', 'post', 'delete']) assert.match(routes, new RegExp(`router\\.${route}\\(`));
    assert.ok((routes.match(/withTelegramBotLifecycle/g) || []).length >= 4);
    assert.doesNotMatch(routes, /\b(?:restartTelegramBot|stopTelegramBot)\(/);
});

test('activation failure restores persisted and runtime configuration', () => {
    assert.match(config, /snapshotTelegramBotConfig/);
    assert.match(config, /restoreTelegramBotConfig/);
    assert.match(routes, /catch \(activationError\)[\s\S]*restoreTelegramBotConfig\(previous\)[\s\S]*controls\.restart/);
});

test('Bot save never starts or refreshes Telegram user-account runtimes', () => {
    const saveRoute = routes.slice(
        routes.indexOf("router.put('/config/telegram-bot'"),
        routes.indexOf("router.post('/config/telegram-bot/migrate'"),
    );
    assert.doesNotMatch(saveRoute, /initializeTelegramMultiAccountRuntime|installTelegramMultiAccountRuntimeAdapters|initTelegramUserClient|telegramUserClientPool|triggerTelegramAccountAccessSweep/);
    assert.doesNotMatch(saveRoute, /testTelegramBotCredentials/);
});

test('Bot migrate, disable and delete routes remain isolated from Telegram user-account runtimes', () => {
    const lifecycleRoutes = routes.slice(
        routes.indexOf("router.post('/config/telegram-bot/migrate'"),
        routes.indexOf("router.post('/config/telegram-user-download'"),
    );
    assert.doesNotMatch(lifecycleRoutes, /initializeTelegramMultiAccountRuntime|installTelegramMultiAccountRuntimeAdapters|initTelegramUserClient|telegramUserClientPool|triggerTelegramAccountAccessSweep/);
});

test('Bot replacement avoids stale saved sessions and requires full activation before ready', () => {
    assert.doesNotMatch(bot, /fs\.readFileSync\(SESSION_FILE/);
    assert.doesNotMatch(bot, /session\.save\(\)[\s\S]*writeFileSync\(SESSION_FILE/);
    const startupSection = bot.slice(bot.indexOf("console.log('🤖 Telegram Bot 正在启动...')"), bot.indexOf("console.log('🤖 Telegram Bot 已连接!')"));
    assert.doesNotMatch(startupSection, /Promise\.race|withTelegramClientDeadline/);
    assert.match(bot, /new TelegramClient\(new StringSession\(''\)/);
    assert.match(bot, /await client\.start[\s\S]*addEventHandler[\s\S]*markTelegramBotReady\(\)/);
    const startup = bot.slice(bot.indexOf('export async function initTelegramBot'), bot.indexOf('async function withTelegramClientDeadline'));
    assert.doesNotMatch(startup, /startTelegramSubscriptionWorker|startTelegramJobRecoveryWorker|startPeriodicCleanup/);
    assert.match(bot, /markTelegramBotReady\(\)[\s\S]*Telegram Bot 启动成功/);
    assert.match(bot, /catch \(error\) \{[\s\S]*const failedClient = client;[\s\S]*client = null;[\s\S]*failedClient\.disconnect/);
});

test('Bot startup defers global notifier and timer effects until ready and rolls them back on failure', () => {
    const startup = bot.slice(bot.indexOf('export async function initTelegramBot'), bot.indexOf('async function withTelegramClientDeadline'));
    const readyIndex = startup.indexOf('markTelegramBotReady()');
    assert.ok(readyIndex >= 0);
    assert.ok(startup.indexOf('setYtDlpNotifier(', readyIndex) > readyIndex);
    assert.ok(startup.indexOf('digestTimer = setInterval(', readyIndex) > readyIndex);
    assert.match(startup, /catch \(error\) \{[\s\S]*clearInterval\(digestTimer\)[\s\S]*setYtDlpNotifier\(null\)/);
});

test('Bot startup never performs orphan cleanup or sends cleanup notifications', () => {
    const startup = bot.slice(bot.indexOf('export async function initTelegramBot'), bot.indexOf('async function withTelegramClientDeadline'));
    assert.doesNotMatch(startup, /cleanupOrphanFiles\(|buildCleanupNotice|启动清理/);
});

test('credential test uses the HTTPS Bot API without creating another MTProto session', () => {
    assert.doesNotMatch(config, /TelegramClient|StringSession|client\.start/);
    assert.match(config, /api\.telegram\.org\/bot/);
    assert.match(config, /AbortController/);
});

test('application starts Bot first, then restores user accounts after an isolation delay before background workers', () => {
    const initialize = app.slice(app.indexOf('async function initializeApplication'), app.indexOf('async function startApplication'));
    const startBot = initialize.indexOf('await initTelegramBot()');
    const scheduleIsolation = initialize.indexOf('scheduleTelegramBotPostStartup');
    assert.ok(startBot >= 0);
    assert.ok(scheduleIsolation > startBot);
    assert.doesNotMatch(initialize.slice(0, startBot), /restoreEnabledTelegramUserAccountsAfterRestart\(\)/);
    assert.match(bot, /scheduleTelegramBotPostStartup[\s\S]*restoreUserAccounts[\s\S]*startTelegramSubscriptionWorker[\s\S]*startTelegramJobRecoveryWorker/);
});

test('runtime Bot replacement delays background workers without reconnecting user sessions', () => {
    const lifecycle = bot.slice(bot.indexOf('export interface TelegramBotLifecycleControls'), bot.indexOf('export async function stopTelegramBot'));
    assert.match(lifecycle, /scheduleTelegramBotPostStartup\(async \(\) => undefined\)/);
    assert.doesNotMatch(lifecycle, /restoreEnabledTelegramUserAccountsAfterRestart|initializeTelegramMultiAccountRuntime|telegramUserClientPool/);
});

test('orphan cleanup belongs to the application lifecycle, not Bot activation', () => {
    assert.match(app, /startPeriodicCleanup\(\)/);
    const startup = bot.slice(bot.indexOf('export async function initTelegramBot'), bot.indexOf('async function withTelegramClientDeadline'));
    assert.doesNotMatch(startup, /startPeriodicCleanup|cleanupOrphanFiles/);
});

test('command menu is synchronized only when the Bot-specific fingerprint changes and never blocks readiness', () => {
    assert.match(bot, /telegram_bot_command_menu_fingerprint/);
    assert.match(bot, /commandMenuFingerprint[\s\S]*SetBotCommands[\s\S]*setSetting/);
    assert.match(bot, /catch \(error\)[\s\S]*Bot 命令菜单同步失败/);
    assert.match(bot, /Bot 命令菜单同步失败[\s\S]*markTelegramBotReady\(\)/);
});

test('client teardown waits for in-flight subscription and recovery work', () => {
    assert.match(jobs, /while \(subscriptionScanRunning \|\| recoveryRunning\)/);
    assert.match(jobs, /拒绝切换 Bot 客户端/);
    assert.match(bot, /await stopTelegramBackgroundWorkers\(\)/);
});
