import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

const scopes = new AsyncLocalStorage<Set<string>>();
const activePaths = new Set<string>();

export function isTemporaryUploadFileActive(filePath: string): boolean {
    return activePaths.has(path.resolve(filePath));
}

export function protectTemporaryUploadFile(filePath: string): void {
    const scope = scopes.getStore();
    if (!scope) throw new Error('Temporary upload file requires an owning transfer scope');
    const resolvedPath = path.resolve(filePath);
    scope.add(resolvedPath);
    activePaths.add(resolvedPath);
}

/** UUID paths belong to one attempt, including pauses, cloud writes and settlement. */
export function withTemporaryUploadFiles<T>(operation: () => Promise<T>): Promise<T> {
    const paths = new Set<string>();
    return scopes.run(paths, async () => {
        try {
            return await operation();
        } finally {
            for (const filePath of paths) activePaths.delete(filePath);
        }
    });
}
