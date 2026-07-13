import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleDriveStorageProvider } from './storage.js';

function createProvider(permissionCalls: unknown[]) {
    const provider = new GoogleDriveStorageProvider(
        'account-id',
        'client-id',
        'client-secret',
        'refresh-token',
        'http://localhost/callback',
    );
    (provider as any).oauth2Client = {
        getAccessToken: async () => ({ token: 'access-token', res: { data: { expiry_date: Date.now() + 60_000 } } }),
    };
    (provider as any).drive = {
        permissions: {
            create: async (params: unknown) => {
                permissionCalls.push(params);
                return { data: { id: 'permission-id' } };
            },
        },
        files: {
            get: async () => ({ data: { webViewLink: 'https://drive.example/file' } }),
        },
    };
    return provider;
}

test('Google Drive rejects password before creating a public permission', async () => {
    const permissionCalls: unknown[] = [];
    const provider = createProvider(permissionCalls);

    const result = await provider.createShareLink('file-id', 'secret');

    assert.equal(result.link, '');
    assert.match(result.error || '', /不支持.*密码/);
    assert.equal(permissionCalls.length, 0);
});

test('Google Drive rejects expiration before creating a public permission', async () => {
    const permissionCalls: unknown[] = [];
    const provider = createProvider(permissionCalls);

    const result = await provider.createShareLink('file-id', undefined, '2026-07-20T00:00:00.000Z');

    assert.equal(result.link, '');
    assert.match(result.error || '', /不支持.*过期/);
    assert.equal(permissionCalls.length, 0);
});
