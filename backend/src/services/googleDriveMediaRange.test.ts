import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { GoogleDriveStorageProvider } from './storage.js';

test('Google Drive media reads forward the requested byte range', async () => {
    const provider = new GoogleDriveStorageProvider(
        'account-id',
        'client-id',
        'client-secret',
        'refresh-token',
        'http://localhost/callback',
    );
    let requestOptions: Record<string, unknown> | undefined;
    (provider as any).oauth2Client = {
        getAccessToken: async () => ({ token: 'access-token', res: { data: { expiry_date: Date.now() + 3600_000 } } }),
    };
    (provider as any).drive = {
        files: {
            get: async (_params: unknown, options: Record<string, unknown>) => {
                requestOptions = options;
                return { data: new PassThrough() };
            },
        },
    };

    await provider.getFileStream('file-id', { range: 'bytes=0-1023' });

    assert.deepEqual(requestOptions, {
        responseType: 'stream',
        headers: { Range: 'bytes=0-1023' },
    });
});
