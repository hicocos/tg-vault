import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zh from '../locales/zh-CN/index';
import en from '../locales/en/index';

const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../components/pages/TelegramUserAccountsPanel.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

const loginUi = settings + panel;

test('Settings provides a login-method choice before QR or phone authentication', () => {
    for (const key of ['title', 'chooseTitle', 'next', 'qr', 'usePhone', 'phoneLabel', 'codeLabel', 'passwordLabel', 'codeSent', 'completeTitle'] as const) {
        assert.match(loginUi, new RegExp(`t\\('management\\.telegramAccounts\\.login\\.${key}'`));
        assert.equal(typeof zh.management.telegramAccounts.login[key], 'string');
        assert.equal(typeof en.management.telegramAccounts.login[key], 'string');
        assert.notEqual(zh.management.telegramAccounts.login[key], en.management.telegramAccounts.login[key]);
    }
    assert.match(panel, /QRCodeSVG/);
    assert.match(panel, /autoComplete="one-time-code"/);
    assert.match(panel, /autoComplete="current-password"/);
    assert.match(panel, /type="password"/);
});

test('multi-account rows keep mobile actions readable and disabled state is not presented as an error', () => {
    assert.match(settings, /TelegramUserAccountsPanel/);
    assert.match(panel, /flex-col\s+gap-2\s+sm:flex-row/);
    assert.match(panel, /w-full\s+sm:w-auto/);
    assert.match(panel, /account\.enabled\s*\?/);
    assert.match(panel, /t\('management\.telegramAccounts\.account\.disabledHint'\)/);
    assert.match(zh.management.telegramAccounts.account.disabledHint, /已停用/);
    assert.match(en.management.telegramAccounts.account.disabledHint, /Disabled accounts/);
});

test('frontend exposes account status, retaining disable and destructive account deletion without account secret fields', () => {
    for (const method of ['getTelegramUserAccounts', 'startTelegramUserQrLogin', 'startTelegramUserPhoneLogin', 'submitTelegramUserLoginCode', 'submitTelegramUserLoginPassword', 'setTelegramUserAccountEnabled', 'unlinkTelegramUserAccountById']) {
        assert.match(api, new RegExp(method));
    }
    assert.match(panel, /t\('management\.telegramAccounts\.account\.disable'\)/);
    assert.match(panel, /t\('management\.telegramAccounts\.account\.delete'\)/);
    assert.doesNotMatch(panel, /停用（保留登录）|解除绑定|检测权限/);
    assert.match(panel, /t\('management\.telegramAccounts\.privacy'\)/);
    assert.match(zh.management.telegramAccounts.privacy, /登录信息|登录凭证|API 凭证/);
    assert.match(en.management.telegramAccounts.privacy, /credentials/i);
    const accountMethods = api.slice(api.indexOf('async getTelegramUserAccounts'), api.indexOf('async getTelegramUserAccount'));
    assert.doesNotMatch(accountMethods, /phoneCodeHash|StringSession|apiHash/);
});
