import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const panelUrl = new URL('./TelegramUserAccountsPanel.tsx', import.meta.url);

test('Telegram accounts panel presents method-choice multi-account management and scheduling copy', () => {
    const panel = fs.readFileSync(panelUrl, 'utf8');
    for (const copy of [
        'Telegram 用户账号',
        '添加账号',
        '二维码登录',
        '改用手机号',
        '两步验证密码',
        '停用',
        '重新启用',
        '删除账号',
        '权限汇总',
        '智能调度',
    ]) {
        assert.match(panel, new RegExp(copy));
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
