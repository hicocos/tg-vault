import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zh from '../../locales/zh-CN/index';
import en from '../../locales/en/index';

const panelUrl = new URL('./TelegramUserAccountsPanel.tsx', import.meta.url);

test('Telegram accounts panel presents method-choice multi-account management and scheduling copy', () => {
    const panel = fs.readFileSync(panelUrl, 'utf8');
    for (const key of [
        'title', 'add', 'login.qr', 'login.usePhone', 'login.passwordLabel',
        'account.disable', 'account.enable', 'account.delete', 'summary.permissions', 'scheduling.title',
    ]) {
        const path = `management.telegramAccounts.${key}`;
        assert.match(panel, new RegExp(`t\\(['\"]${path.replaceAll('.', '\\.')}['\"]`), path);
        const read = (catalog: Record<string, unknown>) => path.split('.').reduce<unknown>((value, segment) => (value as Record<string, unknown>)[segment], catalog);
        assert.equal(typeof read(zh), 'string', `missing zh-CN ${path}`);
        assert.equal(typeof read(en), 'string', `missing en ${path}`);
        assert.notEqual(read(zh), read(en), `${path} must be localized`);
    }
    assert.doesNotMatch(panel, /停用（保留登录）/);
    assert.doesNotMatch(panel, /解除绑定/);
    assert.doesNotMatch(panel, /检测权限/);
    assert.doesNotMatch(panel, /checkTelegramUserAccountPermissions/);
    assert.match(panel, /QRCodeSVG/);
    assert.match(panel, /<Dialog/);
    assert.match(panel, /getTelegramUserLoginStatus/);
    assert.match(panel, /window\.setTimeout/);
});

test('QR secret is only supplied to the QR renderer and is never printed as text', () => {
    const panel = fs.readFileSync(panelUrl, 'utf8');
    assert.match(panel, /<QRCodeSVG[^>]*value=\{[^}]*qrCode[^}]*\}/s);
    assert.doesNotMatch(panel, />\s*\{[^}]*qrCode[^}]*\}\s*</s);
    assert.doesNotMatch(panel, /console\.(?:log|info|debug|warn|error)/);
});

test('SettingsPage integrates the extracted panel instead of owning login secrets', () => {
    const settings = fs.readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
    assert.match(settings, /TelegramUserAccountsPanel/);
    assert.doesNotMatch(settings, /telegramUserPhone|telegramUserCode|telegramUserPassword|telegramUserFlowId/);
});
