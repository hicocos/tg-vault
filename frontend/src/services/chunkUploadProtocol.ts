import { tr } from '../i18n/runtime';

export interface ChunkUploadInitContract {
    uploadId: string;
    maxChunkBytes: number;
    totalChunks: number;
}

export function parseChunkUploadInit(payload: unknown, totalSize: number): ChunkUploadInitContract {
    if (!payload || typeof payload !== 'object') throw new Error(tr('errors.services.upload.initInvalid'));
    const value = payload as Record<string, unknown>;
    const uploadId = typeof value.uploadId === 'string' ? value.uploadId : '';
    const maxChunkBytes = Number(value.maxChunkBytes);
    const totalChunks = Number(value.totalChunks);
    if (!uploadId || !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1 ||
        !Number.isSafeInteger(totalChunks) || totalChunks < 1 ||
        totalChunks !== Math.ceil(totalSize / maxChunkBytes)) {
        throw new Error(tr('errors.services.upload.initInvalid'));
    }
    return { uploadId, maxChunkBytes, totalChunks };
}

export function chunkBounds(totalSize: number, index: number, maxChunkBytes: number): { start: number; end: number } {
    const start = index * maxChunkBytes;
    return { start, end: Math.min(start + maxChunkBytes, totalSize) };
}
