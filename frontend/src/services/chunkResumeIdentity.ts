export interface ResumeIdentity {
    totalSize: number;
    maxChunkBytes: number;
    uploadedChunks: number[];
    uploadedChunkHashes: Record<number, string>;
}

export async function sha256Hex(blob: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyResumeFileIdentity(file: Blob, session: ResumeIdentity): Promise<void> {
    if (file.size !== session.totalSize) throw new Error('所选文件的大小与原上传任务不一致');
    for (const index of session.uploadedChunks) {
        const expected = session.uploadedChunkHashes[index];
        if (!expected) throw new Error('上传会话缺少已接收分块的身份信息，请取消后重新上传');
        const start = index * session.maxChunkBytes;
        const actual = await sha256Hex(file.slice(start, Math.min(file.size, start + session.maxChunkBytes)));
        if (actual !== expected) throw new Error('所选文件内容与原上传任务不一致');
    }
}