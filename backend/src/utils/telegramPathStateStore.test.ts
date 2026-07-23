import assert from 'node:assert/strict';
import test from 'node:test';
import { clearTelegramPathStateRows, consumeTelegramOncePath, getTelegramSessionPath, setTelegramPathStateRow } from './telegramPathStateStore.js';

test('once path is atomically consumed with DELETE RETURNING', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const folder = await consumeTelegramOncePath(async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [{ folder: 'PIXIV/每日Top50' }], rowCount: 1 } as any;
    }, '-100123');
    assert.equal(folder, 'PIXIV/每日Top50');
    assert.match(calls[0].sql, /DELETE FROM telegram_path_states/);
    assert.match(calls[0].sql, /RETURNING folder/);
    assert.deepEqual(calls[0].params, ['-100123']);
});

test('path setters persist chat scope, mode and expiry while clear removes both modes', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const run = async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 } as any;
    };
    await setTelegramPathStateRow(run, '-99', 'session', '相册/2026-07', new Date('2026-07-29T00:00:00Z'));
    await clearTelegramPathStateRows(run, '-99');
    assert.match(calls[0].sql, /ON CONFLICT \(chat_id, mode\)/);
    assert.deepEqual(calls[0].params.slice(0, 3), ['-99', 'session', '相册/2026-07']);
    assert.match(calls[1].sql, /DELETE FROM telegram_path_states WHERE chat_id = \$1/);
});

test('expired session path is not returned', async () => {
    const folder = await getTelegramSessionPath(async () => ({ rows: [], rowCount: 0 } as any), '42');
    assert.equal(folder, null);
});
