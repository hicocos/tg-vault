import type { Api } from 'telegram';
import { isTelegramPhotoMedia } from './telegramMedia.js';
import type { TelegramFileInfo } from './telegramMedia.js';
import { getDetailedTypeFolder } from './storagePath.js';

export const TELEGRAM_BATCH_FILE_TYPES = [
    'images', 'raw-images', 'videos', 'audio', 'archives', 'apps',
    'text', 'word-docs', 'pdfs', 'spreadsheets', 'presentations', 'ebooks',
    'code', 'fonts', 'design', 'torrents', 'documents', 'other',
] as const;

export type TelegramBatchFileType = typeof TELEGRAM_BATCH_FILE_TYPES[number];

export function getTelegramBatchFileType(
    fileInfo: Pick<TelegramFileInfo, 'fileName' | 'mimeType'>,
): TelegramBatchFileType {
    return (getDetailedTypeFolder(fileInfo.mimeType, fileInfo.fileName) || 'other') as TelegramBatchFileType;
}

export function filterTelegramBatchMessages(messages: Api.Message[], skipTelegramPhotos: boolean): Api.Message[] {
    if (!skipTelegramPhotos) return messages;
    return messages.filter(message => !isTelegramPhotoMedia(message.media));
}
