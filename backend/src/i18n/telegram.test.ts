import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
    DEFAULT_LOCALE,
    FALLBACK_LOCALE,
    TELEGRAM_LOCALES,
    formatBytes,
    interpolate,
    localeResourceKeys,
    resolveLocale,
    resources,
    t,
} from './telegram.js';
import { buildBotCommandMenu } from '../utils/telegramCommandRegistry.js';

const bot = fs.readFileSync(new URL('../services/telegramBot.ts', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../db/migrations/2026090101_telegram_user_locale.sql', import.meta.url), 'utf8');
const russianMigration = fs.readFileSync(new URL('../db/migrations/2026090201_add_russian_locale.sql', import.meta.url), 'utf8');
const preferences = fs.readFileSync(new URL('../services/telegramLocalePreferences.ts', import.meta.url), 'utf8');

test('Telegram locale registry defaults and falls back to Chinese', () => {
    assert.equal(DEFAULT_LOCALE, 'zh-CN');
    assert.equal(FALLBACK_LOCALE, 'zh-CN');
    assert.deepEqual(Object.keys(TELEGRAM_LOCALES), ['zh-CN', 'en', 'ru']);
    assert.equal(resolveLocale('en-US'), 'en');
    assert.equal(resolveLocale('ru-RU'), 'ru');
    assert.equal(resolveLocale('zh-Hans'), 'zh-CN');
    assert.equal(resolveLocale('fr'), 'zh-CN');
});

test('locale resources have exact parity, matching interpolation variables, and no escaped layout artifacts', () => {
    assert.deepEqual(localeResourceKeys('en'), localeResourceKeys('zh-CN'));
    for (const key of localeResourceKeys('zh-CN')) {
        const vars = (value: string) => [...value.matchAll(/\{([A-Za-z0-9_]+)/g)].map(match => match[1]).sort();
        const zh = resources['zh-CN'][key as keyof typeof resources['zh-CN']];
        const en = resources.en[key as keyof typeof resources.en];
        assert.deepEqual(vars(en), vars(zh), key);
        assert.doesNotMatch(zh, /\\n|\\`/, `zh-CN:${key}`);
        assert.doesNotMatch(en, /\\n|\\`/, `en:${key}`);
    }
    assert.equal(interpolate('hello {name}', { name: 'Ada' }), 'hello Ada');
    assert.throws(() => interpolate('{missing}', {}), /missing/);
});

test('locale formatting is locale aware', () => {
    assert.match(formatBytes(1536, 'en'), /1\.5 KB/);
    assert.match(formatBytes(1536, 'zh-CN'), /1\.5 KB/);
    assert.match(t('en', 'common.fileCount', { count: 2 }), /2 files/);
    assert.equal(t('ru', 'language.changed'), '✅ Язык изменён на русский');
});

test('start keyboard translations are present in both locales', () => {
    for (const locale of ['zh-CN', 'en', 'ru'] as const) {
        for (const key of ['keyboard.upload', 'keyboard.tasks', 'keyboard.storage', 'keyboard.more', 'keyboard.cancel']) {
            assert.notEqual(t(locale, key), key);
        }
    }
});

test('localized command menus preserve command names and order', () => {
    const zh = buildBotCommandMenu('zh-CN');
    const en = buildBotCommandMenu('en');
    assert.deepEqual(en.map(item => item.command), zh.map(item => item.command));
    assert.notDeepEqual(en.map(item => item.description), zh.map(item => item.description));
    assert.ok(zh.some(item => item.command === 'language'));
});

test('locale preference is durable and existing users remain Chinese', () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS telegram_user_locales/);
    assert.match(schema, /locale VARCHAR\(10\) NOT NULL DEFAULT 'zh-CN' CHECK \(locale IN \('zh-CN', 'en', 'ru'\)\)/);
    assert.match(migration, /DEFAULT 'zh-CN'/);
    assert.match(russianMigration, /locale IN \('zh-CN', 'en', 'ru'\)/);
    assert.match(preferences, /ON CONFLICT \(user_id\) DO UPDATE/);
});

test('language flow is presentation-only and cannot activate account runtimes', () => {
    const languageSection = bot.slice(bot.indexOf('async function handleLanguageSelection'), bot.indexOf('async function handlePasswordCallback'));
    assert.match(languageSection, /getTelegramUserLocale|setTelegramUserLocale|renderStartAfterLocale/);
    assert.doesNotMatch(languageSection, /persistAuthenticatedUser|addTelegramAllowedUser|reconcileTelegramAllowedUsers|initTelegramUserClient|restoreEnabledTelegramUserAccountsAfterRestart|initializeTelegramMultiAccountRuntime|startTelegramSubscriptionWorker|startTelegramJobRecoveryWorker|restartTelegramBot|setSetting/);
    assert.match(bot, /data\.startsWith\('lang_'\)/);
    assert.match(bot, /\/language|\/lang/);
});

test('native default, Chinese, English and Russian command menus are non-critical', () => {
    assert.match(bot, /langCode: ''/);
    assert.match(bot, /langCode: 'zh'/);
    assert.match(bot, /langCode: 'en'/);
    assert.match(bot, /langCode: 'ru'/);
    assert.match(bot, /Bot 命令菜单同步失败[\s\S]*markTelegramBotReady\(\)/);
});

test('telegramBot user surfaces use recipient locale and semantic resources', () => {
    for (const surface of [
        'homePageKeyboard', 'homePageText', 'buildTelegramWizardPrompt',
        'buildSubscriptionActionKeyboard', 'buildSubscriptionCancelConfirm',
    ]) {
        const start = bot.indexOf(`function ${surface}`);
        assert.ok(start >= 0, surface);
        const end = bot.indexOf('\n}\n', start) + 3;
        const body = bot.slice(start, end);
        assert.match(body, /locale: TelegramLocale/, `${surface} accepts locale`);
        assert.match(body, /t\(locale,/, `${surface} uses semantic resources`);
    }
    assert.match(bot, /handleTelegramWizardMessage[\s\S]*getTelegramUserLocaleOrDefault\(senderId\)/);
});

test('path cancellation replies in the recipient locale', () => {
    assert.match(bot, /getTelegramUserLocaleOrDefault\(senderId\)[\s\S]*path\.toast\.cancelled/);
    assert.equal(t('zh-CN', 'path.toast.cancelled'), '已取消保存路径设置。');
    assert.equal(t('en', 'path.toast.cancelled'), 'Save location setup cancelled.');
});
test('English telegramBot resources contain no Chinese fallback text', () => {
    const keys = localeResourceKeys('en').filter(key => key.startsWith('bot.'));
    assert.ok(keys.length >= 80, `expected comprehensive bot catalog, found ${keys.length}`);
    for (const key of keys) {
        const value = resources.en[key as keyof typeof resources.en];
        assert.doesNotMatch(value, /[\u3400-\u9fff]/, key);
    }
});
