import { sha256Hex } from './chunkHash.js';
import { tr } from '../i18n/runtime';

export { sha256Hex } from './chunkHash.js';

export interface ResumeIdentity {
    totalSize: number;
    maxChunkBytes: number;
    uploadedChunks: number[];
    uploadedChunkHashes: Record<number, string>;
}

export async function verifyResumeFileIdentity(file: Blob, session: ResumeIdentity): Promise<void> {
    if (file.size !== session.totalSize) throw new Error(tr('errors.services.upload.resumeSizeMismatch'));
    for (const index of session.uploadedChunks) {
        const expected = session.uploadedChunkHashes[index];
        if (!expected) throw new Error(tr('errors.services.upload.resumeIdentityMissing'));
        const start = index * session.maxChunkBytes;
        const actual = await sha256Hex(file.slice(start, Math.min(file.size, start + session.maxChunkBytes)));
        if (actual !== expected) throw new Error(tr('errors.services.upload.resumeContentMismatch'));
    }
}