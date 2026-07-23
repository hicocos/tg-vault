import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { GoogleDriveStorageProvider } from './storage.js';
import { MediaSourceMissingError } from './mediaProxyError.js';

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

test('Google Drive refuses media reads when metadata says the source is trashed', async () => {
    let mediaRequested = false;
    const provider = providerWithDrive(async (params: any) => {
        if (params.alt === 'media') {
            mediaRequested = true;
            return { data: new PassThrough() };
        }
        return { data: { id: 'file-id', trashed: true } };
    });

    await assert.rejects(
        () => provider.getFileStream('file-id'),
        (error: unknown) => error instanceof MediaSourceMissingError && error.reason === 'trashed',
    );
    assert.equal(mediaRequested, false);
});

test('Google Drive maps metadata 404 to a missing media source', async () => {
    const provider = providerWithDrive(async () => {
        const error: any = new Error('File not found');
        error.code = 404;
        throw error;
    });

    await assert.rejects(
        () => provider.getFileAvailability('file-id'),
        (error: unknown) => error instanceof MediaSourceMissingError && error.reason === 'not_found',
    );
});

test('Google Drive reads media only after metadata confirms the source is active', async () => {
    const calls: any[] = [];
    const provider = providerWithDrive(async (params: any, options?: any) => {
        calls.push({ params, options });
        if (params.alt === 'media') return { data: new PassThrough() };
        return { data: { id: 'file-id', trashed: false } };
    });

    await provider.getFileStream('file-id', { range: 'bytes=0-1023' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].params.fields, 'id,trashed');
    assert.equal(calls[1].params.alt, 'media');
    assert.deepEqual(calls[1].options.headers, { Range: 'bytes=0-1023' });
});
