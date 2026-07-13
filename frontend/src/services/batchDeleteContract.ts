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
            message: payload.message || '部分文件删除失败',
        };
    }
    if (response.ok && payload.status === 'complete') {
        return {
            status: 'complete',
            deletedIds: Array.isArray(payload.deletedIds) ? payload.deletedIds : [],
            failedFiles: [],
            message: payload.message || '删除完成',
        };
    }
    throw new Error(payload.error || payload.message || '批量删除失败');
}
