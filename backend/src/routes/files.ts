import { Router, Request, Response } from 'express';
import { query } from '../db/index.js';
import fs from 'fs';
import path from 'path';
import { generateSignature } from '../middleware/signedUrl.js';

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR || './data/thumbnails';

// 生成签名的 URL helper
function getSignedUrl(fileId: string, type: 'preview' | 'thumbnail' | 'download', expiresIn: number = 24 * 60 * 60) {
    const expires = Date.now() + (expiresIn * 1000);
    const sign = generateSignature(fileId, expires);
    return `/api/files/${fileId}/${type}?sign=${sign}&expires=${expires}`;
}

// 获取文件列表
router.get('/', async (_req: Request, res: Response) => {
    try {
        const result = await query(`
            SELECT 
                id,
                name,
                stored_name,
                type,
                mime_type,
                size,
                path,
                thumbnail_path,
                width,
                height,
                source,
                folder,
                created_at,
                updated_at
            FROM files 
            ORDER BY created_at DESC
        `);

        const files = result.rows.map(file => ({
            ...file,
            size: formatFileSize(file.size),
            date: formatRelativeTime(file.created_at),
            thumbnailUrl: file.thumbnail_path
                ? getSignedUrl(file.id, 'thumbnail')
                : undefined,
            previewUrl: getSignedUrl(file.id, 'preview'),
        }));

        res.json(files);
    } catch (error) {
        console.error('获取文件列表失败:', error);
        res.status(500).json({ error: '获取文件列表失败' });
    }
});

// 获取单个文件信息
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const result = await query('SELECT * FROM files WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const file = result.rows[0];
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

// 预览文件
router.get('/:id/preview', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const result = await query('SELECT * FROM files WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const file = result.rows[0];

        // 处理 OneDrive 文件
        if (file.source === 'onedrive') {
            try {
                const { storageManager } = await import('../services/storage.js');
                const provider = storageManager.getProvider('onedrive');
                const url = await provider.getPreviewUrl(file.path); // 使用 path (存储的是 OneDrive Item ID)
                // 禁止缓存重定向，防止客户端缓存过期的下载链接
                res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
                return res.redirect(url);
            } catch (err) {
                console.error('获取 OneDrive 预览链接失败:', err);
                return res.status(500).json({ error: '无法获取文件预览' });
            }
        }

        // 处理本地文件 (source === 'web' 或 'local')
        const filePath = file.path || path.join(UPLOAD_DIR, file.stored_name);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '文件不存在于服务器' });
        }

        // 设置缓存头
        res.set({
            'Content-Type': file.mime_type || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400',
            'ETag': `"${file.id}-${file.updated_at}"`,
        });

        // 支持 Range 请求（视频播放等）
        const stat = fs.statSync(filePath);
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = end - start + 1;

            res.status(206);
            res.set({
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': String(chunksize),
            });

            const stream = fs.createReadStream(filePath, { start, end });
            stream.pipe(res);
        } else {
            res.set('Content-Length', String(stat.size));
            const stream = fs.createReadStream(filePath);
            stream.pipe(res);
        }
    } catch (error) {
        console.error('预览文件失败:', error);
        res.status(500).json({ error: '预览文件失败' });
    }
});

// 获取下载链接 (用于前端直接通过浏览器下载，不经过后端流式传输)
router.get('/:id/download-url', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const result = await query('SELECT * FROM files WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const file = result.rows[0];

        // 1. OneDrive 文件：获取微软的临时下载链接
        if (file.source === 'onedrive') {
            try {
                const { storageManager } = await import('../services/storage.js');
                const provider = storageManager.getProvider('onedrive');
                const url = await provider.getPreviewUrl(file.path);
                return res.json({ url });
            } catch (err) {
                console.error('获取 OneDrive 下载链接失败:', err);
                return res.status(500).json({ error: '无法获取 OneDrive 下载链接' });
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
router.get('/:id/download', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        console.log(`[Download] Starting download for ID: ${id}`);

        const result = await query('SELECT * FROM files WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            console.log(`[Download] File not found in DB: ${id}`);
            return res.status(404).json({ error: '文件不存在' });
        }

        const file = result.rows[0];

        // 处理 OneDrive 文件 (如果直接访问此接口，仍然尝试重定向)
        if (file.source === 'onedrive') {
            try {
                const { storageManager } = await import('../services/storage.js');
                const provider = storageManager.getProvider('onedrive');
                const url = await provider.getPreviewUrl(file.path);
                res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
                return res.redirect(url);
            } catch (err) {
                console.error('获取 OneDrive 下载链接失败:', err);
                return res.status(500).json({ error: '无法下载文件' });
            }
        }

        // 使用数据库中存储的完整路径（支持文件夹内的文件）
        const filePath = file.path || path.join(UPLOAD_DIR, file.stored_name);
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
router.get('/:id/thumbnail', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const result = await query('SELECT * FROM files WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const file = result.rows[0];

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

// 删除文件
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const result = await query('SELECT * FROM files WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: '文件不存在' });
        }

        const file = result.rows[0];

        if (file.source === 'onedrive') {
            try {
                const { storageManager } = await import('../services/storage.js');
                const provider = storageManager.getProvider('onedrive');
                await provider.deleteFile(file.path);
            } catch (err) {
                console.error('OneDrive 文件删除失败 (可能已不存在):', err);
            }
        } else {
            // 删除实际文件（使用数据库中存储的完整路径）
            const filePath = file.path || path.join(UPLOAD_DIR, file.stored_name);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        // 删除缩略图 (本地)
        if (file.thumbnail_path) {
            const thumbPath = path.join(THUMBNAIL_DIR, path.basename(file.thumbnail_path));
            if (fs.existsSync(thumbPath)) {
                fs.unlinkSync(thumbPath);
            }
        }

        // 删除数据库记录
        await query('DELETE FROM files WHERE id = $1', [id]);

        res.json({ success: true, message: '文件已删除' });
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

export default router;
