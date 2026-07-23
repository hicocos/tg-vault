import type { UploadTargetSnapshot } from './api.js';

export interface UploadQueueInput<TItem, TSession = unknown> {
    item: TItem;
    folder?: string;
    target: UploadTargetSnapshot;
    resumeSession?: TSession;
}

export function createUploadQueueInput<TItem, TSession = unknown>(
    item: TItem,
    folder: string | null | undefined,
    target: UploadTargetSnapshot,
): UploadQueueInput<TItem, TSession> {
    return {
        item,
        folder: folder || undefined,
        target: {
            provider: target.provider,
            accountId: target.accountId,
            accountName: target.accountName ?? null,
            folder: folder ?? target.folder ?? null,
        },
    };
}

export function attachUploadSession<TItem, TSession>(input: UploadQueueInput<TItem, TSession>, session: TSession): void {
    input.resumeSession = session;
}