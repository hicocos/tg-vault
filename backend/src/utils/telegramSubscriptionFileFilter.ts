import type { Api } from 'telegram';
import { extractFileInfo } from './telegramMedia.js';
import { filterTelegramBatchMessages, getTelegramBatchFileType, TELEGRAM_BATCH_FILE_TYPES, type TelegramBatchFileType } from './telegramBatchMediaFilter.js';

export interface TelegramSubscriptionFileFilter {
    fileFilterMode: 'all' | 'include' | 'exclude';
    fileFilterTypes: TelegramBatchFileType[];
}

export function parseTelegramSubscriptionFileFilter(input: Record<string, unknown>): TelegramSubscriptionFileFilter {
    const mode = input.fileFilterMode;
    if (mode !== 'all' && mode !== 'include' && mode !== 'exclude') {
        throw new Error('fileFilterMode 必须是 all、include 或 exclude');
    }
    if (!Array.isArray(input.fileFilterTypes) || input.fileFilterTypes.some(type => typeof type !== 'string' || !TELEGRAM_BATCH_FILE_TYPES.includes(type as TelegramBatchFileType))) {
        throw new Error('fileFilterTypes 必须是有效的文件类型数组');
    }
    const types: TelegramBatchFileType[] = [];
    for (const type of input.fileFilterTypes as TelegramBatchFileType[]) {
        if (!types.includes(type)) types.push(type);
    }
    if (mode !== 'all' && types.length === 0) throw new Error('include/exclude 模式必须选择至少一种文件类型');
    return { fileFilterMode: mode, fileFilterTypes: mode === 'all' ? [] : types };
}

export function filterTelegramSubscriptionFiles(
    messages: Api.Message[],
    preferences: TelegramSubscriptionFileFilter,
    skipTelegramPhotos: boolean,
): Api.Message[] {
    if (preferences.fileFilterMode === 'all') return filterTelegramBatchMessages(messages, skipTelegramPhotos);
    return messages.filter(message => {
        const fileInfo = extractFileInfo(message);
        if (!fileInfo) return false;
        const selected = preferences.fileFilterTypes.includes(getTelegramBatchFileType(fileInfo));
        return preferences.fileFilterMode === 'include' ? selected : !selected;
    });
}
