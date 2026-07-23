import { Router, Request, Response } from 'express';
import { buildStorageCapabilities } from '../utils/storageProductContract.js';
import { query } from '../db/index.js';
import fs from 'fs';
import path from 'path';
import { getSignedUrl } from '../middleware/signedUrl.js';
import { getCurrentStorageScope, getScopedFileById, nextParam, removePhysicalFile, updateScopedFileById } from '../utils/fileScope.js';
import { createFileDeletionService } from '../services/fileDeletion.js';
import { webDestructiveConfirmationStore } from '../services/webDestructiveConfirmation.js';
import { getAuthToken } from './auth.js';
import { isPathInside } from '../utils/localPath.js';
import { generateMediaPreview } from '../utils/thumbnail.js';
import {
    buildFilePageQuery,
    buildFolderAggregationQuery,
    cursorForFile,
    normalizeFileQuery,
    type FileQueryScope,
} from '../services/fileQuery.js';
import { normalizeFolderPath } from '../utils/folderPath.js';
import { classifyMediaProxyError } from '../services/mediaProxyError.js';
import { buildCloudMediaResponse } from '../services/cloudMediaResponse.js';

const router = Router();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
const THUMBNAIL_DIR = path.resolve(process.env.THUMBNAIL_DIR || './data/thumbnails');
const PREVIEW_DIR = path.resolve(process.env.PREVIEW_DIR || './data/previews');

async function getSafeLocalFilePath(file: any): Promise<string> {
    const candidate = file.path || path.join(UPLOAD_DIR, file.stored_name);
    const resolved = path.resolve(candidate);
    if (!isPathInside(UPLOAD_DIR, resolved)) {
        throw new Error('Unsafe local file path');
    }
    if (!fs.existsSync(resolved)) {
        return resolved;
    }
    const real = await fs.promises.realpath(resolved);
    if (!isPathInside(UPLOAD_DIR, real)) {
        throw new Error('Unsafe local file path');
    }
    return real;
}


async function serveLocalPathWithRange(req: Request, res: Response, filePath: string, mimeType: string, cacheControl: string, etag?: string): Promise<void> {
    const stat = fs.statSync(filePath);
    res.set({
        'Content-Type': mimeType || 'application/octet-stream',
        'Cache-Control': cacheControl,
        'Accept-Ranges': 'bytes',
        ...(etag ? { 'ETag': etag } : {}),
    });

    const range = req.headers.range;
    if (range) {
        const parsedRange = parseRangeHeader(range, stat.size);
        if (!parsedRange) {
            res.status(416);
            res.set({
                'Content-Range': `bytes */${stat.size}`,
                'Accept-Ranges': 'bytes',
            });
            res.end();
            return;
        }
        const { start, end } = parsedRange;
        const chunkSize = end - start + 1;
        res.status(206);
        res.set({
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': String(chunkSize),
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
    }

    res.set('Content-Length', String(stat.size));
    fs.createReadStream(filePath).pipe(res);
}

async function serveCloudMediaStream(
    req: Request,
    res: Response,
    provider: { getFileStream(path: string, options?: { range?: string }): Promise<NodeJS.ReadableStream> },
    storedPath: string,
    mimeType: string,
): Promise<void> {
    const range = req.headers.range;
    const stream = await provider.getFileStream(storedPath, range ? { range } : undefined) as NodeJS.ReadableStream & {
        upstreamStatus?: number;
        upstreamHeaders?: Record<string, string | number | string[] | undefined> | { get(name: string): unknown };
        once(event: string, listener: (...args: any[]) => void): unknown;
        pipe(destination: NodeJS.WritableStream): unknown;
        destroy?(error?: Error): void;
    };
    const upstream = buildCloudMediaResponse({
        upstreamStatus: stream.upstreamStatus,
        upstreamHeaders: stream.upstreamHeaders,
        requestedRange: range,
    });
    res.status(upstream.status).set({
        'Content-Type': mimeType || 'application/octet-stream',
        'Cache-Control': 'private, no-store',
        ...upstream.headers,
    });
    stream.once('error', (error: Error) => {
        console.error('云端媒体流中断:', error);
        if (!res.headersSent) {
            const response = classifyMediaProxyError(error);
            if (response.retryAfter) res.set('Retry-After', String(response.retryAfter));
            res.status(response.status).json({ code: response.code, error: response.error });
        } else {
            res.destroy(error);
        }
    });
    req.once('aborted', () => stream.destroy?.());
    stream.pipe(res);
}

function parseRangeHeader(range: string | undefined, size: number): { start: number; end: number } | null {
    if (!range) return null;
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) return null;
    let start: number;
    let end: number;
    if (match[1] === '' && match[2] === '') return null;
    if (match[1] === '') {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
        start = Math.max(size - suffixLength, 0);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Number(match[2]);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
        return null;
    }
    return { start, end: Math.min(end, size - 1) };
}

function mapFileForList(file: any) {
    return {
        ...file,
        size: formatFileSize(file.size),
        date: formatRelativeTime(file.created_at),
        thumbnailUrl: file.thumbnail_path
            ? getSignedUrl(file.id, 'thumbnail')
            : undefined,
        previewUrl: getSignedUrl(file.id, 'preview'),
    };
}

async function getFileQueryScope(): Promise<FileQueryScope> {
    const { storageManager } = await import('../services/storage.js');
    const provider = storageManager.getProvider();
    return provider.name === 'local'
        ? { kind: 'local' }
        : { kind: 'account', accountId: storageManager.getActiveAccountId() || '' };
}

async function queryFilesPage(rawOptions: Record<string, unknown>) {
    const options = normalizeFileQuery(rawOptions);
    if (options.cursor && !decodeCursorForOptions(options.cursor, options.sort, options.direction)) {
        throw new Error('invalid cursor');
    }
    const scope = await getFileQueryScope();
    const built = buildFilePageQuery(scope, options);
    const result = await query(built.text, built.params);
    const rows = result.rows.slice(0, options.limit);
    return {
        files: rows.map(mapFileForList),
        nextCursor: result.rows.length > options.limit && rows.length > 0
            ? cursorForFile(rows[rows.length - 1], options.sort, options.direction)
            : null,
        hasMore: result.rows.length > options.limit,
    };
}

function decodeCursorForOptions(cursor: string, sort: 'date' | 'name', direction: 'asc' | 'desc'): boolean {
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        return parsed.sort === sort && parsed.direction === direction && typeof parsed.value === 'string' && typeof parsed.id === 'string';
    } catch {
        return false;
    }
}

function shouldReturnPagedEnvelope(req: Request): boolean {
    return req.query.page === 'cursor' || req.query.cursor !== undefined || req.query.limit !== undefined
        || ['q', 'type', 'folder', 'favorite', 'sort', 'direction'].some(key => req.query[key] !== undefined);
}

// 获取文件列表（所有过滤/排序在服务端全局执行）
router.get('/', async (req: Request, res: Response) => {
    try {
        const page = await queryFilesPage(req.query as Record<string, unknown>);
        if (shouldReturnPagedEnvelope(req)) {
            return res.json(page);
        }
        res.json(page.files);
    } catch (error) {
        if (error instanceof Error && /invalid|too long|singular/.test(error.message)) {
            return res.status(400).json({ error: error.message });
        }
        console.error('获取文件列表失败:', error);
        res.status(500).json({ error: '获取文件列表失败' });
    }
});

router.get('/folders/aggregation', async (req: Request, res: Response) => {
    try {
        const options = normalizeFileQuery(req.query as Record<string, unknown>);
        const scope = await getFileQueryScope();
        const built = buildFolderAggregationQuery(scope, options);
        const result = await query(built.text, built.params);
        res.json({
            folders: result.rows.map((row: any) => ({
                name: row.folder,
                fileCount: Number(row.file_count || 0),
                totalSizeBytes: Number(row.total_size_bytes || 0),
                latestDate: row.latest_at,
                isFavorite: !!row.is_favorite,
                coverFile: row.cover_id ? mapFileForList({
                    id: row.cover_id,
                    name: row.cover_name,
                    type: row.cover_type,
                    mime_type: row.cover_mime_type,
                    thumbnail_path: row.cover_thumbnail_path,
                    preview_path: row.cover_preview_path,
                    created_at: row.cover_created_at,
                    size: 0,
                }) : null,
            })),
        });
    } catch (error) {
        if (error instanceof Error && /invalid|too long|singular/.test(error.message)) {
            return res.status(400).json({ error: error.message });
        }
        console.error('获取文件夹聚合失败:', error);
        res.status(500).json({ error: '获取文件夹聚合失败' });
    }
});

// 创建空文件夹
router.post('/folders', async (req: Request, res: Response) => {
    try {
        const { folderName } = req.body;
        if (!folderName || typeof folderName !== 'string' || folderName.trim().length === 0) {
            return res.status(400).json({ error: '文件夹名称不能为空' });
        }

        let trimmedName: string;
        try {
            trimmedName = normalizeFolderPath(folderName);
        } catch (error) {
            return res.status(400).json({ error: error instanceof Error ? error.message : '文件夹路径无效' });
        }

        const { storageManager } = await import('../services/storage.js');
        const activeAccountId = storageManager.getActiveAccountId();
        const provider = storageManager.getProvider();

        // 检查文件夹是否已存在 (是否有任何文件在其下面)
        let checkQuery = '';
        let checkParams: any[] = [];

        if (provider.name === 'local') {
            checkQuery = 'SELECT COUNT(*)::int as cnt FROM files WHERE source = \'local\' AND folder = $1';
            checkParams = [trimmedName];
        } else {
            checkQuery = 'SELECT COUNT(*)::int as cnt FROM files WHERE storage_account_id = $1 AND folder = $2';
            checkParams = [activeAccountId, trimmedName];
        }

        const checkResult = await query(checkQuery, checkParams);
        if (checkResult.rows[0].cnt > 0) {
            return res.status(400).json({ error: '该文件夹已存在' });
        }

        // 插入占位文件
        const insertQuery = `
            INSERT INTO files (
                name, stored_name, type, mime_type, size,
                path, source, folder, storage_account_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `;

        const source = provider.name === 'local' ? 'local' : provider.name;
        const accountId = provider.name === 'local' ? null : activeAccountId;

        await query(insertQuery, [
            '.folder',             // name
            '.folder',             // stored_name
            'other',               // type
            'application/x-directory', // mime_type
            0,                     // size
            '.folder',             // path
            source,                // source
            trimmedName,           // folder
            accountId              // storage_account_id
        ]);

        res.json({ success: true, folder: trimmedName });
    } catch (error) {
        console.error('创建空文件夹失败:', error);
        res.status(500).json({ error: '创建空文件夹失败' });
    }
});

router.post('/folders/favorite', async (req: Request, res: Response) => {
    try {
        const { folderName } = req.body;
        if (!folderName || typeof folderName !== 'string') {
            return res.status(400).json({ error: '参数错误' });
        }
        let normalizedFolder: string;
        try {
            normalizedFolder = normalizeFolderPath(folderName);
        } catch (error) {
            return res.status(400).json({ error: error instanceof Error ? error.message : '文件夹路径无效' });
        }

        const { storageManager } = await import('../services/storage.js');
        const activeAccountId = storageManager.getActiveAccountId();
        const provider = storageManager.getProvider();

        let selectQuery = '';
        let updateQuery = '';
        let params: any[] = [];

        if (provider.name === 'local') {
            selectQuery = `SELECT COUNT(*)::int as cnt, BOOL_AND(is_favorite)::boolean as all_fav
                           FROM files WHERE source = 'local'
                           AND (folder = $1 OR LEFT(folder, LENGTH($1) + 1) = $1 || '/')`;
            updateQuery = `UPDATE files SET is_favorite = $1, updated_at = NOW()
                           WHERE source = 'local'
                           AND (folder = $2 OR LEFT(folder, LENGTH($2) + 1) = $2 || '/')`;
            params = [normalizedFolder];
        } else {
            selectQuery = `SELECT COUNT(*)::int as cnt, BOOL_AND(is_favorite)::boolean as all_fav
                           FROM files WHERE storage_account_id = $1
                           AND (folder = $2 OR LEFT(folder, LENGTH($2) + 1) = $2 || '/')`;
            updateQuery = `UPDATE files SET is_favorite = $1, updated_at = NOW()
                           WHERE storage_account_id = $2
                           AND (folder = $3 OR LEFT(folder, LENGTH($3) + 1) = $3 || '/')`;
            params = [activeAccountId, normalizedFolder];
        }

        const selectResult = await query(selectQuery, params);
        const count = selectResult.rows[0]?.cnt ?? 0;

        if (!count) {
            return res.status(404).json({ error: '文件夹不存在或为空' });
        }

        const allFav = !!selectResult.rows[0]?.all_fav;
        const newFavorite = !allFav;

        if (provider.name === 'local') {
            await query(updateQuery, [newFavorite, normalizedFolder]);
        } else {
            await query(updateQuery, [newFavorite, activeAccountId, normalizedFolder]);
        }

        res.json({ success: true, isFavorite: newFavorite });
    } catch (error) {
        console.error('切换文件夹收藏状态失败:', error);
        res.status(500).json({ error: '切换文件夹收藏状态失败' });
    }
});

// 获取单个文件信息
router.get('/:id([0-9a-fA-F-]{36})', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const file = await getScopedFileById(id);

        if (!file) {
            return res.status(404).json({ error: '文件不存在' });
        }
        res.json({
            ...file,
            size: formatFileSize(file.size),
            date: formatRelativeTime(file.created_at),
            thumbnailUrl: file.thumbnail_path
                ? getSignedUrl(file.id, 'thumbnail')
                : undefined,
            previewUrl: getSignedUrl(file.id, 'preview'),
        });
    } catch (error) {
        console.error('获取文件信息失败:', error);
        res.status(500).json({ error: '获取文件信息失败' });
    }
});

// 查询媒体源状态（媒体标签本身无法读取错误响应正文）
router.get('/:id([0-9a-fA-F-]{36})/media-status', async (req: Request, res: Response) => {
    try {
        const file = await getScopedFileById(req.params.id);
        if (!file) return res.status(404).json({ code: 'FILE_NOT_FOUND', error: '文件记录不存在' });

        if (file.preview_path && (file.type === 'image' || file.type === 'video')) {
            const localPreviewPath = path.join(PREVIEW_DIR, path.basename(file.preview_path));
            if (fs.existsSync(localPreviewPath)) {
                return res.json({ available: true, source: 'local_preview' });
            }
        }

        if (file.source === 'local' || file.source === 'web') {
            const filePath = await getSafeLocalFilePath(file);
            return fs.existsSync(filePath)
                ? res.json({ available: true, source: 'local' })
                : res.status(410).json({ code: 'MEDIA_SOURCE_MISSING', error: '服务器中的源文件已不存在。', reason: 'not_found' });
        }

        const { storageManager } = await import('../services/storage.js');
        const provider = storageManager.getProvider(`${file.source}:${file.storage_account_id}`);
        if (provider.probeFileReadable) await provider.probeFileReadable(file.path);
        else if (provider.getFileAvailability) await provider.getFileAvailability(file.path);
        return res.json({ available: true, source: file.source });
    } catch (error) {
        console.error('查询媒体源状态失败:', error);
        const response = classifyMediaProxyError(error);
        if (response.retryAfter) res.set('Retry-After', String(response.retryAfter));
        return res.status(response.status).json({
            code: response.code,
            error: response.error,
            ...(response.reason ? { reason: response.reason } : {}),
        });
    }
});

// 预览文件
router.get('/:id([0-9a-fA-F-]{36})/preview', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const file = await getScopedFileById(id);

        if (!file) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const localPreviewPath = file.preview_path && (file.type === 'image' || file.type === 'video')
            ? path.join(PREVIEW_DIR, path.basename(file.preview_path))
            : null;
        if (localPreviewPath && fs.existsSync(localPreviewPath)) {
            await serveLocalPathWithRange(
                req,
                res,
                localPreviewPath,
                file.type === 'video' ? 'video/mp4' : 'image/webp',
                'public, max-age=86400',
                `"${file.id}-${file.updated_at}-${file.preview_path}"`,
            );
            return;
        }

        if (file.source === 'onedrive' || file.source === 'aliyun_oss' || file.source === 's3' || file.source === 'webdav' || file.source === 'google_drive') {
            try {
                const { storageManager } = await import('../services/storage.js');
                const provider = storageManager.getProvider(`${file.source}:${file.storage_account_id}`);
                const url = await provider.getPreviewUrl(file.path);

                if (url) {
                    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
                    return res.redirect(url);
                }

                await serveCloudMediaStream(
                    req,
                    res,
                    provider,
                    file.path,
                    file.mime_type || 'application/octet-stream',
                );
                return;
            } catch (err) {
                console.error(`获取 ${file.source} 预览链接/流失败:`, err);
                const response = classifyMediaProxyError(err);
                if (response.retryAfter) res.set('Retry-After', String(response.retryAfter));
                return res.status(response.status).json({ code: response.code, error: response.error });
            }
        }

        // 处理本地文件 (source === 'web' 或 'local')
        const filePath = await getSafeLocalFilePath(file);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '文件不存在于服务器' });
        }

        let previewPath = file.preview_path;
        let preferredPreviewPath = previewPath && (file.type === 'image' || file.type === 'video')
            ? path.join(PREVIEW_DIR, path.basename(previewPath))
            : null;

        // Backfill previews lazily. Images are cheap enough to generate inline;
        // videos can be huge, so generate them in the background and stream the
        // original with Range immediately for this request.
        if (file.type === 'image' && (!preferredPreviewPath || !fs.existsSync(preferredPreviewPath))) {
            try {
                const generatedPreview = await generateMediaPreview(filePath, file.stored_name || file.name, file.mime_type || 'application/octet-stream');
                if (generatedPreview) {
                    previewPath = path.basename(generatedPreview);
                    preferredPreviewPath = path.join(PREVIEW_DIR, previewPath);
                    await query('UPDATE files SET preview_path = $1, updated_at = NOW() WHERE id = $2', [previewPath, file.id]);
                }
            } catch (previewError) {
                console.error('懒生成图片预览失败:', previewError);
            }
        } else if (file.type === 'video' && (!preferredPreviewPath || !fs.existsSync(preferredPreviewPath))) {
            void generateMediaPreview(filePath, file.stored_name || file.name, file.mime_type || 'application/octet-stream')
                .then(async (generatedPreview) => {
                    if (!generatedPreview) return;
                    const generatedPreviewName = path.basename(generatedPreview);
                    await query('UPDATE files SET preview_path = $1, updated_at = NOW() WHERE id = $2', [generatedPreviewName, file.id]);
                    console.log(`[Preview] 🎞️ Lazy video preview cached for ${file.id}: ${generatedPreviewName}`);
                })
                .catch((previewError) => console.error('懒生成视频预览失败:', previewError));
        }

        const servedPath = preferredPreviewPath && fs.existsSync(preferredPreviewPath) ? preferredPreviewPath : filePath;
        const servedMime = preferredPreviewPath && servedPath === preferredPreviewPath
            ? (file.type === 'video' ? 'video/mp4' : 'image/webp')
            : (file.mime_type || 'application/octet-stream');

        await serveLocalPathWithRange(
            req,
            res,
            servedPath,
            servedMime,
            'public, max-age=86400',
            `"${file.id}-${file.updated_at}-${previewPath || 'original'}"`
        );
    } catch (error) {
        console.error('预览文件失败:', error);
        res.status(500).json({ error: '预览文件失败' });
    }
});

// 原始媒体流（不使用预览缓存，用于“查看原图/原视频”）
router.get('/:id([0-9a-fA-F-]{36})/original', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const file = await getScopedFileById(id);
        if (!file) return res.status(404).json({ error: '文件不存在' });

        if (file.source === 'onedrive' || file.source === 'aliyun_oss' || file.source === 's3' || file.source === 'webdav' || file.source === 'google_drive') {
            try {
                const { storageManager } = await import('../services/storage.js');
                const provider = storageManager.getProvider(`${file.source}:${file.storage_account_id}`);
                const url = await provider.getPreviewUrl(file.path);
                if (url) {
                    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
                    return res.redirect(url);
                }

                await serveCloudMediaStream(
                    req,
                    res,
                    provider,
                    file.path,
                    file.mime_type || 'application/octet-stream',
                );
                return;
            } catch (error) {
                console.error('获取原始文件失败:', error);
                const response = classifyMediaProxyError(error);
                if (response.retryAfter) res.set('Retry-After', String(response.retryAfter));
                return res.status(response.status).json({ code: response.code, error: response.error });
            }
        }

        const filePath = await getSafeLocalFilePath(file);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在于服务器' });
        await serveLocalPathWithRange(req, res, filePath, file.mime_type || 'application/octet-stream', 'public, max-age=86400', `"${file.id}-${file.updated_at}-original"`);
    } catch (error) {
        console.error('获取原始文件失败:', error);
        res.status(500).json({ error: '获取原始文件失败' });
    }
});

// 获取下载链接 (用于前端直接通过浏览器下载，不经过后端流式传输)
router.get('/:id([0-9a-fA-F-]{36})/download-url', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const file = await getScopedFileById(id);

        if (!file) {
            return res.status(404).json({ error: '文件不存在' });
        }

        // 1. 云存储文件：获取临时下载链接
        if (file.source === 'onedrive' || file.source === 'aliyun_oss' || file.source === 's3' || file.source === 'webdav' || file.source === 'google_drive') {
            try {
                const { storageManager } = await import('../services/storage.js');
                const provider = storageManager.getProvider(`${file.source}:${file.storage_account_id}`);
                const url = await provider.getPreviewUrl(file.path);
                if (url) {
                    return res.json({ url });
                } else {
                    // 如果不支持直链，还是返回 API 代理下载 URL
                    const signedUrl = getSignedUrl(file.id, 'download', 3600);
                    return res.json({ url: signedUrl, isRelative: true });
                }
            } catch (err) {
                console.error(`获取 ${file.source} 下载链接失败:`, err);
                return res.status(500).json({ error: `无法获取 ${file.source} 下载链接` });
            }
        }

        // 2. 本地文件：生成带签名的 URL，指向现有的下载接口
        // 签名有效期 1 小时
        const signedUrl = getSignedUrl(file.id, 'download', 3600);
        // 注意：getSignedUrl 返回的是相对路径 /api/files/..., 前端需要拼接 API_BASE
        // 这里直接返回相对路径，前端处理拼接
        return res.json({ url: signedUrl, isRelative: true });

    } catch (error) {
        console.error('获取下载链接失败:', error);
        res.status(500).json({ error: '获取下载链接失败' });
    }
});

// 下载文件 (支持签名 URL 访问)
router.get('/:id([0-9a-fA-F-]{36})/download', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        console.log(`[Download] Starting download for ID: ${id}`);

        const file = await getScopedFileById(id);

        if (!file) {
            return res.status(404).json({ error: '文件不存在' });
        }

        // 处理云存储文件 (如果直接访问此接口，仍然尝试重定向或流式传输)
        if (file.source === 'onedrive' || file.source === 'aliyun_oss' || file.source === 's3' || file.source === 'webdav' || file.source === 'google_drive') {
            try {
                const { storageManager } = await import('../services/storage.js');
                const provider = storageManager.getProvider(`${file.source}:${file.storage_account_id}`);
                const url = await provider.getPreviewUrl(file.path);

                if (url) {
                    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
                    return res.redirect(url);
                } else {
                    const stream = await provider.getFileStream(file.path);
                    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
                    (stream as any).pipe(res);
                    return;
                }
            } catch (err) {
                console.error(`获取 ${file.source} 下载链接/流失败:`, err);
                return res.status(500).json({ error: '无法下载文件' });
            }
        }

        // 使用数据库中存储的完整路径（支持文件夹内的文件）
        const filePath = await getSafeLocalFilePath(file);
        console.log(`[Download] Serving local file: ${filePath}`);

        if (!fs.existsSync(filePath)) {
            console.log(`[Download] File system path not found: ${filePath}`);
            return res.status(404).json({ error: '文件不存在于服务器' });
        }

        // 如果是通过签名 URL 访问的，设置 Content-Disposition 强制下载
        res.download(filePath, file.name, (err) => {
            if (err) {
                console.error('[Download] Send file error:', err);
            }
        });
    } catch (error) {
        console.error('下载文件失败:', error);
        res.status(500).json({ error: '下载文件失败' });
    }
});

// 获取缩略图
router.get('/:id([0-9a-fA-F-]{36})/thumbnail', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const file = await getScopedFileById(id);

        if (!file) {
            return res.status(404).json({ error: '文件不存在' });
        }

        if (!file.thumbnail_path) {
            // 如果是 OneDrive 且没有本地缩略图，可以尝试重定向到 OneDrive 的缩略图（如果有 API）
            // 目前暂不支持，返回 404 或默认图
            return res.status(404).json({ error: '无缩略图' });
        }

        const thumbPath = path.join(THUMBNAIL_DIR, path.basename(file.thumbnail_path));

        if (!fs.existsSync(thumbPath)) {
            return res.status(404).json({ error: '缩略图文件不存在' });
        }

        res.set({
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=604800',
        });

        const stream = fs.createReadStream(thumbPath);
        stream.pipe(res);
    } catch (error) {
        console.error('获取缩略图失败:', error);
        res.status(500).json({ error: '获取缩略图失败' });
    }
});

// 为单文件物理删除签发一次性确认令牌
router.post('/:id([0-9a-fA-F-]{36})/delete-confirmation', async (req: Request, res: Response) => {
    const file = await getScopedFileById(req.params.id);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const authToken = getAuthToken(req);
    if (!authToken) return res.status(401).json({ error: '未认证' });
    res.json(webDestructiveConfirmationStore.issue({ authToken, action: 'delete_file', objectId: req.params.id }));
});

// 删除文件
router.delete('/:id([0-9a-fA-F-]{36})', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const authToken = getAuthToken(req);
        const confirmationToken = String(req.header('x-confirmation-token') || '');
        if (!authToken || !confirmationToken || webDestructiveConfirmationStore.consume(confirmationToken, { authToken, action: 'delete_file', objectId: id }).status !== 'ok') {
            return res.status(409).json({ error: '需要一次性删除确认令牌', code: 'CONFIRMATION_REQUIRED' });
        }
        const file = await getScopedFileById(id);

        if (!file) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const deletionService = createFileDeletionService({
            removePhysicalFile,
            deleteIndex: async (fileId) => {
                const deleted = await query('DELETE FROM files WHERE id = $1', [fileId]);
                return deleted.rowCount === 1;
            },
        });
        const outcome = await deletionService.deleteIndexedFile(file);
        if (outcome.status === 'failed') {
            console.error(`删除文件失败，保留数据库索引 (ID: ${id}):`, outcome.error);
            return res.status(502).json({
                status: 'failed',
                error: '物理文件或索引删除失败，数据库索引已保留以便重试',
                details: outcome.error,
            });
        }

        res.json({
            status: 'complete',
            deletedIds: [id],
            message: outcome.status === 'not_found' ? '物理文件已不存在，索引已清理' : '文件已删除',
        });
    } catch (error) {
        console.error('删除文件失败:', error);
        res.status(500).json({ error: '删除文件失败' });
    }
});

// 辅助函数：格式化文件大小
function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 辅助函数：格式化相对时间
function formatRelativeTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(date).getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    if (days < 7) return `${days} 天前`;
    return new Date(date).toLocaleDateString('zh-CN');
}

// 重命名文件
router.patch('/:id([0-9a-fA-F-]{36})/rename', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { name } = req.body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ error: '文件名不能为空' });
        }

        const trimmedName = name.trim();

        // 检查非法字符
        if (/[\/\\:*?"<>|]/.test(trimmedName)) {
            return res.status(400).json({ error: '文件名包含非法字符' });
        }

        const file = await getScopedFileById(id);

        if (!file) {
            return res.status(404).json({ error: '文件不存在' });
        }
        // 检查后缀是否一致
        const getExt = (n: string) => {
            const dotIndex = n.lastIndexOf('.');
            return dotIndex > 0 ? n.slice(dotIndex).toLowerCase() : '';
        };

        const oldExt = getExt(file.name);
        const newExt = getExt(trimmedName);

        if (oldExt !== newExt) {
            return res.status(400).json({ error: '不允许修改文件后缀' });
        }

        await updateScopedFileById(id, 'name = $1', [trimmedName]);

        res.json({ success: true, name: trimmedName });
    } catch (error) {
        console.error('重命名文件失败:', error);
        res.status(500).json({ error: '重命名文件失败' });
    }
});

// 移动文件
router.patch('/:id([0-9a-fA-F-]{36})/move', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { folder } = req.body;

        if (folder !== null && typeof folder !== 'string') {
            return res.status(400).json({ error: '文件夹名称格式错误' });
        }

        let trimmedFolder: string | null = null;
        try {
            trimmedFolder = folder ? normalizeFolderPath(folder) : null;
        } catch (error) {
            return res.status(400).json({ error: error instanceof Error ? error.message : '文件夹路径无效' });
        }

        if (trimmedFolder) {
            const scope = await getCurrentStorageScope();
            const folderParam = nextParam(scope, 1);
            const exists = await query(
                `SELECT 1 FROM files WHERE ${scope.clause}
                 AND (folder = ${folderParam} OR LEFT(folder, LENGTH(${folderParam}) + 1) = ${folderParam} || '/') LIMIT 1`,
                [...scope.params, trimmedFolder],
            );
            if (!exists.rows[0]) return res.status(404).json({ error: '目标文件夹不存在' });
        }

        const file = await getScopedFileById(id);

        if (!file) {
            return res.status(404).json({ error: '文件不存在' });
        }
        await updateScopedFileById(id, 'folder = $1, updated_at = NOW()', [trimmedFolder]);

        res.json({ success: true, folder: trimmedFolder });
    } catch (error) {
        console.error('移动文件失败:', error);
        res.status(500).json({ error: '移动文件失败' });
    }
});

// 创建分享链接
router.post('/:id([0-9a-fA-F-]{36})/share', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { password, expiration } = req.body;

        const file = await getScopedFileById(id);

        if (!file) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const capabilities = buildStorageCapabilities(String(file.source));
        if (!capabilities.share) {
            return res.status(400).json({ error: '当前存储源暂不支持文件分享', code: 'SHARE_UNSUPPORTED' });
        }
        if (password && !capabilities.sharePassword) {
            return res.status(400).json({ error: '当前存储源不支持分享密码', code: 'SHARE_PASSWORD_UNSUPPORTED' });
        }
        if (expiration && !capabilities.shareExpiration) {
            return res.status(400).json({ error: '当前存储源不支持分享过期时间', code: 'SHARE_EXPIRATION_UNSUPPORTED' });
        }

        const { storageManager } = await import('../services/storage.js');
        const provider = storageManager.getProvider(`${file.source}:${file.storage_account_id}`);

        if (!provider || !provider.createShareLink) {
            return res.status(400).json({ error: '当前存储提供商不支持分享' });
        }

        const resultLink = await provider.createShareLink(file.path, password, expiration);

        if (resultLink.error) {
            return res.status(400).json({ error: resultLink.error });
        }

        res.json({ link: resultLink.link });

    } catch (error) {
        console.error('创建分享链接失败:', error);
        res.status(500).json({ error: '创建分享链接失败' });
    }
});

// 获取收藏的文件
router.get('/favorites', async (req: Request, res: Response) => {
    try {
        const page = await queryFilesPage({ ...req.query, favorite: 'true' } as Record<string, unknown>);
        if (shouldReturnPagedEnvelope(req)) {
            return res.json(page);
        }
        res.json(page.files);
    } catch (error) {
        console.error('获取收藏文件失败:', error);
        res.status(500).json({ error: '获取收藏文件失败' });
    }
});

// 切换文件收藏状态
router.post('/:id([0-9a-fA-F-]{36})/favorite', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        // 检查文件是否存在，并限定当前存储源
        const file = await getScopedFileById(id);
        if (!file) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const currentFavorite = file.is_favorite;
        const newFavorite = !currentFavorite;

        // 更新收藏状态
        await updateScopedFileById(id, 'is_favorite = $1, updated_at = NOW()', [newFavorite]);

        res.json({ success: true, isFavorite: newFavorite });
    } catch (error) {
        console.error('切换收藏状态失败:', error);
        res.status(500).json({ error: '切换收藏状态失败' });
    }
});

export default router;
