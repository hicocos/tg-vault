import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { query } from '../db/index.js';
import { generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';
import { storageManager } from '../services/storage.js';

const router = Router();

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
    if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('text')) return 'document';
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

        const uploadId = uuidv4();
        const chunkDir = path.join(CHUNK_DIR, uploadId);
        fs.mkdirSync(chunkDir, { recursive: true });

        uploadSessions.set(uploadId, {
            uploadId,
            filename: decodeFilename(filename),
            totalChunks,
            uploadedChunks: new Set(),
            mimeType,
            totalSize,
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

        const chunkPath = path.join(CHUNK_DIR, uploadId, `chunk_${chunkIndex}`);

        // 使用流式写入
        const writeStream = fs.createWriteStream(chunkPath);

        await new Promise<void>((resolve, reject) => {
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

        // 合并分块
        const ext = path.extname(session.filename);
        const storedName = `${uuidv4()}${ext}`;
        const finalPath = path.join(UPLOAD_DIR, storedName);
        const writeStream = fs.createWriteStream(finalPath);

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

        // 获取文件信息
        // 获取文件信息
        const fileType = getFileType(session.mimeType);

        // 使用存储管理器保存文件（支持 OneDrive 等）
        const provider = storageManager.getProvider();
        let savedPath: string;
        try {
            // finalPath 现在作为临时合并文件
            savedPath = await provider.saveFile(finalPath, storedName, session.mimeType);
        } catch (err) {
            console.error('保存文件到存储提供商失败:', err);
            // 如果失败，尝试保留在本地以便恢复，或者这里直接抛出
            throw err;
        }

        // 如果不是本地存储，且文件已成功上传，删除本地临时合并文件
        // 注意：provider.saveFile 在 LocalStorageProvider 中直接使用路径，可能就是 finalPath
        // 所以我们检查如果是 'onedrive'，则删除本地文件
        if (provider.name !== 'local') {
            try {
                fs.unlinkSync(finalPath);
            } catch (e) {
                console.warn('清理本地临时文件失败:', e);
            }
        }

        const thumbnailPath = await generateThumbnail(savedPath, storedName, session.mimeType);
        const dimensions = await getImageDimensions(savedPath, session.mimeType);

        // 保存到数据库
        const result = await query(`
            INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
        `, [
            session.filename,
            storedName,
            fileType,
            session.mimeType,
            session.totalSize,
            savedPath, // 使用 provider 返回的路径
            thumbnailPath,
            dimensions.width,
            dimensions.height,
            provider.name, // 使用 provider 名称
            session.folder || null,
        ]);

        const savedFile = result.rows[0];

        res.json({
            success: true,
            file: {
                id: savedFile.id,
                name: savedFile.name,
                type: savedFile.type,
                size: formatFileSize(savedFile.size),
                previewUrl: `/api/files/${savedFile.id}/preview`,
                thumbnailUrl: thumbnailPath ? `/thumbnails/${path.basename(thumbnailPath)}` : undefined,
            },
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
