import { DEFAULT_LOCALE, t, type TelegramLocale } from '../i18n/telegram.js';

export type TelegramUploadReceiptAction =
    | 'find_folder'
    | 'copy_id'
    | 'delete_file'
    | 'retry_failed'
    | 'failure_details';

export interface TelegramUploadReceiptInput {
    taskId: string;
    fileName: string;
    provider: string;
    accountName: string;
    folder?: string | null;
    fileId?: string | null;
    duplicateOutcome?: 'copied' | 'skipped' | null;
    status: 'running' | 'success' | 'partial' | 'failed';
    total?: number;
    successful?: number;
    failed?: number;
    locale?: TelegramLocale;
}

export interface TelegramUploadReceipt {
    text: string;
    silentSingleCard: boolean;
    actions: Array<{ action: TelegramUploadReceiptAction; label: string; data: string }>;
}

export function buildUploadReceipt(input: TelegramUploadReceiptInput): TelegramUploadReceipt {
    const locale = input.locale || DEFAULT_LOCALE;
    const total = Math.max(1, input.total || 1);
    const failed = Math.max(0, input.failed || 0);
    const successful = Math.max(0, input.successful ?? (input.status === 'success' ? total : 0));
    const lines = [
        input.status === 'success' ? t(locale, 'upload.receipt.saved') : input.status === 'partial' ? t(locale, 'upload.receipt.partial') : input.status === 'failed' ? t(locale, 'upload.receipt.failed') : t(locale, 'upload.receipt.processing'),
        `📄 ${input.fileName}`,
        `🎯 ${input.provider} / ${input.accountName}`,
        `📁 ${input.folder || t(locale, 'fileBrowser.rootFolder')}`,
        input.fileId ? `🆔 ${input.fileId.slice(0, 13)}` : null,
        total > 1 ? t(locale, 'upload.receipt.stats', { total, successful, failed }) : null,
        input.duplicateOutcome === 'copied' ? t(locale, 'upload.receipt.duplicateCopied') : input.duplicateOutcome === 'skipped' ? t(locale, 'upload.receipt.duplicateSkipped') : null,
        t(locale, 'upload.receipt.task', { taskId: input.taskId }),
    ].filter(Boolean) as string[];
    const actions: TelegramUploadReceipt['actions'] = [];
    if (failed > 0 || input.status === 'failed') {
        actions.push({ action: 'retry_failed', label: t(locale, 'task.retryFailed', { count: failed }), data: `receipt_retry_${input.taskId}` });
        actions.push({ action: 'failure_details', label: t(locale, 'task.failureDetails'), data: `receipt_failures_${input.taskId}` });
    } else if (input.status === 'success' && input.fileId) {
        actions.push({ action: 'find_folder', label: t(locale, 'upload.receipt.findFolder'), data: `receipt_find_${input.taskId}` });
        actions.push({ action: 'copy_id', label: t(locale, 'fileBrowser.copyId'), data: `receipt_copy_${input.taskId}` });
        actions.push({ action: 'delete_file', label: t(locale, 'upload.receipt.deleteFile'), data: `receipt_delete_${input.taskId}` });
    }
    return { text: lines.join('\n'), actions, silentSingleCard: total >= 9 };
}
