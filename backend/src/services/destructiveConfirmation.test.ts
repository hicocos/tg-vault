import assert from 'node:assert/strict';
import { DestructiveConfirmationStore } from './destructiveConfirmation.js';

function testConfirmationIsBoundAndConsumedOnce() {
    let now = 1_000;
    const store = new DestructiveConfirmationStore({ now: () => now, tokenFactory: () => 'token-1', ttlMs: 500 });
    const token = store.issue({ actorId: 7, chatId: 'chat-a', messageId: 99, action: 'delete_file', objectId: 'file-1' });

    assert.equal(store.consume(token, { actorId: 8, chatId: 'chat-a', messageId: 99, action: 'delete_file', objectId: 'file-1' }).status, 'mismatch');
    assert.equal(store.consume(token, { actorId: 7, chatId: 'chat-b', messageId: 99, action: 'delete_file', objectId: 'file-1' }).status, 'mismatch');
    assert.equal(store.consume(token, { actorId: 7, chatId: 'chat-a', messageId: 100, action: 'delete_file', objectId: 'file-1' }).status, 'mismatch');
    assert.equal(store.consume(token, { actorId: 7, chatId: 'chat-a', messageId: 99, action: 'clear_local_storage', objectId: 'file-1' }).status, 'mismatch');

    const consumed = store.consume(token, { actorId: 7, chatId: 'chat-a', messageId: 99, action: 'delete_file', objectId: 'file-1' });
    assert.equal(consumed.status, 'ok');
    assert.equal(consumed.confirmation?.objectId, 'file-1');
    assert.equal(store.consume(token, { actorId: 7, chatId: 'chat-a', messageId: 99, action: 'delete_file', objectId: 'file-1' }).status, 'missing');

    const expiring = store.issue({ actorId: 7, chatId: 'chat-a', messageId: 101, action: 'clear_local_storage' });
    now += 501;
    assert.equal(store.consume(expiring, { actorId: 7, chatId: 'chat-a', messageId: 101, action: 'clear_local_storage' }).status, 'expired');

    const expiringCancel = store.issue({ actorId: 7, chatId: 'chat-a', messageId: 102, action: 'clear_local_storage' });
    now += 501;
    assert.equal(store.cancel(expiringCancel, { actorId: 7, chatId: 'chat-a', messageId: 102, action: 'clear_local_storage' }), false);
    assert.equal(store.consume(expiringCancel, { actorId: 7, chatId: 'chat-a', messageId: 102, action: 'clear_local_storage' }).status, 'missing');
}

testConfirmationIsBoundAndConsumedOnce();
console.log('destructive confirmation ok');
