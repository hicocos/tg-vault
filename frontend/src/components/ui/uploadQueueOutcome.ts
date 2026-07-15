export type UploadQueueStatus = 'pending' | 'uploading' | 'processing' | 'completed' | 'error' | 'cancelled';

export type UploadQueueOutcome = {
    settled: boolean;
    kind: 'uploading' | 'success' | 'partial' | 'failed' | 'cancelled';
    title: string;
};

export function getUploadQueueOutcome(items: Array<{ status: UploadQueueStatus }>): UploadQueueOutcome {
    const settled = items.length > 0 && items.every(item => ['completed', 'error', 'cancelled'].includes(item.status));
    if (!settled) return { settled: false, kind: 'uploading', title: '正在上传...' };

    const completed = items.filter(item => item.status === 'completed').length;
    const failed = items.filter(item => item.status === 'error').length;
    const cancelled = items.filter(item => item.status === 'cancelled').length;

    if (completed === items.length) return { settled: true, kind: 'success', title: '上传完成' };
    if (cancelled === items.length) return { settled: true, kind: 'cancelled', title: '上传已取消' };
    if (failed === items.length) return { settled: true, kind: 'failed', title: '上传失败' };
    return { settled: true, kind: 'partial', title: '上传部分完成' };
}
