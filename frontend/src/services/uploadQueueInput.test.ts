import test from 'node:test';
import assert from 'node:assert/strict';
import { attachUploadSession, createUploadQueueInput } from './uploadQueueInput.js';

test('queued upload freezes provider, account, and folder at enqueue time', () => {
    const target = { provider: 'googledrive', accountId: 'account-a', accountName: 'Drive A', folder: 'original' };
    const input = createUploadQueueInput({ id: 'item' }, 'queued-folder', target);

    target.provider = 'onedrive';
    target.accountId = 'account-b';
    target.folder = 'changed';

    assert.deepEqual(input.target, {
        provider: 'googledrive',
        accountId: 'account-a',
        accountName: 'Drive A',
        folder: 'queued-folder',
    });
});

test('new chunk session is retained on the queue input so retry resumes it', () => {
    const input = createUploadQueueInput({ id: 'item' }, null, { provider: 'local', accountId: null });
    const session = { uploadId: 'upload-1' };
    attachUploadSession(input, session);
    assert.equal(input.resumeSession, session);
});