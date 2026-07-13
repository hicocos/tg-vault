import assert from 'node:assert/strict';
import test from 'node:test';
import { BatchDeleteConfirmationStore } from './batchDeleteConfirmation.js';

const scopeA = { provider: 'google_drive', accountId: 'account-a' };
const scopeB = { provider: 'google_drive', accountId: 'account-b' };
const ids = [
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
];

test('confirmation is bound to auth token hash, storage scope, and immutable sorted IDs', () => {
    let now = 1_000;
    const store = new BatchDeleteConfirmationStore({
        now: () => now,
        ttlMs: 500,
        tokenFactory: () => 'confirm-token',
    });

    const issued = store.issue({ authToken: 'session-a', scope: scopeA, fileIds: ids });
    assert.equal(issued.confirmationToken, 'confirm-token');
    assert.equal(issued.expiresAt, 1_500);

    assert.equal(store.consume('confirm-token', { authToken: 'session-b', scope: scopeA }).status, 'mismatch');
    assert.equal(store.consume('confirm-token', { authToken: 'session-a', scope: scopeB }).status, 'mismatch');

    const consumed = store.consume('confirm-token', { authToken: 'session-a', scope: scopeA });
    assert.equal(consumed.status, 'ok');
    assert.deepEqual(consumed.confirmation?.fileIds, [ids[1], ids[0]]);
    assert.equal(store.consume('confirm-token', { authToken: 'session-a', scope: scopeA }).status, 'missing');
    void now;
});

test('expired confirmation cannot be consumed and is removed', () => {
    let now = 10_000;
    const store = new BatchDeleteConfirmationStore({ now: () => now, ttlMs: 100, tokenFactory: () => 'expires' });
    store.issue({ authToken: 'session-a', scope: scopeA, fileIds: ids });
    now = 10_101;

    assert.equal(store.consume('expires', { authToken: 'session-a', scope: scopeA }).status, 'expired');
    assert.equal(store.consume('expires', { authToken: 'session-a', scope: scopeA }).status, 'missing');
});

test('concurrent/replayed consumption permits exactly one execution', () => {
    const store = new BatchDeleteConfirmationStore({ tokenFactory: () => 'once' });
    store.issue({ authToken: 'session-a', scope: scopeA, fileIds: ids });

    const outcomes = [
        store.consume('once', { authToken: 'session-a', scope: scopeA }).status,
        store.consume('once', { authToken: 'session-a', scope: scopeA }).status,
    ];
    assert.deepEqual(outcomes, ['ok', 'missing']);
});
