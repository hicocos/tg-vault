import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { query } from '../db/index.js';
import { generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';
import { storageManager } from '../services/storage.js';
import { getSignedUrl } from '../middleware/signedUrl.js';
import { getUniqueStoredName } from '../utils/fileUtils.js';
import { buildStorageFolderWithRules, getStoragePathRules } from '../utils/storagePath.js';
import { findDuplicateFile, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { rateLimit } from 'express-rate-limit';

const router = Router();

const chunkedUploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '分块上传请求过于频繁，请稍后再试' },
});
const MAX_CHUNK_BYTES = Math.max(1024 * 1024, parseInt(process.env.MAX_UPLOAD_CHUNK_MB || '64', 10) * 1024 * 1024);
const MAX_UPLOAD_SESSIONS = Math.max(10, parseInt(process.env.MAX_UPLOAD_SESSIONS || '200', 10) || 200);
const MAX_TOTAL_CHUNKS = Math.max(1, parseInt(process.env.MAX_TOTAL_CHUNKS || '50000', 10) || 50000);

router.use(chunkedUploadLimiter);

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR || './data/thumbnails';
const CHUNK_DIR = process.env.CHUNK_DIR || './data/chunks';

// 确保目录存在
[UPLOAD_DIR, THUMBNAIL_DIR, CHUNK_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// 存储上传会话信息（生产环境建议用 Redis）
const uploadSessions = new Map<string, {
    uploadId: string;
    filename: string;
    totalChunks: number;
    uploadedChunks: Set<number>;
    mimeType: string;
    totalSize: number;
    folder?: string;
    createdAt: Date;
}>();

// 清理过期会话（每小时清理超过 24 小时的会话）
setInterval(() => {
    const now = new Date();
    uploadSessions.forEach((session, uploadId) => {
        if (now.getTime() - session.createdAt.getTime() > 24 * 60 * 60 * 1000) {
            // 清理临时文件
            const chunkDir = path.join(CHUNK_DIR, uploadId);
            if (fs.existsSync(chunkDir)) {
                fs.rmSync(chunkDir, { recursive: true });
            }
            uploadSessions.delete(uploadId);
        }
    });
}, 60 * 60 * 1000);

// 修复中文文件名编码问题
function decodeFilename(filename: string): string {
    try {
        const urlDecoded = decodeURIComponent(filename);
        if (urlDecoded !== filename) {
            return urlDecoded;
        }
    } catch { }

    try {
        const bytes = Buffer.from(filename, 'binary');
        const decoded = bytes.toString('utf8');
        if (!decoded.includes('\ufffd') && decoded !== filename) {
            return decoded;
        }
    } catch { }

    return filename;
}

// 判断文件类型
function getFileType(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('text') ||
        mimeType.includes('word') || mimeType.includes('excel') || mimeType.includes('spreadsheet') ||
        mimeType.includes('powerpoint') || mimeType.includes('presentation') ||
        mimeType.includes('markdown') || mimeType.includes('json') || mimeType.includes('xml') ||
        mimeType.includes('sql')) return 'document';
    return 'other';
}

function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 1. 初始化分块上传
router.post('/init', (req: Request, res: Response) => {
    try {
        const { filename, totalChunks, mimeType, totalSize, folder } = req.body;

        if (!filename || !totalChunks || !mimeType || !totalSize) {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        const normalizedTotalChunks = Number(totalChunks);
        const normalizedTotalSize = Number(totalSize);
        if (!Number.isInteger(normalizedTotalChunks) || normalizedTotalChunks < 1 || normalizedTotalChunks > MAX_TOTAL_CHUNKS || !Number.isFinite(normalizedTotalSize) || normalizedTotalSize < 1) {
            return res.status(400).json({ error: '上传参数无效' });
        }
        if (uploadSessions.size >= MAX_UPLOAD_SESSIONS) {
            return res.status(429).json({ error: '当前上传会话过多，请稍后再试' });
        }

        const uploadId = uuidv4();
        const chunkDir = path.join(CHUNK_DIR, uploadId);
        fs.mkdirSync(chunkDir, { recursive: true });

        uploadSessions.set(uploadId, {
            uploadId,
            filename: decodeFilename(filename),
            totalChunks: normalizedTotalChunks,
            uploadedChunks: new Set(),
            mimeType,
            totalSize: normalizedTotalSize,
            folder,
            createdAt: new Date(),
        });

        res.json({
            success: true,
            uploadId,
            message: '上传会话已创建',
        });
    } catch (error) {
        console.error('初始化分块上传失败:', error);
        res.status(500).json({ error: '初始化上传失败' });
    }
});

// 2. 上传单个分块
router.post('/chunk', async (req: Request, res: Response) => {
    try {
        const uploadIdHeader = req.headers['x-upload-id'];
        const chunkIndexHeader = req.headers['x-chunk-index'];

        const uploadId = Array.isArray(uploadIdHeader) ? uploadIdHeader[0] : uploadIdHeader;
        const chunkIndex = parseInt(Array.isArray(chunkIndexHeader) ? chunkIndexHeader[0] : chunkIndexHeader || '', 10);

        if (!uploadId || isNaN(chunkIndex)) {
            return res.status(400).json({ error: '缺少上传 ID 或分块索引' });
        }

        const session = uploadSessions.get(uploadId);
        if (!session) {
            return res.status(404).json({ error: '上传会话不存在或已过期' });
        }

        if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
            return res.status(400).json({ error: '分块索引超出范围' });
        }
        const declaredLength = Number(req.headers['content-length'] || 0);
        if (declaredLength > MAX_CHUNK_BYTES) {
            return res.status(413).json({ error: '单个分块过大' });
        }
        const chunkPath = path.join(CHUNK_DIR, uploadId, `chunk_${chunkIndex}`);

        // 使用流式写入
        const writeStream = fs.createWriteStream(chunkPath);

        await new Promise<void>((resolve, reject) => {
            let receivedBytes = 0;
            req.on('data', (chunk: Buffer) => {
                receivedBytes += chunk.length;
                if (receivedBytes > MAX_CHUNK_BYTES) {
                    req.destroy(new Error('单个分块过大'));
                }
            });
            req.pipe(writeStream);
            req.on('end', () => {
                session.uploadedChunks.add(chunkIndex);
                resolve();
            });
            req.on('error', reject);
            writeStream.on('error', reject);
        });

        const progress = Math.round((session.uploadedChunks.size / session.totalChunks) * 100);

        res.json({
            success: true,
            chunkIndex,
            uploadedChunks: session.uploadedChunks.size,
            totalChunks: session.totalChunks,
            progress,
        });
    } catch (error) {
        console.error('上传分块失败:', error);
        res.status(500).json({ error: '上传分块失败' });
    }
});

// 3. 完成上传（合并分块）
router.post('/complete', async (req: Request, res: Response) => {
    try {
        const { uploadId } = req.body;

        if (!uploadId) {
            return res.status(400).json({ error: '缺少上传 ID' });
        }

        const session = uploadSessions.get(uploadId);
        if (!session) {
            return res.status(404).json({ error: '上传会话不存在或已过期' });
        }

        // 检查是否所有分块都已上传
        if (session.uploadedChunks.size !== session.totalChunks) {
            return res.status(400).json({
                error: '分块不完整',
                uploadedChunks: session.uploadedChunks.size,
                totalChunks: session.totalChunks,
            });
        }

        const activeAccountId = storageManager.getActiveAccountId();
        const storageRules = await getStoragePathRules();
        const storageFolder = buildStorageFolderWithRules({
            source: 'web',
            folder: session.folder || null,
            mimeType: session.mimeType,
            fileName: session.filename,
        }, storageRules);
        const storedName = await getUniqueStoredName(session.filename, storageFolder, activeAccountId);
        const tempMergedPath = path.resolve(path.join(UPLOAD_DIR, `${uploadId}-${storedName}`));
        const writeStream = fs.createWriteStream(tempMergedPath);

        console.log(`[ChunkedComplete] 🧩 Merging ${session.totalChunks} chunks for: ${session.filename}`);
        console.log(`[ChunkedComplete] 🏠 Final temp path: ${tempMergedPath}`);

        for (let i = 0; i < session.totalChunks; i++) {
            const chunkPath = path.join(CHUNK_DIR, uploadId, `chunk_${i}`);
            const chunkData = fs.readFileSync(chunkPath);
            writeStream.write(chunkData);
        }

        await new Promise<void>((resolve, reject) => {
            writeStream.end();
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        // 清理分块
        const chunkDir = path.join(CHUNK_DIR, uploadId);
        fs.rmSync(chunkDir, { recursive: true });
        uploadSessions.delete(uploadId);

        const duplicateMode = await getDuplicateMode();
        if (duplicateMode === 'skip') {
            const duplicate = await findDuplicateFile(session.filename, storageFolder, session.totalSize, activeAccountId);
            if (duplicate) {
                if (fs.existsSync(tempMergedPath)) fs.unlinkSync(tempMergedPath);
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
                    }
                });
            }
        }

        // 5. 在保存到永久存储前生成缩略图和获取尺寸
        let thumbnailPath = null;
        let width = null;
        let height = null;

        if (session.mimeType.startsWith('image/') || session.mimeType.startsWith('video/')) {
            try {
                console.log(`[ChunkedComplete] 🖼️  MIME: ${session.mimeType}, starting generation...`);
                const thumbResult = await generateThumbnail(tempMergedPath, storedName, session.mimeType);
                if (thumbResult) {
                    thumbnailPath = path.basename(thumbResult);
                    console.log(`[ChunkedComplete] ✨ Thumbnail generated: ${thumbnailPath}`);
                    const dims = await getImageDimensions(tempMergedPath, session.mimeType);
                    width = dims.width;
                    height = dims.height;
                } else {
                    console.log(`[ChunkedComplete] ⚠️  No thumbnail generated for: ${session.mimeType}`);
                }
            } catch (error) {
                console.error('生成缩略图失败:', error);
            }
        }

        // 6. 保存到永久存储
        let storedPath = '';
        const provider = storageManager.getProvider();
        console.log(`[ChunkedComplete] 🛠️  Provider: ${provider.name}, accountId: ${activeAccountId || 'none (local)'}`);
        try {
            storedPath = await provider.saveFile(tempMergedPath, storedName, session.mimeType, storageFolder);
        } catch (err) {
            if (fs.existsSync(tempMergedPath)) fs.unlinkSync(tempMergedPath);
            throw err;
        }

        // 清理合并后的临时文件
        if (fs.existsSync(tempMergedPath)) {
            try {
                fs.unlinkSync(tempMergedPath);
            } catch (e) {
                // Ignore
            }
        }

        // 7. 保存到数据库
        const type = session.mimeType.startsWith('image/') ? 'image' :
            session.mimeType.startsWith('video/') ? 'video' :
                session.mimeType.startsWith('audio/') ? 'audio' : 'other';

        const result = await query(
            `INSERT INTO files 
            (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
            RETURNING id, created_at, name, type, size`,
            [session.filename, storedName, type, session.mimeType, session.totalSize, storedPath, thumbnailPath, width, height, provider.name, storageFolder, activeAccountId]
        );

        const newFile = result.rows[0];

        res.json({
            success: true,
            file: {
                id: newFile.id,
                name: newFile.name,
                type: newFile.type,
                size: newFile.size,
                thumbnailUrl: thumbnailPath ? getSignedUrl(newFile.id, 'thumbnail') : undefined,
                previewUrl: getSignedUrl(newFile.id, 'preview'),
                date: newFile.created_at,
                source: provider.name
            }
        });
    } catch (error) {
        console.error('完成上传失败:', error);
        res.status(500).json({ error: '完成上传失败' });
    }
});

// 4. 取消上传
router.delete('/:uploadId', (req: Request<{ uploadId: string }>, res: Response) => {
    try {
        const uploadId = req.params.uploadId;

        const session = uploadSessions.get(uploadId);
        if (session) {
            // 清理分块文件
            const chunkDir = path.join(CHUNK_DIR, uploadId);
            if (fs.existsSync(chunkDir)) {
                fs.rmSync(chunkDir, { recursive: true });
            }
            uploadSessions.delete(uploadId);
        }

        res.json({ success: true, message: '上传已取消' });
    } catch (error) {
        console.error('取消上传失败:', error);
        res.status(500).json({ error: '取消上传失败' });
    }
});

// 5. 获取上传状态
router.get('/:uploadId/status', (req: Request<{ uploadId: string }>, res: Response) => {
    try {
        const uploadId = req.params.uploadId;

        const session = uploadSessions.get(uploadId);
        if (!session) {
            return res.status(404).json({ error: '上传会话不存在' });
        }

        res.json({
            uploadId: session.uploadId,
            filename: session.filename,
            totalChunks: session.totalChunks,
            uploadedChunks: session.uploadedChunks.size,
            progress: Math.round((session.uploadedChunks.size / session.totalChunks) * 100),
        });
    } catch (error) {
        console.error('获取上传状态失败:', error);
        res.status(500).json({ error: '获取上传状态失败' });
    }
});

export default router;
