import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const commands = fs.readFileSync(new URL('./telegramCommands.ts', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('./telegramNotificationSettings.ts', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
const locale = fs.readFileSync(new URL('../i18n/telegram.ts', import.meta.url), 'utf8');

test('notification preference and digest storage are durable', () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS telegram_notification_preferences/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS telegram_notification_digest/);
});

test('Bot exposes an interactive notification panel while security delivery remains mandatory', () => {
    assert.match(commands, /handleNotificationsCallback/);
    assert.match(settings, /notifications\.securityAlways/);
    assert.match(settings, /notifications\.clickToChange/);
    assert.match(locale, /安全告警始终立即通知/);
    assert.match(locale, /点击按钮修改/);
    assert.match(bot, /data\.startsWith\('nt_'\)/);
});
