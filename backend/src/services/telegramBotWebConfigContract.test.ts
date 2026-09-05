import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const cryptoSource = fs.readFileSync(new URL('../utils/credentialCrypto.ts', import.meta.url), 'utf8');
const configSource = fs.readFileSync(new URL('./telegramBotConfig.ts', import.meta.url), 'utf8');
const routeSource = fs.readFileSync(new URL('../routes/storage.ts', import.meta.url), 'utf8');
const frontendApi = fs.readFileSync(new URL('../../../frontend/src/services/api.ts', import.meta.url), 'utf8');
const settingsPage = fs.readFileSync(new URL('../../../frontend/src/components/pages/SettingsPage.tsx', import.meta.url), 'utf8');

test('Telegram Bot secrets reuse encrypted settings storage', () => {
    for (const key of ['telegram_bot_token', 'telegram_api_id', 'telegram_api_hash']) {
        assert.match(cryptoSource, new RegExp(`['"]${key}['"]`));
    }
    assert.match(configSource, /setSettings\(\[/);
    assert.match(configSource, /TELEGRAM_BOT_TOKEN_SETTING/);
    assert.match(configSource, /TELEGRAM_API_ID_SETTING/);
    assert.match(configSource, /TELEGRAM_API_HASH_SETTING/);
});

test('Telegram Bot status responses never expose saved credentials', () => {
    assert.match(configSource, /configured:\s*boolean/);
    assert.match(configSource, /source:\s*['"]web['"]\s*\|\s*['"]environment['"]\s*\|\s*['"]none['"]/);
    const publicConfigBody = configSource.slice(
        configSource.indexOf('export async function getTelegramBotPublicConfig'),
        configSource.indexOf('export async function testTelegramBotCredentials'),
    );
    assert.doesNotMatch(publicConfigBody, /botToken|apiHash|apiId/);
    assert.match(routeSource, /Cache-Control.*no-store/);
});

test('first Web Bot configuration requires an exactly four-digit PIN without exposing it later', () => {
    assert.match(configSource, /pinConfigured:/);
    assert.match(routeSource, /ensureTelegramPinConfigured\(req\.body\?\.telegramPin\)/);
    assert.ok((routeSource.match(/ensureTelegramPinConfigured\(req\.body\?\.telegramPin\)/g) || []).length >= 2);
    assert.match(settingsPage, /settings\.remaining\.copy\.029/);
    assert.match(settingsPage, /pattern="\[0-9\]\{4\}"/);
    assert.match(settingsPage, /maxLength=\{4\}/);
    assert.doesNotMatch(configSource, /telegramPin:\s*[^;]+;/);
});

test('Bot credential probe response explicitly states that runtime startup is separate', () => {
    const route = fs.readFileSync(new URL('../routes/storage.ts', import.meta.url), 'utf8');
    assert.match(route, /runtimeStarted: false/);
});

test('Bot public config separates credential probe and runtime readiness', () => {
    assert.match(configSource, /runtimeReady: status.status === 'ready'/);
    assert.match(configSource, /credentialProbeOnly: false/);
});

test('Telegram Bot web management supports test, replace, disable, delete, and environment migration', () => {
    for (const endpoint of [
        "'/config/telegram-bot'",
        "'/config/telegram-bot/test'",
        "'/config/telegram-bot/disable'",
        "'/config/telegram-bot/migrate'",
    ]) assert.match(routeSource, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(routeSource, /router\.delete\('\/config\/telegram-bot'/);
    assert.match(frontendApi, /getTelegramBotConfig/);
    assert.match(frontendApi, /testTelegramBotConfig/);
    assert.match(frontendApi, /saveTelegramBotConfig/);
    assert.match(configSource, /getEnvironmentTelegramBotCredentials/);
    assert.match(configSource, /migrateEnvironmentTelegramBotConfig/);
    assert.match(settingsPage, /settings\.remaining\.copy\.025/);
    assert.match(settingsPage, /autoComplete="new-password"/);
    assert.doesNotMatch(settingsPage, /value=\{config\?\.telegramBot[^}]*Token/);
});

test('Telegram Bot PIN can be changed only after re-authentication and is rate limited', () => {
    assert.match(routeSource, /router\.put\('\/config\/telegram-bot\/pin',\s*requireAuth,\s*telegramPinChangeLimiter/);
    assert.match(routeSource, /changeTelegramPin\(req\.body\?\.verificationMethod,\s*req\.body\?\.verificationSecret,\s*req\.body\?\.newPin\)/);
    assert.match(routeSource, /修改 Telegram Bot PIN 请求过于频繁/);
    assert.match(frontendApi, /changeTelegramBotPin/);
    assert.match(settingsPage, /settings\.remaining\.copy\.339/);
    assert.match(settingsPage, /settings\.remaining\.copy\.341/);
    assert.match(settingsPage, /settings\.remaining\.copy\.342/);
    assert.match(settingsPage, /settings\.remaining\.copy\.031/);
});

test('a legacy configured Bot without a PIN can create one after web-password verification', () => {
    assert.match(routeSource, /if \(!current\.configured\)/);
    assert.match(settingsPage, /settings\.remaining\.copy\.028/);
    assert.match(settingsPage, /settings\.remaining\.copy\.340/);
    assert.match(settingsPage, /settings\.remaining\.copy\.342/);
    assert.match(frontendApi, /changeTelegramBotPin/);
});
