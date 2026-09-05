import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { resources, t } from './telegram.js';
import { buildPathSettingsText } from '../utils/telegramPathSettings.js';
import { buildTaskCenterPage } from '../services/telegramTaskCenter.js';

const bot = fs.readFileSync(new URL('../services/telegramBot.ts', import.meta.url), 'utf8');
const commands = fs.readFileSync(new URL('../services/telegramCommands.ts', import.meta.url), 'utf8');
const messages = fs.readFileSync(new URL('../utils/telegramMessages.ts', import.meta.url), 'utf8');
const upload = fs.readFileSync(new URL('../services/telegramUpload.ts', import.meta.url), 'utf8');
const pathSettings = fs.readFileSync(new URL('../utils/telegramPathSettings.ts', import.meta.url), 'utf8');
const subscriptionPresentation = fs.readFileSync(new URL('../bot/presentation/subscription.ts', import.meta.url), 'utf8');

test('English command surfaces render English instead of Chinese or placeholders', () => {
    const start = t('en', 'auth.welcomeBack');
    const tasks = buildTaskCenterPage([], 0, { locale: 'en' }).text;
    const paths = buildPathSettingsText({ automaticBySource: true, automaticByType: true }, 'chat', 'en');

    for (const [surface, value] of Object.entries({ start, tasks, paths })) {
        assert.doesNotMatch(value, /[\u3400-\u9fff]/, surface);
        assert.doesNotMatch(value, /Localized message \d+/, surface);
    }

    assert.match(start, /Welcome back/);
    assert.match(tasks, /Download tasks/);
    assert.match(tasks, /No active tasks/);
    assert.match(paths, /Save location/);
    assert.match(paths, /Default save behavior/);
});

test('English locale is passed through the visible command handlers', () => {
    assert.match(commands, /buildWelcomeBack\(locale \|\| await getTelegramUserLocaleOrDefault\(senderId\)\)/);
    assert.match(commands, /buildTaskCenterPage\(items, 0, \{ locale: resolvedLocale \}\)/);
    assert.match(commands, /buildPathSettingsText\(pathCenterState, message\.chatId\?\.toString\(\) \|\| 'unknown', resolvedLocale\)/);
    assert.match(bot, /handleTasks\(message, await getTelegramUserLocaleOrDefault\(senderId\)\)/);
    assert.match(bot, /handlePathRules\(message, await getTelegramUserLocaleOrDefault\(senderId\)\)/);
});

test('path-setting cancellation resolves the sender locale', () => {
    assert.match(bot, /getTelegramUserLocaleOrDefault\(senderId\)[\s\S]*path\.toast\.cancelled/);
    assert.doesNotMatch(bot, /message:\s*['"`]已取消保存路径设置。/);
    assert.equal(t('en', 'path.toast.cancelled'), 'Save location setup cancelled.');
    assert.equal(t('zh-CN', 'path.toast.cancelled'), '已取消保存路径设置。');
});

test('English locale resources contain no translated Chinese or placeholder copy', () => {
    for (const [key, value] of Object.entries(resources.en)) {
        assert.doesNotMatch(value, /Localized message \d+/, key);
        assert.doesNotMatch(value, /[\u3400-\u9fff]/, key);
    }
});
