import assert from 'node:assert/strict';
import { StorageManager } from './storage.js';

const manager = StorageManager.getInstance();
const originalProvider = (manager as any).activeProvider;
const originalAccountId = (manager as any).activeAccountId;
const providerA = { name: 's3', saveFile: async () => '', getFileStream: async () => { throw new Error(); }, getPreviewUrl: async () => '', deleteFile: async () => undefined };
const providerB = { name: 'google_drive', saveFile: async () => '', getFileStream: async () => { throw new Error(); }, getPreviewUrl: async () => '', deleteFile: async () => undefined };

try {
    (manager as any).activeProvider = providerA;
    (manager as any).activeAccountId = 'account-a';
    const snapshot = manager.getActiveTarget();
    assert.equal(snapshot.provider, providerA);
    assert.equal(snapshot.accountId, 'account-a');
    assert.equal(snapshot.providerKey, 's3:account-a');

    (manager as any).activeProvider = providerB;
    (manager as any).activeAccountId = 'account-b';
    assert.equal(snapshot.provider, providerA);
    assert.equal(snapshot.accountId, 'account-a');
    assert.equal(snapshot.providerKey, 's3:account-a');
} finally {
    (manager as any).activeProvider = originalProvider;
    (manager as any).activeAccountId = originalAccountId;
}

console.log('storage target snapshot ok');
