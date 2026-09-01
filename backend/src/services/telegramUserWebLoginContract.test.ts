import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const route = fs.readFileSync(new URL('../routes/storage.ts', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('./telegramUserClient.ts', import.meta.url), 'utf8');
const cryptoSource = fs.readFileSync(new URL('../utils/credentialCrypto.ts', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const runtimeSource = fs.readFileSync(new URL('./telegramMultiAccountRuntime.ts', import.meta.url), 'utf8');

test('user-account login endpoints require Web admin auth, no-store, and an independent limiter', () => {
    assert.match(route, /telegramUserLoginLimiter\s*=\s*rateLimit/);
    for (const suffix of ['phone', 'code', 'password']) {
        assert.match(route, new RegExp(`router\\.post\\('\\/config\\/telegram-user\\/login\\/${suffix}',\\s*requireAuth,\\s*telegramUserLoginLimiter`));
    }
    assert.match(route, /getTelegramUserLoginSessionKey\(req\)/);
    assert.match(route, /Cache-Control.*no-store/);
});

test('StringSession is encrypted in settings, supports legacy-file migration, and is never returned', () => {
    assert.match(cryptoSource, /['"]telegram_user_session['"]/);
    assert.match(client, /TELEGRAM_USER_SESSION_SETTING/);
    assert.match(client, /migrateLegacyTelegramUserSession/);
    assert.match(client, /setSetting\(TELEGRAM_USER_SESSION_SETTING/);
    assert.match(client, /fs\.rmSync/);
    const telegramRoutes = route.slice(route.indexOf("router.get('/config/telegram-user'"), route.indexOf("router.post('/config/telegram-allowed-users'"));
    assert.doesNotMatch(telegramRoutes, /res\.json\([^)]*(?:phoneCodeHash|telegram_user_session|sessionString)/i);
});

test('a configured account blocks starting another login until it is unlinked', () => {
    const phoneRoute = route.slice(route.indexOf("router.post('/config/telegram-user/login/phone'"), route.indexOf("router.post('/config/telegram-user/login/code'"));
    assert.match(phoneRoute, /getTelegramUserAccountStatus/);
    assert.match(phoneRoute, /ACCOUNT_ALREADY_BOUND/);
    assert.match(phoneRoute, /409/);
});
test('explicit legacy enable requires a saved user session before initializing the pool', () => {
    const initializer = client.slice(client.indexOf('export async function initTelegramUserClient'), client.indexOf('async function persistAndActivate'));
    assert.match(initializer, /if \(!sessionString\)[\s\S]*return;[\s\S]*initializeTelegramMultiAccountRuntime/);
    assert.match(runtimeSource, /installTelegramMultiAccountRuntimeAdapters[\s\S]*initializeTelegramUserClientPool/);
});

test('disable retains the session, unlink deletes it, and both apply without a restart', () => {
    assert.match(route, /router\.post\('\/config\/telegram-user\/disable'/);
    assert.match(route, /disableTelegramUserAccount/);
    assert.match(route, /router\.delete\('\/config\/telegram-user'/);
    assert.match(route, /unlinkTelegramUserAccount/);
    assert.match(route, /ALREADY_DISABLED/);
    assert.match(route, /409/);
    assert.match(client, /deleteSettings\(\[TELEGRAM_USER_SESSION_SETTING/);
    const telegramRoutes = route.slice(route.indexOf("router.get('/config/telegram-user'"), route.indexOf("router.post('/config/telegram-allowed-users'"));
    assert.doesNotMatch(telegramRoutes, /重启后端|并重启/);
    assert.doesNotMatch(indexSource, /initTelegramUserClient\(/);
});
