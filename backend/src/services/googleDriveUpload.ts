import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord } from '../utils/typeGuards.js';
import type { StorageUploadProgress } from './storage/contracts.js';
import { trackUploadProgress } from './storage/uploadProgress.js';

function uploadErrorStatus(error: unknown): number {
    if (!isRecord(error)) return 0;
    const value = isRecord(error.response) ? error.response.status : error.status ?? error.code;
    return typeof value === 'number' || typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : 0;
}

/** Retry only the same preallocated Drive ID, reopening the local stream each time. */
export async function uploadGoogleDriveFile(input: {
    tempPath: string;
    fileId: string;
    fileName: string;
    folderId: string;
    create: (body: fs.ReadStream) => Promise<{ id?: string | null }>;
    inspect: () => Promise<{ id?: string | null; name?: string | null; size?: string | null; md5Checksum?: string | null; parents?: string[] | null; trashed?: boolean | null }>;
    signal?: AbortSignal;
    onProgress?: StorageUploadProgress;
}): Promise<string> {
    let firstError: unknown;
    let failed = false;
    let checksum: string | undefined;
    const totalBytes = input.onProgress ? (await fs.promises.stat(input.tempPath)).size : 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        input.signal?.throwIfAborted();
        const body = trackUploadProgress(fs.createReadStream(input.tempPath, { signal: input.signal }), totalBytes, input.onProgress);
        try {
            const result = await input.create(body);
            input.signal?.throwIfAborted();
            if (result.id !== input.fileId) throw new Error('Google Drive upload returned an unexpected file ID');
            input.onProgress?.(totalBytes, totalBytes);
            return input.fileId;
        } catch (error) {
            body.destroy();
            input.signal?.throwIfAborted();
            if (!failed) { firstError = error; failed = true; }
            const status = uploadErrorStatus(error);
            const conflict = status === 409;
            const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
            const transient = status === 408 || status === 429 || status >= 500 && status <= 599
                || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(code);
            if (conflict || transient) {
                try {
                    const remote = await input.inspect();
                    const { size } = await fs.promises.stat(input.tempPath);
                    if (!remote.trashed && remote.id === input.fileId && remote.name === input.fileName
                        && Number(remote.size) === size && remote.parents?.includes(input.folderId) && remote.md5Checksum) {
                        if (!checksum) {
                            const hash = createHash('md5');
                            const source = fs.createReadStream(input.tempPath);
                            try { for await (const chunk of source) { input.signal?.throwIfAborted(); hash.update(chunk); } }
                            finally { source.destroy(); }
                            checksum = hash.digest('hex');
                        }
                        if (checksum === remote.md5Checksum) {
                            input.onProgress?.(size, size);
                            return input.fileId;
                        }
                    }
                } catch { input.signal?.throwIfAborted(); }
            }
            if (!transient || attempt === 2) throw firstError;
        } finally {
            body.destroy();
        }
        await delay(30_000 * (attempt + 1), undefined, { signal: input.signal });
    }
    throw firstError;
}
