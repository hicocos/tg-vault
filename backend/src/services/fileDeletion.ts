export interface IndexedFile {
    id: string;
    name: string;
    path?: string | null;
    stored_name?: string | null;
    source?: string | null;
    storage_account_id?: string | null;
    mime_type?: string | null;
    folder?: string | null;
    thumbnail_path?: string | null;
    preview_path?: string | null;
}

export type FileDeletionResult =
    | { status: 'deleted' }
    | { status: 'not_found' }
    | { status: 'failed'; error: string };

export interface FileDeletionDependencies {
    removePhysicalFile(file: IndexedFile): Promise<void>;
    deleteIndex(id: string): Promise<boolean>;
    onFailure?(error: unknown, stage: 'physical' | 'index'): void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function isPhysicalFileNotFound(error: unknown): boolean {
    const candidate = error as any;
    const status = Number(candidate?.status ?? candidate?.statusCode ?? candidate?.code ?? candidate?.response?.status);
    if (status === 404) return true;
    const code = String(candidate?.code || '').toUpperCase();
    if (code === 'ENOENT' || code === 'NOT_FOUND' || code === 'NOSUCHKEY') return true;
    const message = errorMessage(error);
    // Last-resort compatibility for legacy providers that discarded structured 404 metadata.
    return /(?:^|\D)404(?:\D|$).*not[\s_-]*found|not[\s_-]*found.*(?:^|\D)404(?:\D|$)/i.test(message);
}

export function createFileDeletionService(dependencies: FileDeletionDependencies) {
    return {
        async deleteIndexedFile(file: IndexedFile): Promise<FileDeletionResult> {
            const directoryPlaceholder = file.name === '.folder' && file.mime_type === 'application/x-directory';
            let physicalNotFound = false;
            try {
                await dependencies.removePhysicalFile(file);
            } catch (error) {
                if (!isPhysicalFileNotFound(error)) {
                    dependencies.onFailure?.(error, 'physical');
                    return { status: 'failed', error: errorMessage(error) };
                }
                physicalNotFound = true;
            }

            try {
                const deleted = await dependencies.deleteIndex(file.id);
                if (!deleted) {
                    dependencies.onFailure?.(Object.assign(new Error('File index changed during deletion'), { code: 'INDEX_CHANGED' }), 'index');
                    return { status: 'failed', error: '文件索引删除失败或已发生并发变更' };
                }
            } catch (error) {
                dependencies.onFailure?.(error, 'index');
                return { status: 'failed', error: errorMessage(error) };
            }

            return { status: physicalNotFound && !directoryPlaceholder ? 'not_found' : 'deleted' };
        },
    };
}
