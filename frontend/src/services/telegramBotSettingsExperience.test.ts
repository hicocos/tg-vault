import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

test('Telegram bot credentials are write-only in the web settings experience', () => {
    assert.match(settings, /settings\.remaining\.copy\.024/);
    assert.match(settings, /type="password" autoComplete="new-password"/);
    assert.match(settings, /settings\.remaining\.copy\.338/);
    assert.match(settings, /settings\.remaining\.copy\.026/);
    assert.match(settings, /settings\.remaining\.copy\.327/);
    assert.match(settings, /settings\.remaining\.copy\.326/);
    assert.match(settings, /handleCancelTelegramBotEdit/);
    assert.match(settings, /settings\.remaining\.copy\.031/);
    assert.match(settings, /settings\.remaining\.copy\.324/);
    assert.match(settings, /settings\.remaining\.copy\.028/);
    assert.match(settings, /settings\.remaining\.copy\.325/);
    assert.match(settings, /settings\.remaining\.copy\.342/);
    assert.match(settings, /verificationMethod/);
    assert.match(api, /changeTelegramBotPin/);
    assert.match(settings, /settings\.remaining\.copy\.164/);
    assert.match(settings, /cancelLabel: t\('settings\.remaining\.copy\.167'\), confirmLabel: t\('settings\.remaining\.copy\.168'\)/);
    assert.match(settings, /settings\.remaining\.copy\.027/);
    assert.doesNotMatch(settings, />停用<|handleDisableTelegramBot/);
    assert.match(settings, /grid-cols-3/);
    assert.ok((settings.match(/whitespace-nowrap/g) || []).length >= 3);
    assert.match(settings, /text-\[11px\]/);
    assert.doesNotMatch(settings, /Bot 离线时将应用标记为未就绪/);
    assert.match(settings, /enabled: true, required: false/);
    assert.match(api, /getTelegramBotConfig/);
    assert.match(api, /testTelegramBotConfig/);
    assert.match(api, /saveTelegramBotConfig/);
    assert.doesNotMatch(api, /botToken\?:|apiHash\?:|apiId\?:/);
});
