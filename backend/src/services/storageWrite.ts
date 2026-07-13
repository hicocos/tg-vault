import type { IStorageProvider } from './storage.js';

export interface IndexedWriteResult {
    savedPath: string;
    fileId: string;
}

export async function compensateIndexedWriteAfterCancel(input: {
    fileId: string;
    savedPath: string;
    deleteIndex: (fileId: string) => Promise<boolean>;
    deleteObject: (savedPath: string) => Promise<void>;
}): Promise<{ status: 'compensated' | 'reconciliation-required'; error?: string }> {
    try {
        await input.deleteObject(input.savedPath);
        const indexDeleted = await input.deleteIndex(input.fileId);
        if (!indexDeleted) throw new Error('数据库索引补偿影响 0 行');
        return { status: 'compensated' };
    } catch (error) {
        return {
            status: 'reconciliation-required',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function saveAndIndexWithCompensation(
    provider: IStorageProvider,
    tempPath: string,
    storedName: string,
    mimeType: string,
    folder: string | null | undefined,
    indexStoredObject: (storedPath: string) => Promise<void>,
): Promise<string> {
    const storedPath = await provider.saveFile(tempPath, storedName, mimeType, folder);
    try {
        await indexStoredObject(storedPath);
        return storedPath;
    } catch (error) {
        try {
            await provider.deleteFile(storedPath);
        } catch (cleanupError) {
            console.error(`存储索引失败后回滚对象失败: ${storedPath}`, cleanupError);
        }
        throw error;
    }
}
