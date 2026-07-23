import path from 'path';
import { Api } from 'telegram';
import { getFileType, sanitizeFilename } from './telegramUtils.js';
import { getSetting } from './settings.js';

export interface StoragePathOptions {
    source?: string;
    chatName?: string | null;
    folder?: string | null;
    mimeType?: string | null;
    fileName?: string | null;
}

export interface StoragePathRules {
    bySource: boolean;
    byType: boolean;
}

export function shouldClassifyStoragePath(): boolean {
    return true;
}

export function getTypeFolder(mimeType?: string | null): string | null {
    const type = getFileType(mimeType || '');
    const map: Record<string, string> = {
        image: 'images',
        video: 'videos',
        audio: 'audio',
        document: 'documents',
    };
    return map[type] || null;
}

function hasAny(value: string, keywords: string[]): boolean {
    return keywords.some(keyword => value.includes(keyword));
}

export function getDetailedTypeFolder(mimeType?: string | null, fileName?: string | null): string | null {
    const lowerMime = (mimeType || '').toLowerCase();
    const ext = path.extname(fileName || '').toLowerCase();
    const installerExts = new Set([
        '.apk', '.apks', '.aab', '.ipa',
        '.exe', '.msi', '.msix', '.appx', '.appxbundle',
        '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.snap',
        '.run', '.bin', '.sh', '.bat', '.cmd',
        '.iso', '.img',
    ]);
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.tif', '.tiff', '.avif', '.ico']);
    const rawImageExts = new Set(['.raw', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2']);
    const videoExts = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.flv', '.wmv', '.mpeg', '.mpg', '.ts', '.m2ts', '.3gp']);
    const audioExts = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.alac']);
    const archiveExts = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst', '.lz', '.lzma', '.cab']);
    const codeExts = new Set(['.js', '.jsx', '.ts', '.tsx', '.py', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.env', '.sql', '.html', '.css', '.scss', '.sass', '.less', '.java', '.go', '.rs', '.php', '.rb', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.cs', '.swift', '.kt', '.kts', '.dart', '.lua', '.pl', '.r', '.sh', '.bat', '.cmd', '.ps1', '.vue', '.svelte']);
    const textExts = new Set(['.txt', '.md', '.markdown', '.rtf', '.log', '.nfo']);
    const spreadsheetExts = new Set(['.xls', '.xlsx', '.xlsm', '.ods', '.csv', '.tsv', '.numbers']);
    const presentationExts = new Set(['.ppt', '.pptx', '.pps', '.ppsx', '.odp', '.key']);
    const wordExts = new Set(['.doc', '.docx', '.odt', '.pages']);
    const ebookExts = new Set(['.epub', '.mobi', '.azw', '.azw3', '.fb2', '.cbz', '.cbr']);
    const fontExts = new Set(['.ttf', '.otf', '.woff', '.woff2', '.eot']);
    const designExts = new Set(['.psd', '.ai', '.sketch', '.fig', '.xd', '.indd', '.svg']);
    const torrentExts = new Set(['.torrent', '.magnet']);

    if (
        installerExts.has(ext) ||
        lowerMime.includes('android.package-archive') ||
        lowerMime.includes('apple.installer') ||
        lowerMime.includes('x-msdownload') ||
        lowerMime.includes('x-msi') ||
        lowerMime.includes('x-apple-diskimage') ||
        lowerMime.includes('x-debian-package') ||
        lowerMime.includes('x-rpm') ||
        lowerMime.includes('x-iso9660-image') ||
        lowerMime.includes('executable')
    ) return 'apps';

    if (imageExts.has(ext) || lowerMime.startsWith('image/')) return 'images';
    if (rawImageExts.has(ext)) return 'raw-images';
    if (videoExts.has(ext) || lowerMime.startsWith('video/')) return 'videos';
    if (audioExts.has(ext) || lowerMime.startsWith('audio/')) return 'audio';
    if (fontExts.has(ext) || lowerMime.includes('font') || lowerMime.includes('opentype')) return 'fonts';
    if (designExts.has(ext) || hasAny(lowerMime, ['photoshop', 'illustrator', 'figma', 'sketch'])) return 'design';
    if (torrentExts.has(ext) || lowerMime.includes('bittorrent')) return 'torrents';
    if (lowerMime.includes('epub') || lowerMime.includes('mobi') || ebookExts.has(ext)) return 'ebooks';
    if (lowerMime.includes('pdf') || ext === '.pdf') return 'pdfs';
    if (lowerMime.includes('zip') || lowerMime.includes('rar') || lowerMime.includes('7z') || lowerMime.includes('tar') || lowerMime.includes('gzip') || lowerMime.includes('compressed') || archiveExts.has(ext)) return 'archives';
    if (lowerMime.includes('spreadsheet') || lowerMime.includes('excel') || spreadsheetExts.has(ext)) return 'spreadsheets';
    if (lowerMime.includes('presentation') || lowerMime.includes('powerpoint') || presentationExts.has(ext)) return 'presentations';
    if (lowerMime.includes('word') || wordExts.has(ext)) return 'word-docs';
    if (lowerMime.includes('javascript') || lowerMime.includes('typescript') || lowerMime.includes('python') || lowerMime.includes('json') || lowerMime.includes('xml') || lowerMime.includes('sql') || codeExts.has(ext)) return 'code';
    if (lowerMime.startsWith('text/') || textExts.has(ext)) return 'text';

    return getTypeFolder(mimeType);
}

export async function getStoragePathRules(): Promise<StoragePathRules> {
    // 默认自动分类：来源/频道 + 文件类型。
    // 自定义保存路径由调用方直接覆盖，保存到用户指定目录本身，不再追加频道名或类型目录。
    return { bySource: true, byType: true };
}

function normalizeSegment(value: string | null | undefined, fallback: string): string {
    const cleaned = sanitizeFilename((value || fallback).trim()).replace(/^\.+/, '_');
    return cleaned.replace(/^\.+$/, fallback) || fallback;
}

function getEntityDisplayName(entity: any): string | null {
    if (!entity) return null;
    const personalName = [entity.firstName, entity.lastName].filter(Boolean).join(' ');
    return entity.title || personalName || entity.username || null;
}

function addUniqueSegment(segments: string[], value: string | null | undefined, fallback: string) {
    const segment = normalizeSegment(value, fallback);
    if (segments[segments.length - 1] !== segment) {
        segments.push(segment);
    }
}

export function getForwardedSourceName(fwdFrom: any): string | null {
    return fwdFrom?.postAuthor || fwdFrom?.fromName || fwdFrom?.savedFromName || null;
}

export function isOpaqueTelegramIdentifier(value: string | null | undefined): boolean {
    if (!value) return false;
    const trimmed = value.trim();
    return /^\d{8,}$/.test(trimmed) || /^\d{8,}[-_]\d{8,}$/.test(trimmed);
}

export function buildStorageFolder(options: StoragePathOptions): string | null {
    return buildStorageFolderWithRules(options, {
        bySource: true,
        byType: true,
    });
}

export function buildStorageFolderWithRules(options: StoragePathOptions, rules: StoragePathRules): string | null {
    // An explicit folder is an immutable task target. Preserve its hierarchy and do
    // not append automatic source/type segments after the task has been submitted.
    if (options.folder) {
        const explicitPath = options.folder
            .split('/')
            .filter(Boolean)
            .map(segment => normalizeSegment(segment, 'folder'))
            .join('/');
        return explicitPath || null;
    }

    if (!shouldClassifyStoragePath()) {
        return null;
    }

    const segments: string[] = [];
    if (rules.bySource) {
        addUniqueSegment(segments, options.source, 'uploads');

        if (options.chatName) {
            addUniqueSegment(segments, options.chatName, 'chat');
        }
    }

    if (rules.byType) {
        const typeFolder = getDetailedTypeFolder(options.mimeType, options.fileName);
        if (typeFolder) {
            segments.push(typeFolder);
        }
    }

    if (segments.length === 0) return null;
    return segments.join('/');
}

export function buildStorageKey(fileName: string, folder?: string | null): string {
    const safeFileName = normalizeSegment(path.basename(fileName), 'file');
    if (!folder) return safeFileName;
    return `${folder.split('/').map(segment => normalizeSegment(segment, 'folder')).join('/')}/${safeFileName}`;
}

export async function getTelegramChatName(message: Api.Message): Promise<string> {
    const fwdFrom = (message as any).fwdFrom;
    const forwardedPeer = fwdFrom?.savedFromPeer || fwdFrom?.fromId;
    if (forwardedPeer) {
        const sourceEntity: any = await (message.client as any)?.getEntity?.(forwardedPeer).catch(() => null);
        const sourceName = getEntityDisplayName(sourceEntity) || getForwardedSourceName(fwdFrom);
        if (sourceName) return normalizeSegment(sourceName, 'telegram');
    }

    const forwardedName = getForwardedSourceName(fwdFrom);
    if (forwardedName) return normalizeSegment(forwardedName, 'telegram');

    const chat: any = await message.getChat().catch(() => null);
    const title = getEntityDisplayName(chat);
    const chatId = message.chatId?.toString();
    return normalizeSegment(title || chatId || 'telegram', 'telegram');
}

export async function getTelegramBatchFolderName(message: Api.Message, fallback: string): Promise<string> {
    const fwdFrom = (message as any).fwdFrom;
    const forwardedPeer = fwdFrom?.savedFromPeer || fwdFrom?.fromId;
    if (forwardedPeer) {
        const sourceEntity: any = await (message.client as any)?.getEntity?.(forwardedPeer).catch(() => null);
        const sourceName = getEntityDisplayName(sourceEntity) || getForwardedSourceName(fwdFrom);
        if (sourceName) return normalizeSegment(sourceName, 'telegram');
    }

    const forwardedName = getForwardedSourceName(fwdFrom);
    if (forwardedName) return normalizeSegment(forwardedName, 'telegram');

    const chat: any = await message.getChat().catch(() => null);
    const title = getEntityDisplayName(chat);
    if (title) return normalizeSegment(title, 'telegram');

    return normalizeSegment(fallback, 'telegram-batch');
}
