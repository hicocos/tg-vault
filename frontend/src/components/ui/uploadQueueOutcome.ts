export type UploadQueueStatus = 'pending' | 'uploading' | 'processing' | 'completed' | 'error' | 'cancelled';

export type UploadQueueOutcome = {
    settled: boolean;
    kind: 'uploading' | 'success' | 'partial' | 'failed' | 'cancelled';
    titleKey: 'outcomeUploading' | 'outcomeSuccess' | 'outcomePartial' | 'outcomeFailed' | 'outcomeCancelled';
};

export function getUploadQueueOutcome(items: Array<{ status: UploadQueueStatus }>): UploadQueueOutcome {
    const settled = items.length > 0 && items.every(item => ['completed', 'error', 'cancelled'].includes(item.status));
    if (!settled) return { settled: false, kind: 'uploading', titleKey: 'outcomeUploading' };

    const completed = items.filter(item => item.status === 'completed').length;
    const failed = items.filter(item => item.status === 'error').length;
    const cancelled = items.filter(item => item.status === 'cancelled').length;

    if (completed === items.length) return { settled: true, kind: 'success', titleKey: 'outcomeSuccess' };
    if (cancelled === items.length) return { settled: true, kind: 'cancelled', titleKey: 'outcomeCancelled' };
    if (failed === items.length) return { settled: true, kind: 'failed', titleKey: 'outcomeFailed' };
    return { settled: true, kind: 'partial', titleKey: 'outcomePartial' };
}
