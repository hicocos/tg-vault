import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

import filesRouter from './routes/files.js';
import uploadRouter from './routes/upload.js';
import storageRouter from './routes/storage.js';
import chunkedUploadRouter from './routes/chunkedUpload.js';
import authRouter, { requireAuth } from './routes/auth.js';
import { requireAuthOrSignedUrl } from './middleware/signedUrl.js';
import { initTelegramBot } from './services/telegramBot.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 51947;

// 确保上传目录存在
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR || './data/thumbnails';
const CHUNK_DIR = process.env.CHUNK_DIR || './data/chunks';

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    console.log(`📁 创建上传目录: ${UPLOAD_DIR}`);
}

if (!fs.existsSync(THUMBNAIL_DIR)) {
    fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
    console.log(`📁 创建缩略图目录: ${THUMBNAIL_DIR}`);
}

if (!fs.existsSync(CHUNK_DIR)) {
    fs.mkdirSync(CHUNK_DIR, { recursive: true });
    console.log(`📁 创建分块目录: ${CHUNK_DIR}`);
}

// 中间件
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Upload-Id', 'X-Chunk-Index', 'Authorization'],
}));

app.use(express.json());

// 认证路由（不需要认证）
app.use('/api/auth', authRouter);

// 静态文件服务（需要认证）
app.use('/uploads', requireAuth, express.static(UPLOAD_DIR, {
    maxAge: '1d',
    etag: true,
}));

app.use('/thumbnails', requireAuth, express.static(THUMBNAIL_DIR, {
    maxAge: '7d',
    etag: true,
}));

// API 路由（需要认证）
app.use('/api/files', requireAuthOrSignedUrl, filesRouter);
app.use('/api/upload', requireAuth, uploadRouter);
app.use('/api/v1/upload', uploadRouter); // 外部 API 接口保持原有认证（API Key）
app.use('/api/chunked', requireAuth, chunkedUploadRouter);
app.use('/api/storage', requireAuth, storageRouter);

// 健康检查（不需要认证）
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 错误处理
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('❌ 错误:', err);
    res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, async () => {
    const passwordProtected = !!process.env.ACCESS_PASSWORD_HASH;
    const telegramEnabled = !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_API_ID && !!process.env.TELEGRAM_API_HASH;

    // 初始化存储管理器
    try {
        const { storageManager } = await import('./services/storage.js');
        await storageManager.init();
    } catch (e) {
        console.error('存储管理器初始化失败:', e);
    }

    // 初始化 Telegram Bot
    if (telegramEnabled) {
        await initTelegramBot();
    }

    console.log(`
🚀 FoomClous 后端服务已启动
📍 端口: ${PORT}
📁 上传目录: ${path.resolve(UPLOAD_DIR)}
🖼️  缩略图目录: ${path.resolve(THUMBNAIL_DIR)}
🔐 密码保护: ${passwordProtected ? '已启用' : '未启用'}
🤖 Telegram Bot: ${telegramEnabled ? '已启用 (支持2GB文件)' : '未启用'}
    `);
});

export default app;
