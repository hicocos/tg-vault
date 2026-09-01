import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const config = fs.readFileSync(new URL('./telegramBotConfig.ts', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
const jobs = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../routes/storage.ts', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../utils/settings.ts', import.meta.url), 'utf8');

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
    const startupSection = bot.slice(bot.indexOf("console.log('🤖 Telegram Bot 正在启动...')"), bot.indexOf('const newSession = client.session.save()'));
    assert.doesNotMatch(startupSection, /Promise\.race|withTelegramClientDeadline/);
    assert.match(bot, /new TelegramClient\(new StringSession\(''\)/);
    assert.match(bot, /await client\.start[\s\S]*SetBotCommands[\s\S]*addEventHandler[\s\S]*markTelegramBotReady\(\)/);
    assert.doesNotMatch(bot, /startTelegramSubscriptionWorker|startTelegramJobRecoveryWorker|startPeriodicCleanup/);
    assert.match(bot, /markTelegramBotReady\(\)[\s\S]*Telegram Bot 启动成功/);
    assert.match(bot, /catch \(error\) \{[\s\S]*const failedClient = client;[\s\S]*client = null;[\s\S]*failedClient\.disconnect/);
});

test('client teardown waits for in-flight subscription and recovery work', () => {
    assert.match(jobs, /while \(subscriptionScanRunning \|\| recoveryRunning\)/);
    assert.match(jobs, /拒绝切换 Bot 客户端/);
    assert.match(bot, /await stopTelegramBackgroundWorkers\(\)/);
});
