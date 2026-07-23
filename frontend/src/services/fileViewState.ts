export type FileViewStateKind = 'empty-root' | 'empty-folder' | 'empty-search' | 'empty-filter' | 'offline' | 'error' | 'stale';

export interface FileViewStateInput {
    folder: string | null;
    query: string;
    category: string;
    error: string | null;
    stale: boolean;
}

export interface FileViewState {
    kind: FileViewStateKind;
    canRetry: boolean;
}

export function describeFileViewState(input: FileViewStateInput): FileViewState {
    if (input.error) {
        if (input.stale) return { kind: 'stale', canRetry: true };
        const offline = input.error === 'NETWORK_OFFLINE' || /network|failed to fetch|offline|网络/i.test(input.error);
        return { kind: offline ? 'offline' : 'error', canRetry: true };
    }
    if (input.query.trim()) return { kind: 'empty-search', canRetry: false };
    if (input.folder) return { kind: 'empty-folder', canRetry: false };
    if (input.category !== 'all') return { kind: 'empty-filter', canRetry: false };
    return { kind: 'empty-root', canRetry: false };
}
