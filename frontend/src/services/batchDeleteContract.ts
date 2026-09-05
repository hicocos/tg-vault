import { tr } from '../i18n/runtime';

export interface BatchDeleteFailedFile {
    id: string;
    name: string;
    error: string;
}

export type BatchDeleteResult =
    | {
        status: 'complete';
        deletedIds: string[];
        failedFiles: [];
        message: string;
    }
    | {
        status: 'partial';
        deletedIds: string[];
        failedFiles: BatchDeleteFailedFile[];
        message: string;
    };

export async function classifyBatchDeleteResponse(response: Response): Promise<BatchDeleteResult> {
    const payload = await response.json().catch(() => ({})) as any;
    if (response.status === 207 && payload.status === 'partial') {
        return {
            status: 'partial',
            deletedIds: Array.isArray(payload.deletedIds) ? payload.deletedIds : [],
            failedFiles: Array.isArray(payload.failedFiles) ? payload.failedFiles : [],
            message: payload.message || tr('errors.services.files.partialDeleteFailed'),
        };
    }
    if (response.ok && payload.status === 'complete') {
        return {
            status: 'complete',
            deletedIds: Array.isArray(payload.deletedIds) ? payload.deletedIds : [],
            failedFiles: [],
            message: payload.message || tr('errors.services.files.deleteComplete'),
        };
    }
    throw new Error(payload.error || payload.message || tr('errors.services.files.batchDeleteFailed'));
}
