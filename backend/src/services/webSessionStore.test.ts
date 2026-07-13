import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebSessionStore } from './webSessionStore.js';

const rows = new Map<string, { expiresAt: Date }>();
const store = createWebSessionStore({
    insert: async (hash, expiresAt) => { rows.set(hash, { expiresAt }); },
    find: async hash => rows.get(hash) || null,
    remove: async hash => { rows.delete(hash); },
});

test('raw session token is never persisted and survives store recreation', async () => {
    const issued = await store.issue(new Date(Date.now() + 60_000), () => Buffer.alloc(32, 7));
    assert.equal(rows.has(issued.token), false);
    assert.equal(await store.verify(issued.token, new Date()), true);
    const restarted = createWebSessionStore({
        insert: async () => undefined,
        find: async hash => rows.get(hash) || null,
        remove: async hash => { rows.delete(hash); },
    });
    assert.equal(await restarted.verify(issued.token, new Date()), true);
});

test('expired and revoked sessions fail closed', async () => {
    const expired = await store.issue(new Date(100), () => Buffer.alloc(32, 8));
    assert.equal(await store.verify(expired.token, new Date(101)), false);
    const live = await store.issue(new Date(1000), () => Buffer.alloc(32, 9));
    await store.revoke(live.token);
    assert.equal(await store.verify(live.token, new Date(500)), false);
});
