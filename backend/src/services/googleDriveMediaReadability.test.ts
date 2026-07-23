import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { GoogleDriveStorageProvider } from './storage.js';

function providerWithDrive(get: (...args: any[]) => Promise<any>) {
    const provider = new GoogleDriveStorageProvider(
        'account-id', 'client-id', 'client-secret', 'refresh-token', 'http://localhost/callback',
    );
    (provider as any).oauth2Client = {
        getAccessToken: async () => ({ token: 'access-token', res: { data: { expiry_date: Date.now() + 3600_000 } } }),
    };
    (provider as any).drive = { files: { get } };
    return provider;
}

test('Google Drive readability probe requests only one byte after metadata validation', async () => {
    const calls: any[] = [];
    const stream = new PassThrough();
    const provider = providerWithDrive(async (params: any, options?: any) => {
        calls.push({ params, options });
        if (params.alt === 'media') return { data: stream };
        return { data: { id: 'file-id', trashed: false } };
    });

    await provider.probeFileReadable('file-id');

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].options.headers, { Range: 'bytes=0-0' });
    assert.equal(stream.destroyed, true);
});

test('Google Drive readability probe preserves download quota errors', async () => {
    const provider = providerWithDrive(async (params: any) => {
        if (params.alt !== 'media') return { data: { id: 'file-id', trashed: false } };
        throw new Error('reason: downloadQuotaExceeded');
    });

    await assert.rejects(() => provider.probeFileReadable('file-id'), /downloadQuotaExceeded/);
});
