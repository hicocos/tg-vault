import { Api } from 'telegram';
import { sanitizeFilename } from './telegramUtils.js';
import { getSetting, setSetting } from './settings.js';
import { clearTelegramPathStateRows, consumeTelegramOncePath, getTelegramSessionPath, previewTelegramPersistentPath, setTelegramPathStateRow } from './telegramPathStateStore.js';

interface ChatPathState {
    nextFolder?: string;
    sessionFolder?: string;
}

export type PendingPathInputMode = 'once' | 'session';

const chatPathState = new Map<string, ChatPathState>();
const pendingPathInputState = new Map<string, PendingPathInputMode>();
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

export function sanitizeCustomStoragePath(input: string): string {
    const raw = input.trim().replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
    if (!raw) throw new Error('路径不能为空');
    if (raw.startsWith('~') || raw.includes('\0')) throw new Error('路径包含非法字符');

    const segments = raw.split('/').map(segment => segment.trim()).filter(Boolean);
    if (segments.length === 0) throw new Error('路径不能为空');
    if (segments.some(segment => segment === '.' || segment === '..' || segment.includes('..'))) {
        throw new Error('路径不能包含 . 或 ..');
    }

    const normalized = segments.map(segment => normalizePathSegment(segment)).filter(Boolean).join('/');
    if (!normalized) throw new Error('路径无效');
    if (normalized.length > 180) throw new Error('路径过长，请控制在 180 个字符内');
    return normalized;
}

export function rememberRecentTelegramPath(chatId: string, folder: string): string {
    const normalized = sanitizeCustomStoragePath(folder);
    const current = recentPathState.get(chatId) || [];
    const next = [normalized, ...current.filter(item => item !== normalized)].slice(0, MAX_RECENT_PATHS);
    recentPathState.set(chatId, next);
    return normalized;
}

export async function rememberRecentTelegramPathPersistent(chatId: string, folder: string): Promise<string> {
    const normalized = sanitizeCustomStoragePath(folder);
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

export function buildPathPreviewLine(folder: string): string {
    return `保存到：${folder}/文件名（不会追加频道名或文件类型目录）`;
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

export function buildPendingPathPrompt(mode: PendingPathInputMode, chatId?: string): string {
    const recent = chatId ? getRecentTelegramPaths(chatId) : [];
    return [
        mode === 'once' ? '📌 **设置下一次下载目录**' : '📍 **设置会话下载目录**',
        '',
        '请直接发送目录名称：',
        mode === 'once' ? '例如：`PIXIV/每日Top50`' : '例如：`相册/2026-07`',
        ...(recent.length > 0 ? ['', '最近使用目录：', ...recent.slice(0, 4).map(item => `- ${item}`)] : []),
        '',
        mode === 'once'
            ? '说明：只影响下一次进入下载流程的文件。'
            : '说明：会影响当前聊天后续下载，直到发送 `/pc` 或点击清除。',
        '发送“取消”可退出本次设置。',
    ].join('\n');
}

export async function buildPendingPathPromptPersistent(mode: PendingPathInputMode, chatId?: string): Promise<string> {
    const recent = chatId ? await getRecentTelegramPathsPersistent(chatId) : [];
    return [
        mode === 'once' ? '📌 **设置下一次下载目录**' : '📍 **设置会话下载目录**',
        '',
        '请直接发送目录名称：',
        mode === 'once' ? '例如：`PIXIV/每日Top50`' : '例如：`相册/2026-07`',
        ...(recent.length > 0 ? ['', '最近使用目录：', ...recent.slice(0, 4).map(item => `- ${item}`)] : []),
        '',
        mode === 'once'
            ? '说明：只影响下一次进入下载流程的文件。'
            : '说明：会影响当前聊天后续下载，直到发送 `/pc` 或点击清除。',
        '发送“取消”可退出本次设置。',
    ].join('\n');
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

export function buildTelegramPathStateLines(chatId: string): string[] {
    const state = getTelegramPathState(chatId);
    const active = state.nextFolder || state.sessionFolder;
    return [
        `当前保存：${active ? `\`${active}\`（自定义目录）` : '默认自动分类'}`,
        active ? buildPathPreviewLine(active) : '默认示例：`telegram/资源下载/images`',
        `📌 下一次目录：${state.nextFolder ? `\`${state.nextFolder}\`` : '未设置'}`,
        `📍 本会话目录：${state.sessionFolder ? `\`${state.sessionFolder}\`` : '未设置'}`,
    ];
}

export interface PathCenterState { automaticBySource: boolean; automaticByType: boolean; }

export function buildPathSettingsKeyboard(_state: PathCenterState): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '📌 设置下一次目录', data: Buffer.from('pr_help_once') }),
                    new Api.KeyboardButtonCallback({ text: '📍 设置会话目录', data: Buffer.from('pr_help_session') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: '🕘 最近目录', data: Buffer.from('pr_recent') }),
                    new Api.KeyboardButtonCallback({ text: '🧹 清除自定义目录', data: Buffer.from('pr_clear_custom') }),
                ],
            }),
        ],
    });
}

export function buildPathSettingsText(
    _state: PathCenterState,
    chatId: string,
): string {
    return [
        '📁 **保存位置**',
        '',
        '**默认保存逻辑**',
        '未设置自定义目录时：自动按来源/频道 + 文件类型保存。',
        '例如：`telegram/资源下载/images`、`telegram/资源下载/videos`。',
        '设置自定义目录后：文件会直接保存到该目录本身，不再追加频道名或文件类型目录。',
        '',
        '**当前路径状态**',
        ...buildTelegramPathStateLines(chatId),
        '',
        '**快捷命令**',
        '`/p <目录>` — 仅下一次下载使用',
        '`/ps <目录>` — 当前会话持续使用',
        '`/pc` — 清除下一次/会话目录',
        '',
        '优先级：下一次目录 > 本会话目录 > 默认自动分类目录。',
        '路径示例：设置 `/ps book` 后，文件直接保存到 `book`。',
    ].join('\n');
}
