import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../components/pages/TelegramUserAccountsPanel.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

const loginUi = settings + panel;

test('Settings provides a login-method choice before QR or phone authentication', () => {
    for (const copy of ['添加 Telegram 用户账号', '选择登录方式', '下一步', '二维码登录', '改用手机号', '手机号', '验证码', '两步验证密码', '验证码已发送', '账号已绑定并自动启用']) {
        assert.match(loginUi, new RegExp(copy));
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
    assert.match(panel, /已停用，不会执行账号级下载/);
});

test('frontend exposes account status, retaining disable and destructive account deletion without account secret fields', () => {
    for (const method of ['getTelegramUserAccounts', 'startTelegramUserQrLogin', 'startTelegramUserPhoneLogin', 'submitTelegramUserLoginCode', 'submitTelegramUserLoginPassword', 'setTelegramUserAccountEnabled', 'unlinkTelegramUserAccountById']) {
        assert.match(api, new RegExp(method));
    }
    assert.match(panel, />停用<\/Button>/);
    assert.match(panel, /删除账号/);
    assert.doesNotMatch(panel, /停用（保留登录）|解除绑定|检测权限/);
    assert.match(panel, /已加密保存的登录信息/);
    const accountMethods = api.slice(api.indexOf('async getTelegramUserAccounts'), api.indexOf('async getTelegramUserAccount'));
    assert.doesNotMatch(accountMethods, /phoneCodeHash|StringSession|apiHash/);
});
