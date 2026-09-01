import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const route = fs.readFileSync(new URL('../routes/storage.ts', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('./telegramMultiAccountRuntime.ts', import.meta.url), 'utf8');
const frontendApi = fs.readFileSync(new URL('../../../frontend/src/services/api.ts', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../../../frontend/src/components/pages/SettingsPage.tsx', import.meta.url), 'utf8');

test('multi-account API exposes account lifecycle, access checks and QR login behind admin auth', () => {
    for (const marker of [
        "/config/telegram-user/accounts'",
        "/config/telegram-user/accounts/:accountId'",
        "/config/telegram-user/accounts/:accountId/check'",
        "/config/telegram-user/access/check-all'",
        '/config/telegram-user/accounts/login/qr',
    ]) assert.match(route, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(route, /requireAuth/);
    assert.match(route, /telegramUserLoginLimiter/);
    assert.match(route, /noStore\(res\)/);
});

test('account sessions and QR tokens never appear in public API payload contracts', () => {
    const publicSlice = route.slice(route.indexOf("/config/telegram-user/accounts"), route.indexOf("/config/telegram-allowed-users"));
    assert.doesNotMatch(publicSlice, /session_ciphertext\s*:/i);
    assert.doesNotMatch(frontendApi, /sessionCiphertext|StringSession|phoneCodeHash/);
    assert.match(schema, /session_ciphertext TEXT NOT NULL/);
});

test('application restores only explicitly enabled user sessions instead of initializing merely because Bot credentials exist', () => {
    assert.match(index, /installTelegramMultiAccountRuntimeAdapters\(\)/);
    assert.match(index, /restoreEnabledTelegramUserAccountsAfterRestart\(\)/);
    assert.doesNotMatch(index, /initializeTelegramMultiAccountRuntime|initTelegramUserClientPool|initTelegramUserAccounts|initTelegramUserClient/);
    const userClient = fs.readFileSync(new URL('./telegramUserClient.ts', import.meta.url), 'utf8');
    const restore = userClient.slice(
        userClient.indexOf('export async function restoreEnabledTelegramUserAccountsAfterRestart'),
        userClient.indexOf('export async function activateTelegramUserAccount'),
    );
    assert.match(restore, /listEnabledAccounts\(\)/);
    assert.match(restore, /if \(enabledAccounts\.length === 0\) return/);
    assert.match(restore, /initializeTelegramMultiAccountRuntime\(credentials\)/);
});

test('adapter installation is side-effect free for saved sessions', () => {
    assert.match(runtime, /installTelegramMultiAccountRuntimeAdapters/);
    const installer = runtime.slice(runtime.indexOf('export async function installTelegramMultiAccountRuntimeAdapters'), runtime.indexOf('export async function initializeTelegramMultiAccountRuntime'));
    assert.doesNotMatch(installer, /initializeTelegramUserClientPool|listEnabledAccounts|\.connect\(|checkAuthorization|getMe/);
});

test('explicit account enable resolves API credentials before activating only that account', () => {
    const userClient = fs.readFileSync(new URL('./telegramUserClient.ts', import.meta.url), 'utf8');
    const activate = userClient.slice(
        userClient.indexOf('export async function activateTelegramUserAccount'),
        userClient.indexOf('async function persistAndActivate'),
    );
    assert.match(activate, /getTelegramUserCredentials\(\)/);
    assert.match(activate, /activateAccount\(accountId, 'explicit_enable', credentials\)/);
    assert.match(route, /activateTelegramUserAccount\(req\.params\.accountId\)/);
});

test('Web settings provide QR-first multi-account controls and permission summaries', () => {
    const ui = settings + fs.readFileSync(new URL('../../../frontend/src/components/pages/TelegramUserAccountsPanel.tsx', import.meta.url), 'utf8');
    for (const copy of ['添加账号', '二维码登录', '手机号登录', '权限汇总']) assert.match(ui, new RegExp(copy));
    assert.doesNotMatch(ui, /检测权限|权限检测/);
    assert.match(ui, /智能调度|智能均衡|智能负载均衡/);
    assert.match(ui, /可访问/);
    assert.match(ui, /不可访问|无权限/);
    for (const method of ['getTelegramUserAccounts', 'startTelegramUserQrLogin', 'getTelegramUserLoginStatus', 'setTelegramUserAccountEnabled']) assert.match(frontendApi, new RegExp(method));
});
