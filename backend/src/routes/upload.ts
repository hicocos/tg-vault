
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { query } from '../db/index.js';
import { validateApiKey } from '../middleware/apiKey.js';
import { generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';
import { storageManager } from '../services/storage.js';

const router = Router();

// 修复中文文件名编码问题
function decodeFilename(filename: string): string {
    try {
        const urlDecoded = decodeURIComponent(filename);
        if (urlDecoded !== filename) {
            return urlDecoded;
        }
    } catch {
        // 解码失败，继续尝试其他方法
    }

    try {
        const bytes = Buffer.from(filename, 'binary');
        const decoded = bytes.toString('utf8');
        if (!decoded.includes('\ufffd') && decoded !== filename) {
            return decoded;
        }
    } catch {
        // 解码失败
    }

    return filename;
}

const TEMP_DIR = path.join(process.cwd(), 'data', 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 配置 multer 存储到临时目录
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, TEMP_DIR);
    },
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        const storedName = `${uuidv4()}${ext}`;
        cb(null, storedName);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 2 * 1024 * 1024 * 1024 // 2GB limit
    }
});

// 处理上传请求
const handleUpload = async (req: Request, res: Response, source: string = 'web') => {
    if (!req.file) {
        return res.status(400).json({ error: '没有上传文件' });
    }

    const file = req.file;
    const originalName = decodeFilename(file.originalname);
    const mimeType = file.mimetype;
    const size = file.size;
    const tempPath = file.path;
    const storedName = file.filename;

    try {
        // 1. 获取当前存储提供商
        const provider = storageManager.getProvider();

        let storedPath = '';
        try {
            storedPath = await provider.saveFile(tempPath, storedName, mimeType);
        } catch (err) {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            throw err;
        }

        // 清理临时文件
        if (fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
            } catch (e) {
                console.warn('Failed to clean up temp file:', e);
            }
        }

        let thumbnailPath = null;
        let width = null;
        let height = null;

        if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) {
            try {
                // 如果是本地存储，storedPath 就是本地路径，可以直接生成缩略图
                if (provider.name === 'local') {
                    const thumbResult = await generateThumbnail(storedPath, storedName, mimeType);
                    if (thumbResult) {
                        thumbnailPath = thumbResult;  // generateThumbnail returns string | null
                        // Note: The previous implementation of generateThumbnail returned a path string, not an object. 
                        // But looking at the file view of thumbnail.ts:13, it returns Promise<string | null>.
                        // Wait, in my previous upload.ts view it seemed to return an object? 
                        // "thumbnailPath = thumbResult.path"
                        // Let's re-read thumbnail.ts ... it returns `string | null`.
                        // So I should just assign it.

                        // And getImageDimensions returns { width, height }
                        const dims = await getImageDimensions(storedPath, mimeType);
                        width = dims.width;
                        height = dims.height;
                    } else if (mimeType.startsWith('image/')) {
                        const dims = await getImageDimensions(storedPath, mimeType);
                        width = dims.width;
                        height = dims.height;
                    }
                }
                // TODO: OneDrive 缩略图生成可以通过 API 获取，或者在前端处理
            } catch (error) {
                console.error('生成缩略图失败:', error);
            }
        }

        let type = 'other';
        if (mimeType.startsWith('image/')) type = 'image';
        else if (mimeType.startsWith('video/')) type = 'video';
        else if (mimeType.startsWith('audio/')) type = 'audio';
        else if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('text')) type = 'document';

        const result = await query(
            `INSERT INTO files 
            (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
            RETURNING id, created_at`,
            [originalName, storedName, type, mimeType, size, storedPath, thumbnailPath, width, height, provider.name]
        );

        const newFile = result.rows[0];

        res.json({
            message: '文件上传成功',
            file: {
                id: newFile.id,
                name: originalName,
                size,
                type,
                thumbnailUrl: thumbnailPath ? `/thumbnails/${path.basename(thumbnailPath)}` : undefined,
                previewUrl: `/api/files/${newFile.id}/preview`,
                date: newFile.created_at,
                source: provider.name
            }
        });
    } catch (error) {
        console.error('上传处理失败:', error);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        res.status(500).json({ error: '文件上传失败' });
    }
};

// 内部上传接口（前端使用）
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
    await handleUpload(req, res, 'web');
});

// 外部 API 上传接口（需要 API Key）
router.post('/api', validateApiKey, upload.single('file'), async (req: Request, res: Response) => {
    await handleUpload(req, res, 'api');
});

export default router;
