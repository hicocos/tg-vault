import { Api } from 'telegram';
import { sanitizeFilename } from './telegramUtils.js';
import { getSetting, setSetting } from './settings.js';
import { clearTelegramPathStateRows, consumeTelegramOncePath, getTelegramSessionPath, previewTelegramPersistentPath, setTelegramPathStateRow } from './telegramPathStateStore.js';
import { ScopedInteractionMap } from '../services/scopedInteractionMap.js';
import { DEFAULT_LOCALE, type TelegramLocale, t } from '../i18n/telegram.js';

interface ChatPathState {
    nextFolder?: string;
    sessionFolder?: string;
}

export type PendingPathInputMode = 'once' | 'session';

const chatPathState = new Map<string, ChatPathState>();
const pendingPathInputState = new ScopedInteractionMap<string, PendingPathInputMode>({
    ttlMs: Math.max(60_000, Number.parseInt(process.env.TELEGRAM_INTERACTION_TTL_MS || '900000', 10) || 900_000),
    maxEntries: Math.max(10, Number.parseInt(process.env.TELEGRAM_INTERACTION_MAX_ENTRIES || '1000', 10) || 1_000),
});
const recentPathState = new Map<string, string[]>();
const MAX_RECENT_PATHS = 6;
const RECENT_PATH_SETTING_PREFIX = 'telegram_recent_paths:';

function pendingPathInputKey(chatId: string, userId: number | string): string {
    return `${chatId}:${userId}`;
}

function recentPathSettingKey(chatId: string): string {
    return `${RECENT_PATH_SETTING_PREFIX}${chatId}`;
}

function normalizePathSegment(segment: string): string {
    return sanitizeFilename(segment.trim()).replace(/^\.+/, '_').replace(/^\.+$/, '_');
}

function parseRecentPaths(raw: unknown): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(String(raw));
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(item => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
            .slice(0, MAX_RECENT_PATHS);
    } catch {
        return [];
    }
}

async function loadRecentTelegramPaths(chatId: string): Promise<string[]> {
    const cached = recentPathState.get(chatId);
    if (cached) return [...cached];
    const raw = await getSetting<string>(recentPathSettingKey(chatId), '[]');
    const loaded = parseRecentPaths(raw);
    recentPathState.set(chatId, loaded);
    return [...loaded];
}

async function persistRecentTelegramPaths(chatId: string, paths: string[]): Promise<void> {
    recentPathState.set(chatId, paths);
    await setSetting(recentPathSettingKey(chatId), JSON.stringify(paths));
}

export function sanitizeCustomStoragePath(input: string, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const raw = input.trim().replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
    if (!raw) throw new Error(t(locale, 'path.error.empty'));
    if (raw.startsWith('~') || raw.includes('\0')) throw new Error(t(locale, 'path.error.illegalChars'));

    const segments = raw.split('/').map(segment => segment.trim()).filter(Boolean);
    if (segments.length === 0) throw new Error(t(locale, 'path.error.empty'));
    if (segments.some(segment => segment === '.' || segment === '..' || segment.includes('..'))) {
        throw new Error(t(locale, 'path.error.dotSegments'));
    }

    const normalized = segments.map(segment => normalizePathSegment(segment)).filter(Boolean).join('/');
    if (!normalized) throw new Error(t(locale, 'path.error.invalid'));
    if (normalized.length > 180) throw new Error(t(locale, 'path.error.tooLong'));
    return normalized;
}

export function rememberRecentTelegramPath(chatId: string, folder: string): string {
    const normalized = sanitizeCustomStoragePath(folder);
    const current = recentPathState.get(chatId) || [];
    const next = [normalized, ...current.filter(item => item !== normalized)].slice(0, MAX_RECENT_PATHS);
    recentPathState.set(chatId, next);
    return normalized;
}

export async function rememberRecentTelegramPathPersistent(chatId: string, folder: string, locale: TelegramLocale = DEFAULT_LOCALE): Promise<string> {
    const normalized = sanitizeCustomStoragePath(folder, locale);
    const current = await loadRecentTelegramPaths(chatId);
    const next = [normalized, ...current.filter(item => item !== normalized)].slice(0, MAX_RECENT_PATHS);
    await persistRecentTelegramPaths(chatId, next);
    return normalized;
}

export function getRecentTelegramPaths(chatId: string): string[] {
    return [...(recentPathState.get(chatId) || [])];
}

export async function getRecentTelegramPathsPersistent(chatId: string): Promise<string[]> {
    return loadRecentTelegramPaths(chatId);
}

export function buildPathPreviewLine(folder: string, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return t(locale, 'path.preview', { folder });
}

export function getTelegramPathState(chatId: string): ChatPathState {
    return { ...(chatPathState.get(chatId) || {}) };
}

export function setNextTelegramPath(chatId: string, folder: string): string {
    const normalized = rememberRecentTelegramPath(chatId, folder);
    const state = chatPathState.get(chatId) || {};
    state.nextFolder = normalized;
    chatPathState.set(chatId, state);
    return normalized;
}

export async function setNextTelegramPathPersistent(chatId: string, folder: string): Promise<string> {
    const normalized = await rememberRecentTelegramPathPersistent(chatId, folder);
    await setTelegramPathStateRow(undefined, chatId, 'once', normalized, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const state = chatPathState.get(chatId) || {};
    state.nextFolder = normalized;
    chatPathState.set(chatId, state);
    return normalized;
}

export function setSessionTelegramPath(chatId: string, folder: string): string {
    const normalized = rememberRecentTelegramPath(chatId, folder);
    const state = chatPathState.get(chatId) || {};
    state.sessionFolder = normalized;
    chatPathState.set(chatId, state);
    return normalized;
}

export async function setSessionTelegramPathPersistent(chatId: string, folder: string): Promise<string> {
    const normalized = await rememberRecentTelegramPathPersistent(chatId, folder);
    await setTelegramPathStateRow(undefined, chatId, 'session', normalized, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    const state = chatPathState.get(chatId) || {};
    state.sessionFolder = normalized;
    chatPathState.set(chatId, state);
    return normalized;
}

export async function clearTelegramPathStatePersistent(chatId: string): Promise<void> {
    clearTelegramPathState(chatId);
    await clearTelegramPathStateRows(undefined, chatId);
}

export function clearTelegramPathState(chatId: string): void {
    chatPathState.delete(chatId);
}

export function setPendingTelegramPathInput(chatId: string, userId: number | string, mode: PendingPathInputMode): void {
    pendingPathInputState.set(pendingPathInputKey(chatId, userId), mode);
}

export function getPendingTelegramPathInput(chatId: string, userId: number | string): PendingPathInputMode | undefined {
    return pendingPathInputState.get(pendingPathInputKey(chatId, userId));
}

export function clearPendingTelegramPathInput(chatId: string, userId: number | string): void {
    pendingPathInputState.delete(pendingPathInputKey(chatId, userId));
}

export function applyPendingTelegramPathInput(chatId: string, userId: number | string, folder: string): { mode: PendingPathInputMode; folder: string } | null {
    const mode = getPendingTelegramPathInput(chatId, userId);
    if (!mode) return null;
    const normalized = mode === 'once'
        ? setNextTelegramPath(chatId, folder)
        : setSessionTelegramPath(chatId, folder);
    clearPendingTelegramPathInput(chatId, userId);
    return { mode, folder: normalized };
}

export async function applyPendingTelegramPathInputPersistent(chatId: string, userId: number | string, folder: string): Promise<{ mode: PendingPathInputMode; folder: string } | null> {
    const mode = getPendingTelegramPathInput(chatId, userId);
    if (!mode) return null;
    const normalized = mode === 'once'
        ? await setNextTelegramPathPersistent(chatId, folder)
        : await setSessionTelegramPathPersistent(chatId, folder);
    clearPendingTelegramPathInput(chatId, userId);
    return { mode, folder: normalized };
}

function renderPendingPathPrompt(mode: PendingPathInputMode, recent: string[], locale: TelegramLocale): string {
    const once = mode === 'once';
    return [
        t(locale, once ? 'path.prompt.onceTitle' : 'path.prompt.sessionTitle'),
        '',
        t(locale, 'path.prompt.sendFolder'),
        t(locale, once ? 'path.prompt.onceExample' : 'path.prompt.sessionExample'),
        ...(recent.length > 0 ? ['', t(locale, 'path.prompt.recent'), ...recent.slice(0, 4).map(item => `- ${item}`)] : []),
        '',
        t(locale, once ? 'path.prompt.onceNote' : 'path.prompt.sessionNote'),
        t(locale, 'path.prompt.cancel'),
    ].join('\n');
}

export function buildPendingPathPrompt(mode: PendingPathInputMode, chatId?: string, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const recent = chatId ? getRecentTelegramPaths(chatId) : [];
    return renderPendingPathPrompt(mode, recent, locale);
}

export async function buildPendingPathPromptPersistent(mode: PendingPathInputMode, chatId?: string, locale: TelegramLocale = DEFAULT_LOCALE): Promise<string> {
    const recent = chatId ? await getRecentTelegramPathsPersistent(chatId) : [];
    return renderPendingPathPrompt(mode, recent, locale);
}

export async function resolveTelegramStorageFolderPersistent(chatId: string, automaticFolder: string | null | undefined): Promise<string | null> {
    const once = await consumeTelegramOncePath(undefined, chatId);
    if (once) {
        const state = chatPathState.get(chatId);
        if (state) delete state.nextFolder;
        return once;
    }
    const session = await getTelegramSessionPath(undefined, chatId);
    return session || automaticFolder || null;
}

export async function resolveTelegramTaskStorageFolderPersistent(chatId: string, automaticFolder: string | null | undefined): Promise<{ folder: string | null; custom: boolean }> {
    const once = await consumeTelegramOncePath(undefined, chatId);
    if (once) return { folder: once, custom: true };
    const session = await getTelegramSessionPath(undefined, chatId);
    return session ? { folder: session, custom: true } : { folder: automaticFolder || null, custom: false };
}

export async function previewTelegramStorageFolderPersistent(chatId: string, automaticFolder: string | null | undefined): Promise<string | null> {
    const state = await previewTelegramPersistentPath(chatId);
    return state.once || state.session || automaticFolder || null;
}

export function resolveTelegramStorageFolder(chatId: string, automaticFolder: string | null | undefined): string | null {
    const state = chatPathState.get(chatId);
    if (!state) return automaticFolder || null;
    if (state.nextFolder) {
        const folder = state.nextFolder;
        delete state.nextFolder;
        if (!state.sessionFolder) chatPathState.delete(chatId);
        return folder;
    }
    return state.sessionFolder || automaticFolder || null;
}

export function resolveTelegramBatchStorageFolder(chatId: string, automaticFolder: string | null | undefined): string | null {
    // “下一次目录”应作用于下一次下载流程，而不是批量相册里的第一张图。
    // 批量任务启动时消费一次 nextFolder，然后整批文件共用该目录。
    return resolveTelegramStorageFolder(chatId, automaticFolder);
}

export function resolveTelegramTaskStorageFolder(chatId: string, automaticFolder: string | null | undefined): { folder: string | null; custom: boolean } {
    const state = chatPathState.get(chatId);
    if (!state) return { folder: automaticFolder || null, custom: false };
    if (state.nextFolder) {
        const folder = state.nextFolder;
        delete state.nextFolder;
        if (!state.sessionFolder) chatPathState.delete(chatId);
        return { folder, custom: true };
    }
    if (state.sessionFolder) return { folder: state.sessionFolder, custom: true };
    return { folder: automaticFolder || null, custom: false };
}

export function previewTelegramStorageFolder(chatId: string, automaticFolder: string | null | undefined): string | null {
    const state = chatPathState.get(chatId);
    return state?.nextFolder || state?.sessionFolder || automaticFolder || null;
}

export function buildTelegramPathStateLines(chatId: string, locale: TelegramLocale = DEFAULT_LOCALE): string[] {
    const state = getTelegramPathState(chatId);
    const active = state.nextFolder || state.sessionFolder;
    return [
        t(locale, 'path.state.current', { value: active ? t(locale, 'path.state.custom', { folder: `\`${active}\`` }) : t(locale, 'path.state.automatic') }),
        active ? buildPathPreviewLine(active, locale) : t(locale, 'path.state.defaultExample'),
        t(locale, 'path.state.once', { value: state.nextFolder ? `\`${state.nextFolder}\`` : t(locale, 'path.state.unset') }),
        t(locale, 'path.state.session', { value: state.sessionFolder ? `\`${state.sessionFolder}\`` : t(locale, 'path.state.unset') }),
    ];
}

export interface PathCenterState { automaticBySource: boolean; automaticByType: boolean; }

export function buildPathSettingsKeyboard(_state: PathCenterState, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: t(locale, 'path.button.setOnce'), data: Buffer.from('pr_help_once') }),
                    new Api.KeyboardButtonCallback({ text: t(locale, 'path.button.setSession'), data: Buffer.from('pr_help_session') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: t(locale, 'path.button.recent'), data: Buffer.from('pr_recent') }),
                    new Api.KeyboardButtonCallback({ text: t(locale, 'path.button.clear'), data: Buffer.from('pr_clear_custom') }),
                ],
            }),
        ],
    });
}

export function buildPathSettingsText(
    _state: PathCenterState,
    chatId: string,
    locale: TelegramLocale = DEFAULT_LOCALE,
): string {
    return [
        t(locale, 'path.settings.title'),
        '',
        t(locale, 'path.settings.defaultLogicTitle'),
        t(locale, 'path.settings.defaultLogic'),
        t(locale, 'path.settings.examples'),
        t(locale, 'path.settings.customLogic'),
        '',
        t(locale, 'path.settings.currentTitle'),
        ...buildTelegramPathStateLines(chatId, locale),
        '',
        t(locale, 'path.settings.choose'),
    ].join('\n');
}
