import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const app = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
const storage = fs.readFileSync(new URL('../routes/storage.ts', import.meta.url), 'utf8');
const compose = fs.readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
const envExample = fs.readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');

test('Bot startup errors are observable and required mode blocks readiness', () => {
    assert.match(bot, /markTelegramBotStarting\(\)/);
    assert.match(bot, /markTelegramBotReady\(\)/);
    assert.match(bot, /markTelegramBotError\([\s\S]*status/);
    assert.match(bot, /throw error/);
    assert.match(app, /telegramConfig\.required/);
    assert.match(app, /telegramBotBlocksReadiness\(bot\)/);
    assert.match(app, /components: \{ dependencies, telegramBot: bot \}/);
});

test('optional Bot failure remains visible as degraded in Web settings and readiness', () => {
    assert.match(app, /应用以 degraded 状态继续/);
    assert.match(app, /classifyTelegramBotStartupError\(error\)/);
    assert.match(app, /Telegram Bot Token 已失效，请在网页端更换凭证/);
    assert.match(app, /status: bot\.degraded \? 'degraded' : 'ready'/);
    assert.match(storage, /telegramBotStatus: getTelegramBotStatus\(\)/);
});

test('deployment contract exposes TELEGRAM_REQUIRED with safe defaults and Web override guidance', () => {
    assert.match(compose, /TELEGRAM_REQUIRED=\$\{TELEGRAM_REQUIRED:-false\}/);
    assert.match(envExample, /TELEGRAM_REQUIRED=false/);
    assert.match(envExample, /网页管理的 Bot 配置会保存对应 required 状态/);
});
