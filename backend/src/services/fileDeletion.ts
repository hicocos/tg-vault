export interface IndexedFile {
    id: string;
    name: string;
    path?: string | null;
    stored_name?: string | null;
    source?: string | null;
    storage_account_id?: string | null;
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
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function isPhysicalFileNotFound(error: unknown): boolean {
    const candidate = error as any;
    const status = Number(candidate?.status ?? candidate?.statusCode ?? candidate?.code ?? candidate?.response?.status);
    if (status === 404) return true;
    const code = String(candidate?.code || '').toUpperCase();
    return code === 'ENOENT' || code === 'NOT_FOUND' || code === 'NOSUCHKEY';
}

export function createFileDeletionService(dependencies: FileDeletionDependencies) {
    return {
        async deleteIndexedFile(file: IndexedFile): Promise<FileDeletionResult> {
            let physicalNotFound = false;
            try {
                await dependencies.removePhysicalFile(file);
            } catch (error) {
                if (!isPhysicalFileNotFound(error)) {
                    return { status: 'failed', error: errorMessage(error) };
                }
                physicalNotFound = true;
            }

            try {
                const deleted = await dependencies.deleteIndex(file.id);
                if (!deleted) {
                    return { status: 'failed', error: '文件索引删除失败或已发生并发变更' };
                }
            } catch (error) {
                return { status: 'failed', error: errorMessage(error) };
            }

            return { status: physicalNotFound ? 'not_found' : 'deleted' };
        },
    };
}
