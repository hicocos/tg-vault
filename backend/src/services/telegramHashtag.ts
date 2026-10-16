import type { Api } from 'telegram';
import { DEFAULT_LOCALE, t, type TelegramLocale } from '../i18n/telegram.js';
export type TelegramHashtagMatcher = (message: Pick<Api.Message, 'message' | 'entities'>) => boolean;

export function normalizeHashtag(tagInput: string, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const trimmed = tagInput.trim().normalize('NFC');
    if (!trimmed) throw new Error(t(locale, 'channels.errors.hashtagRequired'));
    const tag = trimmed.replace(/^[#＃]/u, '');
    if (!/^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*$/u.test(tag)) {
        throw new Error(t(locale, 'channels.errors.hashtagInvalid'));
    }
    return `#${tag}`;
}

/** Entity offsets are UTF-16, so slice the original text before normalization. */
export function createTelegramHashtagMatcher(normalizedTag: string): TelegramHashtagMatcher {
    const escaped = normalizedTag.normalize('NFC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exact = new RegExp(`^${escaped}$`, 'iu');
    const fallback = new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`, 'iu');
    return message => {
        const body = message.message || '';
        let hasHashtagEntity = false;
        for (const entity of message.entities || []) {
            if (entity.className !== 'MessageEntityHashtag' || !Number.isInteger(entity.offset)
                || !Number.isInteger(entity.length) || entity.offset < 0 || entity.length <= 1
                || entity.offset + entity.length > body.length || body[entity.offset] !== '#') continue;
            hasHashtagEntity = true;
            if (exact.test(body.slice(entity.offset, entity.offset + entity.length).normalize('NFC'))) return true;
        }
        return !hasHashtagEntity && fallback.test(body.normalize('NFC'));
    };
}
