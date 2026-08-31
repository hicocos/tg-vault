import type { Api } from 'telegram';
import { isTelegramPhotoMedia } from './telegramMedia.js';

export function filterTelegramBatchMessages(messages: Api.Message[], skipTelegramPhotos: boolean): Api.Message[] {
    if (!skipTelegramPhotos) return messages;
    return messages.filter(message => !isTelegramPhotoMedia(message.media));
}
