import assert from 'node:assert/strict';
import test from 'node:test';
import { Api } from 'telegram';
import bigInt from 'big-integer';
import { getTelegramMessagesWithAccess, getTelegramForwardedMessage } from '../src/services/telegramScanAccount.js';
import { TelegramUserClientPool, classifyTelegramDownloadAccountError } from '../src/services/telegramUserClientPool.js';
import type { TelegramAccountSourceAccessRecord, TelegramUserAccountRecord } from '../src/services/telegramAccountRepository.js';
import { TelegramAccountRepository } from '../src/services/telegramAccountRepository.js';
import { withTelegramOperationSignal } from '../src/services/telegramOperationContext.js';

const source = new Api.PeerChannel({ channelId: bigInt(2603170959) });
const missingEntity = () => new Error('Could not find the input entity for PeerChannel 2603170959');
const file = new Api.Message({ id: 1076, peerId: source, date: 1, message: 'archive', media: new Api.MessageMediaDocument() });

function coldAccount(member: boolean) {
    let loaded = false;
    let dialogLoads = 0;
    const client = {
        session: {},
        async getMessages() { if (!loaded || !member) throw missingEntity(); return [file]; },
        async getEntity() { throw missingEntity(); },
        async invoke() { throw new Error('Unexpected membership RPC'); },
        async *iterDialogs() { dialogLoads++; await Promise.resolve(); loaded = true; },
    };
    return { client: client as unknown as Parameters<typeof getTelegramMessagesWithAccess>[0], loads: () => dialogLoads };
}

test('joined channel remains readable after session entity cache is lost', async () => {
    const first = coldAccount(true);
    assert.equal((await getTelegramMessagesWithAccess(first.client, source, { ids: [1076] }))[0].id, 1076);
    const restarted = coldAccount(true);
    assert.equal((await getTelegramMessagesWithAccess(restarted.client, source, { ids: [1076] }))[0].id, 1076);
    assert.equal(restarted.loads(), 1);
});

test('concurrent misses share dialog recovery, and repeated missing sources do not reload dialogs', async () => {
    const account = coldAccount(false);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => getTelegramMessagesWithAccess(account.client, source, { ids: [1076] })));
    assert.ok(results.every(result => result.status === 'rejected'));
    await assert.rejects(getTelegramMessagesWithAccess(account.client, source, { ids: [1076] }), /input entity/);
    assert.equal(account.loads(), 1);
});

test('failed entity recovery can be retried without caching a failed refresh', async () => {
    const account = coldAccount(true);
    const original = account.client.iterDialogs;
    account.client.iterDialogs = function* () { throw new Error('RPC_CALL_FAIL'); } as typeof original;
    await assert.rejects(getTelegramMessagesWithAccess(account.client, source, { ids: [1076] }), /RPC_CALL_FAIL/);
    account.client.iterDialogs = original;
    assert.equal((await getTelegramMessagesWithAccess(account.client, source, { ids: [1076] }))[0].id, 1076);
});

test('cancelling a cold lookup does not fetch dialog history', async () => {
    const account = coldAccount(true);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(withTelegramOperationSignal(controller.signal, () => getTelegramMessagesWithAccess(account.client, source, { ids: [1076] })), /cancelled/);
    assert.equal(account.loads(), 0);
});

test('public forward uses the selected account to resolve the username without reusing Bot access hashes', async () => {
    const account = coldAccount(false);
    const channel = new Api.Channel({ id: source.channelId, accessHash: bigInt(101), title: 'Source', username: 'source_channel', photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true, left: true });
    const local = new Api.Channel({ ...channel, accessHash: bigInt(202) });
    account.client.getEntity = async input => { assert.equal(input, '@source_channel'); return local; };
    account.client.getMessages = (async input => {
        if (input === '@source_channel') return [file];
        throw missingEntity();
    }) as typeof account.client.getMessages;
    const forwarded = new Api.Message({ id: 664, peerId: new Api.PeerUser({ userId: bigInt(1) }), date: 1, message: '', fwdFrom: new Api.MessageFwdHeader({ date: 1, fromId: source, channelPost: 1076 }) });
    assert.equal((await getTelegramForwardedMessage({ getEntity: async () => channel } as Parameters<typeof getTelegramForwardedMessage>[0], account.client, forwarded))?.id, 1076);
});

test('a reassigned public username cannot redirect a forwarded download to another channel', async () => {
    const account = coldAccount(false);
    const channel = new Api.Channel({ id: source.channelId, accessHash: bigInt(101), title: 'Source', username: 'source_channel', photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true });
    account.client.getEntity = async () => new Api.Channel({ ...channel, id: bigInt(999), accessHash: bigInt(202) });
    const forwarded = new Api.Message({ id: 664, peerId: source, date: 1, message: '', fwdFrom: new Api.MessageFwdHeader({ date: 1, fromId: source, channelPost: 1076 }) });
    await assert.rejects(getTelegramForwardedMessage({ getEntity: async () => channel } as Parameters<typeof getTelegramForwardedMessage>[0], account.client, forwarded), /TELEGRAM_FORWARD_SOURCE_MISMATCH/);
});

test('legacy entity-resolution denials are unknown, while actual permission denials remain denied', async () => {
    const now = new Date();
    const repository = new TelegramAccountRepository({ async query() { return { rows: [
        { account_id: 'unresolved', source_key: '2603170959', scope: 'download', access_state: 'denied', last_error: missingEntity().message, checked_at: now },
        { account_id: 'private', source_key: '2603170959', scope: 'download', access_state: 'denied', last_error: 'CHANNEL_PRIVATE', checked_at: now },
    ] }; } }, () => now);
    const access = await repository.listSourceAccess('2603170959', 'download');
    assert.deepEqual(access.map(row => [row.accountId, row.accessState]), [['unresolved', 'unknown'], ['private', 'denied']]);
});

function poolFixture(count: number) {
    const access = new Map<string, TelegramAccountSourceAccessRecord>();
    const accounts: TelegramUserAccountRecord[] = Array.from({ length: count }, (_, i) => ({
        id: `account-${i}`, telegramUserId: String(i + 1), username: null, displayName: `Account ${i}`,
        session: 'session', enabled: true, healthState: 'healthy', cooldownUntil: null, weight: 1, priority: 0,
        maxConnections: 4, lastError: null, isLegacy: false,
    }));
    const repo = {
        async migrateLegacySystemSettings() { return null; },
        async listEnabledAccounts() { return accounts; },
        async getAccount(id: string) { return accounts.find(a => a.id === id) || null; },
        async listSourceAccess() { return [...access.values()]; },
        async updateSession() { return true; },
        async recordHealthy() { return true; },
        async recordFailure() { return true; },
        async markSessionExpired() { return true; },
        async markCooldown() { return true; },
        async markSourceAccess(accountId: string, sourceKey: string, scope: TelegramAccountSourceAccessRecord['scope'], accessState: TelegramAccountSourceAccessRecord['accessState'], lastError: string | null = null) {
            const row = { accountId, sourceKey, scope, accessState, lastError, checkedAt: new Date() };
            access.set(accountId, row);
            return row;
        },
    };
    const pool = new TelegramUserClientPool({
        repository: repo, decryptSession: value => value,
        createClient: () => ({ connected: true, async connect() {}, async checkAuthorization() { return true; }, async getMe() { return {}; }, async disconnect() {}, async destroy() {} }),
    });
    return { pool, access };
}

test('entity lookup failure does not claim Telegram denied access', () => {
    assert.notEqual(classifyTelegramDownloadAccountError(missingEntity()), 'permission_denied');
    assert.equal(classifyTelegramDownloadAccountError(new Error('CHANNEL_PRIVATE')), 'permission_denied');
});

test('source discovery reaches a readable fourth account instead of exhausting download retries', async () => {
    const { pool, access } = poolFixture(4);
    await pool.initialize({ apiId: 1, apiHash: 'hash' });
    const visited: string[] = [];
    const result = await pool.withAccount('2603170959', 'download', async (_client, id) => {
        visited.push(id);
        if (id !== 'account-3') throw missingEntity();
        return file.id;
    });
    assert.equal(result, 1076);
    assert.deepEqual(visited, ['account-0', 'account-1', 'account-2', 'account-3']);
    assert.ok([...access.values()].every(row => row.accessState === 'unknown'));
});

test('real permission denials exclude accounts without consuming network retry allowance', async () => {
    const { pool, access } = poolFixture(4);
    await pool.initialize({ apiId: 1, apiHash: 'hash' });
    assert.equal(await pool.withAccount('2603170959', 'download', async (_client, id) => {
        if (id !== 'account-3') throw new Error('CHANNEL_PRIVATE');
        return file.id;
    }), 1076);
    assert.ok([...access.values()].every(row => row.accessState === 'denied'));
});

test('transient network replay remains capped at three accounts', async () => {
    const { pool } = poolFixture(4);
    await pool.initialize({ apiId: 1, apiHash: 'hash' });
    const visited: string[] = [];
    await assert.rejects(pool.withAccount('2603170959', 'download', async (_client, id) => {
        visited.push(id);
        throw new Error('TIMEOUT');
    }), /TIMEOUT/);
    assert.equal(visited.length, 3);
});
