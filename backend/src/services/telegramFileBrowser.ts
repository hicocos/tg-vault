import { formatBytes } from '../utils/telegramUtils.js';
import { DEFAULT_LOCALE, formatDate, t, type TelegramLocale } from '../i18n/telegram.js';
import { query } from '../db/index.js';
import {
    buildFilePageQuery,
    cursorForFile,
    normalizeFileQuery,
    type FileQueryScope,
} from './fileQuery.js';

export interface TelegramFileBrowserPage {
    files: any[];
    nextCursor: string | null;
    hasMore: boolean;
}

export type TelegramFileBrowserAction = 'detail' | 'copy' | 'favorite' | 'link' | 'move' | 'rename' | 'delete';

export interface TelegramFileBrowserCallback {
    action: TelegramFileBrowserAction;
    fileId: string;
}

export function encodeTelegramFileCallback(action: TelegramFileBrowserAction, fileId: string): string {
    const value = `fb_${action}_${fileId}`;
    if (Buffer.byteLength(value, 'utf8') > 64) throw new Error('Telegram callback data exceeds 64 bytes');
    return value;
}

export function parseTelegramFileCallback(data: string): TelegramFileBrowserCallback | null {
    const match = data.match(/^fb_(detail|copy|favorite|link|move|rename|delete)_([0-9a-f-]{36})$/i);
    return match ? { action: match[1].toLowerCase() as TelegramFileBrowserAction, fileId: match[2].toLowerCase() } : null;
}

function compactText(value: unknown, maxLength: number): string {
    const text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/[*_`[\]\\]/g, '').trim();
    return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text;
}

export function buildTelegramFileActionRows(file: any, locale: TelegramLocale = DEFAULT_LOCALE): Array<Array<{ text: string; data: string }>> {
    const id = String(file.id);
    const rows: Array<Array<{ text: string; data: string }>> = [
        [{ text: t(locale, 'fileBrowser.detail'), data: encodeTelegramFileCallback('detail', id) }, { text: t(locale, 'fileBrowser.copyId'), data: encodeTelegramFileCallback('copy', id) }],
        [{ text: file.is_favorite ? t(locale, 'fileBrowser.unfavorite') : t(locale, 'fileBrowser.favorite'), data: encodeTelegramFileCallback('favorite', id) }],
        [{ text: t(locale, 'fileBrowser.signedLink'), data: encodeTelegramFileCallback('link', id) }],
        [{ text: t(locale, 'fileBrowser.move'), data: encodeTelegramFileCallback('move', id) }, { text: t(locale, 'fileBrowser.rename'), data: encodeTelegramFileCallback('rename', id) }],
        [{ text: t(locale, 'fileBrowser.delete'), data: encodeTelegramFileCallback('delete', id) }],
    ];
    return rows;
}

export function buildTelegramFileDetail(file: any, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return [
        `📄 **${compactText(file.name, 80) || t(locale, 'fileBrowser.unnamed')}**`,
        `🆔 ${file.id}`,
        `📦 ${formatBytes(Number(file.size || 0))} · ${compactText(file.type || t(locale, 'fileBrowser.other'), 20)}`,
        `📍 ${compactText(file.source || t(locale, 'fileBrowser.localStorage'), 50)}`,
        `📁 ${compactText(file.folder || t(locale, 'fileBrowser.rootFolder'), 100)}`,
        `🕒 ${file.created_at ? formatDate(file.created_at, locale, { dateStyle: 'medium', timeStyle: 'short', hour12: false }) : t(locale, 'fileBrowser.unknown')}`,
    ].join('\n');
}

export async function resolveTelegramFileScope(): Promise<FileQueryScope> {
    const { storageManager } = await import('./storage.js');
    const target = storageManager.getActiveTarget();
    return target.provider.name === 'local'
        ? { kind: 'local' }
        : { kind: 'account', accountId: target.accountId || '' };
}

export async function queryTelegramFiles(
    rawOptions: Record<string, unknown>,
    dependencies: {
        runQuery?: typeof query;
        scope?: FileQueryScope;
    } = {},
): Promise<TelegramFileBrowserPage> {
    const options = normalizeFileQuery({ ...rawOptions, limit: String(rawOptions.limit || 8) });
    const scope = dependencies.scope || await resolveTelegramFileScope();
    const built = buildFilePageQuery(scope, options);
    const result = await (dependencies.runQuery || query)(built.text, built.params);
    const files = result.rows.slice(0, options.limit);
    return {
        files,
        hasMore: result.rows.length > options.limit,
        nextCursor: result.rows.length > options.limit && files.length > 0
            ? cursorForFile(files[files.length - 1], options.sort, options.direction)
            : null,
    };
}

export function buildTelegramFileCard(file: any, index: number, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const shortId = String(file.id || '').slice(0, 12);
    const createdAt = file.created_at ? formatDate(file.created_at, locale, { dateStyle: 'medium', timeStyle: 'short', hour12: false }) : t(locale, 'fileBrowser.unknown');
    const name = compactText(file.name, 46) || t(locale, 'fileBrowser.unnamed');
    const folder = compactText(file.folder || t(locale, 'fileBrowser.rootFolder'), 60);
    return [
        `${index + 1}. ${file.is_favorite ? '⭐ ' : ''}${name}`,
        `   🆔 ${shortId} · ${compactText(file.type || t(locale, 'fileBrowser.other'), 16)} · ${formatBytes(Number(file.size || 0))}`,
        `   📁 ${folder} · ${createdAt}`,
    ].join('\n');
}

export function buildTelegramFileBrowserText(page: TelegramFileBrowserPage, queryText: string, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return [
        `🔎 **${t(locale, 'fileBrowser.search')}:** ${compactText(queryText || t(locale, 'fileBrowser.recentFiles'), 80)}`,
        '',
        ...(page.files.length > 0 ? page.files.map((file, index) => buildTelegramFileCard(file, index, locale)) : [t(locale, 'fileBrowser.noMatches')]),
        '',
        t(locale, 'fileBrowser.hint'),
    ].join('\n');
}
