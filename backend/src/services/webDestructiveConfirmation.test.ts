import assert from 'node:assert/strict';
import test from 'node:test';
import { WebDestructiveConfirmationStore } from './webDestructiveConfirmation.js';

test('web destructive confirmation is actor/action/object bound and one-time', () => {
    let now = 1_000;
    const store = new WebDestructiveConfirmationStore(100, () => now);
    const issued = store.issue({ authToken: 'session-a', action: 'delete_file', objectId: 'file-a' });
    assert.equal(store.consume(issued.confirmationToken, { authToken: 'session-b', action: 'delete_file', objectId: 'file-a' }).status, 'mismatch');
    assert.equal(store.consume(issued.confirmationToken, { authToken: 'session-a', action: 'delete_storage_account', objectId: 'file-a' }).status, 'mismatch');
    assert.equal(store.consume(issued.confirmationToken, { authToken: 'session-a', action: 'delete_file', objectId: 'file-b' }).status, 'mismatch');
    assert.equal(store.consume(issued.confirmationToken, { authToken: 'session-a', action: 'delete_file', objectId: 'file-a' }).status, 'ok');
    assert.equal(store.consume(issued.confirmationToken, { authToken: 'session-a', action: 'delete_file', objectId: 'file-a' }).status, 'missing');

    const expired = store.issue({ authToken: 'session-a', action: 'delete_storage_account', objectId: 'account-a' });
    now = 1_101;
    assert.equal(store.consume(expired.confirmationToken, { authToken: 'session-a', action: 'delete_storage_account', objectId: 'account-a' }).status, 'expired');

    const taskCancel = store.issue({ authToken: 'session-a', action: 'cancel_task', objectId: 'ytdlp:yd-a' });
    assert.equal(store.consume(taskCancel.confirmationToken, { authToken: 'session-a', action: 'cancel_task', objectId: 'ytdlp:yd-b' }).status, 'mismatch');
    assert.equal(store.consume(taskCancel.confirmationToken, { authToken: 'session-a', action: 'cancel_task', objectId: 'ytdlp:yd-a' }).status, 'ok');
    assert.equal(store.consume(taskCancel.confirmationToken, { authToken: 'session-a', action: 'cancel_task', objectId: 'ytdlp:yd-a' }).status, 'missing');

    const snapshotted = store.issue({ authToken: 'session-a', action: 'delete_storage_account', objectId: 'account-a', context: 'files-hash-a' });
    assert.equal(store.consume(snapshotted.confirmationToken, { authToken: 'session-a', action: 'delete_storage_account', objectId: 'account-a', context: 'files-hash-b' }).status, 'mismatch');
    assert.equal(store.consume(snapshotted.confirmationToken, { authToken: 'session-a', action: 'delete_storage_account', objectId: 'account-a', context: 'files-hash-a' }).status, 'ok');
});
