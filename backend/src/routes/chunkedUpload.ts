import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { rateLimit } from 'express-rate-limit';
import checkDiskSpaceModule from 'check-disk-space';
import { pool, query } from '../db/index.js';
import { getAuthToken } from './auth.js';
import { storageManager } from '../services/storage.js';
import { assertStorageTargetWritable, isStorageCooldownError, sendStorageCooldownHttpError } from '../services/storageCooldownGuard.js';
import { generateThumbnail, getImageDimensions, generateMediaPreview } from '../utils/thumbnail.js';
import { getSignedUrl } from '../middleware/signedUrl.js';
import { getUniqueStoredName } from '../utils/fileUtils.js';
import { buildStorageFolderWithRules, getStoragePathRules } from '../utils/storagePath.js';
import { findDuplicateFile, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { saveAndIndexWithCompensation } from '../services/storageWrite.js';
import {
    ChunkUploadProtocolError,
    ChunkUploadSessionStore,
    PostgresChunkUploadSessionRepository,
    type ChunkUploadSession,
} from '../services/chunkUploadSessions.js';

const router = Router();
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR || './data/thumbnails';
const CHUNK_DIR = process.env.CHUNK_DIR || './data/chunks';
const MAX_CHUNK_BYTES = Math.max(1024 * 1024, (parseInt(process.env.MAX_UPLOAD_CHUNK_MB || '32', 10) || 32) * 1024 * 1024);
const MAX_TOTAL_BYTES = Math.max(MAX_CHUNK_BYTES, (parseInt(process.env.MAX_CHUNK_UPLOAD_GB || '20', 10) || 20) * 1024 ** 3);
const GLOBAL_BUDGET_BYTES = Math.max(MAX_TOTAL_BYTES, (parseInt(process.env.CHUNK_GLOBAL_BUDGET_GB || '40', 10) || 40) * 1024 ** 3);
const DISK_RESERVE_BYTES = Math.max(1024 ** 3, (parseInt(process.env.CHUNK_DISK_RESERVE_GB || '8', 10) || 8) * 1024 ** 3);
const MAX_TOTAL_CHUNKS = Math.max(1, parseInt(process.env.MAX_TOTAL_CHUNKS || '50000', 10) || 50000);
const SESSION_TTL_MS = Math.max(60 * 60 * 1000, parseInt(process.env.CHUNK_SESSION_TTL_MS || String(24 * 60 * 60 * 1000), 10));

[UPLOAD_DIR, THUMBNAIL_DIR, CHUNK_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

const chunkStore = new ChunkUploadSessionStore(new PostgresChunkUploadSessionRepository(pool), {
    maxTotalBytes: MAX_TOTAL_BYTES,
    globalBudgetBytes: GLOBAL_BUDGET_BYTES,
    diskReserveBytes: DISK_RESERVE_BYTES,
    getDiskFreeBytes: async () => (await checkDiskSpace(path.resolve(CHUNK_DIR))).free,
});

router.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '分块上传请求过于频繁，请稍后再试' },
}));

function ownerId(req: Request): string {
    const token = getAuthToken(req);
    if (!token) throw new ChunkUploadProtocolError('ChunkOwnerError', '缺少认证会话');
    return crypto.createHash('sha256').update(token).digest('hex');
}

function decodeFilename(filename: string): string {
    try {
        const decoded = decodeURIComponent(filename);
        if (decoded !== filename) return decoded;
    } catch { /* keep original */ }
    try {
        const decoded = Buffer.from(filename, 'binary').toString('utf8');
        if (!decoded.includes('\ufffd') && decoded !== filename) return decoded;
    } catch { /* keep original */ }
    return filename;
}

function safeChunkPath(uploadId: string, chunkIndex: number): string {
    return path.join(path.resolve(CHUNK_DIR), uploadId, `chunk_${chunkIndex}`);
}

function getFileType(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (/pdf|document|text|word|excel|spreadsheet|powerpoint|presentation|markdown|json|xml|sql/i.test(mimeType)) return 'document';
    return 'other';
}

function sendProtocolError(res: Response, error: unknown): Response {
    if (error instanceof ChunkUploadProtocolError) {
        const status = error.name === 'ChunkOwnerError' ? 401
            : /TooLarge|TotalSize/.test(error.name) ? 413
                : error.name === 'ChunkDiskReserveError' ? 507
                    : error.name === 'ChunkBudgetError' ? 429
                        : /State|Conflict/.test(error.name) ? 409 : 400;
        return res.status(status).json({ error: error.message, code: error.name });
    }
    console.error('分块上传协议失败:', error);
    return res.status(500).json({ error: '分块上传失败' });
}

router.post('/init', async (req: Request, res: Response) => {
    let uploadDirectory = '';
    try {
        const { filename, totalChunks, mimeType, totalSize, folder } = req.body;
        const chunks = Number(totalChunks);
        const bytes = Number(totalSize);
        if (typeof filename !== 'string' || !filename.trim() || typeof mimeType !== 'string') {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        if (!Number.isSafeInteger(chunks) || chunks < 1 || chunks > MAX_TOTAL_CHUNKS || !Number.isSafeInteger(bytes) || bytes < 1) {
            return res.status(400).json({ error: '上传参数无效' });
        }
        const target = storageManager.getActiveTarget();
        const now = new Date();
        const session: ChunkUploadSession = {
            uploadId: crypto.randomUUID(),
            ownerId: ownerId(req),
            filename: decodeFilename(filename).slice(0, 255),
            mimeType: mimeType.slice(0, 100),
            folder: typeof folder === 'string' && folder ? folder.slice(0, 255) : null,
            totalSize: bytes,
            totalChunks: chunks,
            receivedBytes: 0,
            status: 'open',
            targetProvider: target.provider.name,
            targetAccountId: target.accountId,
            expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
            completionToken: null,
            completedFileId: null,
            lastError: null,
            createdAt: now,
            updatedAt: now,
        };
        uploadDirectory = path.join(CHUNK_DIR, session.uploadId);
        await fsPromises.mkdir(uploadDirectory, { recursive: true });
        await chunkStore.reserve(session);
        res.json({ success: true, uploadId: session.uploadId, expiresAt: session.expiresAt.toISOString() });
    } catch (error) {
        if (uploadDirectory) await fsPromises.rm(uploadDirectory, { recursive: true, force: true }).catch(() => undefined);
        sendProtocolError(res, error);
    }
});

router.post('/chunk', async (req: Request, res: Response) => {
    try {
        const uploadId = String(req.headers['x-upload-id'] || '');
        const chunkIndex = Number(req.headers['x-chunk-index']);
        const expectedSize = Number(req.headers['x-chunk-size'] ?? req.headers['content-length']);
        const expectedSha256 = String(req.headers['x-chunk-sha256'] || '').toLowerCase();
        if (!/^[0-9a-f-]{36}$/.test(uploadId) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 ||
            !Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_CHUNK_BYTES || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
            req.resume();
            return res.status(400).json({ error: '分块索引、大小或 SHA-256 无效' });
        }
        const session = await chunkStore.status(uploadId, ownerId(req));
        if (!session) { req.resume(); return res.status(404).json({ error: '上传会话不存在' }); }
        if (chunkIndex >= session.totalChunks) { req.resume(); return res.status(400).json({ error: '分块索引超出范围' }); }
        const result = await chunkStore.writeChunk({
            uploadId,
            ownerId: session.ownerId,
            index: chunkIndex,
            expectedSize,
            expectedSha256,
            finalPath: safeChunkPath(uploadId, chunkIndex),
            input: req,
            maxChunkBytes: MAX_CHUNK_BYTES,
        });
        const updated = await chunkStore.status(uploadId, session.ownerId);
        res.json({
            success: true,
            chunkIndex,
            duplicate: result.status === 'duplicate',
            receivedBytes: updated?.receivedBytes || 0,
            totalSize: session.totalSize,
            progress: Math.round(((updated?.receivedBytes || 0) / session.totalSize) * 100),
        });
    } catch (error) {
        sendProtocolError(res, error);
    }
});

async function mergeChunks(uploadId: string, chunks: Awaited<ReturnType<typeof chunkStore.chunks>>, targetPath: string, expectedBytes: number): Promise<void> {
    const temporary = `${targetPath}.${crypto.randomUUID()}.part`;
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    const output = fs.createWriteStream(temporary, { flags: 'wx' });
    try {
        if (chunks.length === 0) throw new Error('分块不完整');
        for (let index = 0; index < chunks.length; index++) {
            const chunk = chunks[index];
            const expectedPath = path.resolve(safeChunkPath(uploadId, index));
            if (chunk.index !== index || path.resolve(chunk.path) !== expectedPath) throw new Error(`分块 ${index} 元数据无效`);
            const stat = await fsPromises.stat(expectedPath);
            if (stat.size !== chunk.size || stat.size < 1 || stat.size > MAX_CHUNK_BYTES) throw new Error(`分块 ${index} 大小无效`);
            await pipeline(fs.createReadStream(expectedPath), output, { end: false });
        }
        await new Promise<void>((resolve, reject) => { output.end(resolve); output.on('error', reject); });
        const stat = await fsPromises.stat(temporary);
        if (stat.size !== expectedBytes) throw new Error('合并后文件大小与声明大小不一致');
        await fsPromises.rename(temporary, targetPath);
    } catch (error) {
        output.destroy();
        await fsPromises.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}

router.post('/complete', async (req: Request, res: Response) => {
    const uploadId = String(req.body?.uploadId || '');
    let owner = '';
    let token = '';
    let tempMergedPath = '';
    try {
        owner = ownerId(req);
        const current = await chunkStore.status(uploadId, owner);
        if (!current) return res.status(404).json({ error: '上传会话不存在' });
        if (current.status === 'completed' && current.completedFileId) {
            const existing = await query('SELECT id, name, type, size, created_at, source, thumbnail_path FROM files WHERE id = $1', [current.completedFileId]);
            if (!existing.rows[0]) return res.status(409).json({ error: '完成记录指向的文件不存在' });
            const file = existing.rows[0];
            return res.json({
                success: true,
                idempotent: true,
                file: {
                    id: file.id,
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    thumbnailUrl: file.thumbnail_path ? getSignedUrl(file.id, 'thumbnail') : undefined,
                    previewUrl: getSignedUrl(file.id, 'preview'),
                    date: file.created_at,
                    source: file.source,
                },
            });
        }
        if (current.status === 'failed') {
            return res.status(409).json({ error: '上次完成失败，请先重试上传会话', retryable: true, lastError: current.lastError });
        }
        token = crypto.randomUUID();
        const claim = await chunkStore.claimCompletion(uploadId, owner, token);
        if (!claim) return res.status(409).json({ error: '上传未完整、已由其他请求处理或状态不可完成' });

        const session = claim.session;
        const target = storageManager.getTarget(session.targetProvider, session.targetAccountId);
        await assertStorageTargetWritable(target);
        const storageFolder = buildStorageFolderWithRules({
            source: 'web', folder: session.folder, mimeType: session.mimeType, fileName: session.filename,
        }, await getStoragePathRules());
        const storedName = await getUniqueStoredName(session.filename, storageFolder, session.targetAccountId);
        tempMergedPath = path.join(path.resolve(UPLOAD_DIR), `${uploadId}-${storedName}`);
        await mergeChunks(uploadId, claim.chunks, tempMergedPath, session.totalSize);

        const duplicate = (await getDuplicateMode()) === 'skip'
            ? await findDuplicateFile(session.filename, storageFolder, session.totalSize, session.targetAccountId) : null;
        if (duplicate) {
            await fsPromises.rm(tempMergedPath, { force: true });
            if (!(await chunkStore.complete(uploadId, owner, token, duplicate.id))) throw new Error('完成租约已失效');
            await fsPromises.rm(path.join(CHUNK_DIR, uploadId), { recursive: true, force: true })
                .catch(error => console.error('清理已完成重复上传的分块失败:', error));
            return res.json({
                success: true,
                skipped: true,
                reason: 'duplicate',
                file: {
                    id: duplicate.id,
                    name: duplicate.name,
                    size: duplicate.size,
                    folder: duplicate.folder,
                    date: duplicate.created_at,
                },
            });
        }

        let thumbnailPath: string | null = null;
        let previewPath: string | null = null;
        let width: number | null = null;
        let height: number | null = null;
        if (target.provider.name === 'local' && (session.mimeType.startsWith('image/') || session.mimeType.startsWith('video/'))) {
            const thumbnail = await generateThumbnail(tempMergedPath, storedName, session.mimeType).catch(() => null);
            thumbnailPath = thumbnail ? path.basename(thumbnail) : null;
            const dimensions = await getImageDimensions(tempMergedPath, session.mimeType).catch(() => ({ width: null, height: null }));
            width = dimensions.width;
            height = dimensions.height;
        }
        if (target.provider.name === 'local' && session.mimeType.startsWith('image/')) {
            const preview = await generateMediaPreview(tempMergedPath, storedName, session.mimeType).catch(() => null);
            previewPath = preview ? path.basename(preview) : null;
        }

        const type = getFileType(session.mimeType);
        let indexed: Awaited<ReturnType<typeof query>> | undefined;
        const storedPath = await saveAndIndexWithCompensation(target.provider, tempMergedPath, storedName, session.mimeType, storageFolder, async savedPath => {
            indexed = await query(
                `INSERT INTO files
                 (name, stored_name, type, mime_type, size, path, thumbnail_path, preview_path, width, height, source, folder, storage_account_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                 RETURNING id, created_at, name, type, size, source`,
                [session.filename, storedName, type, session.mimeType, session.totalSize, savedPath, thumbnailPath, previewPath,
                    width, height, target.provider.name, storageFolder, session.targetAccountId],
            );
        });
        const file = indexed!.rows[0];
        let completed = false;
        try {
            completed = await chunkStore.complete(uploadId, owner, token, file.id);
        } catch (completionError) {
            await target.provider.deleteFile(storedPath).catch(error => console.error('完成 CAS 异常后删除存储对象失败:', error));
            await query('DELETE FROM files WHERE id = $1', [file.id]).catch(error => console.error('完成 CAS 异常后删除文件索引失败:', error));
            throw completionError;
        }
        if (!completed) {
            await target.provider.deleteFile(storedPath).catch(error => console.error('完成 CAS 失败后删除存储对象失败:', error));
            await query('DELETE FROM files WHERE id = $1', [file.id]).catch(error => console.error('完成 CAS 失败后删除文件索引失败:', error));
            throw new Error('永久文件已保存，但完成租约失效');
        }
        await fsPromises.rm(tempMergedPath, { force: true }).catch(error => console.error('清理合并临时文件失败:', error));
        await fsPromises.rm(path.join(CHUNK_DIR, uploadId), { recursive: true, force: true })
            .catch(error => console.error('清理已完成上传的分块失败:', error));
        if (target.provider.name === 'local' && type === 'video') {
            void generateMediaPreview(storedPath, storedName, session.mimeType)
                .then(async preview => { if (preview) await query('UPDATE files SET preview_path = $1 WHERE id = $2', [path.basename(preview), file.id]); })
                .catch(error => console.error('异步生成视频预览失败:', error));
        }
        res.json({
            success: true,
            file: {
                id: file.id,
                name: file.name,
                type: file.type,
                size: file.size,
                thumbnailUrl: thumbnailPath ? getSignedUrl(file.id, 'thumbnail') : undefined,
                previewUrl: getSignedUrl(file.id, 'preview'),
                date: file.created_at,
                source: target.provider.name,
            },
        });
    } catch (error) {
        if (uploadId && owner && token) await chunkStore.failCompletion(uploadId, owner, token, error instanceof Error ? error.message : String(error)).catch(() => undefined);
        if (tempMergedPath) await fsPromises.rm(tempMergedPath, { force: true }).catch(() => undefined);
        if (isStorageCooldownError(error)) return sendStorageCooldownHttpError(res, error);
        sendProtocolError(res, error);
    }
});

router.post('/:uploadId/retry', async (req: Request<{ uploadId: string }>, res: Response) => {
    try {
        const reopened = await chunkStore.retryFailed(req.params.uploadId, ownerId(req));
        res.status(reopened ? 200 : 409).json({ success: reopened });
    } catch (error) { sendProtocolError(res, error); }
});

router.delete('/:uploadId', async (req: Request<{ uploadId: string }>, res: Response) => {
    try {
        const result = await chunkStore.cancel(req.params.uploadId, ownerId(req));
        if (result === 'busy') return res.status(409).json({ error: '上传正在完成，暂时不能取消' });
        if (result === 'cancelled') await fsPromises.rm(path.join(CHUNK_DIR, req.params.uploadId), { recursive: true, force: true });
        res.status(result === 'not_found' ? 404 : 200).json({ success: result !== 'not_found', status: result });
    } catch (error) { sendProtocolError(res, error); }
});

router.get('/:uploadId/status', async (req: Request<{ uploadId: string }>, res: Response) => {
    try {
        const session = await chunkStore.status(req.params.uploadId, ownerId(req));
        if (!session) return res.status(404).json({ error: '上传会话不存在' });
        const chunks = await chunkStore.chunks(session.uploadId, session.ownerId);
        res.json({
            uploadId: session.uploadId,
            filename: session.filename,
            status: session.status,
            totalChunks: session.totalChunks,
            uploadedChunks: chunks.map(chunk => chunk.index),
            receivedBytes: session.receivedBytes,
            totalSize: session.totalSize,
            progress: Math.round((session.receivedBytes / session.totalSize) * 100),
            expiresAt: session.expiresAt,
            completedFileId: session.completedFileId,
            error: session.lastError,
        });
    } catch (error) { sendProtocolError(res, error); }
});

export default router;
