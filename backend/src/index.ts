import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

import filesRouter from './routes/files.js';
import scopedFolderOperationsRouter from './routes/folderOperations.js';
import uploadRouter, { apiRouter as apiUploadRouter } from './routes/upload.js';
import storageRouter from './routes/storage.js';
import chunkedUploadRouter from './routes/chunkedUpload.js';
import tasksRouter from './routes/tasks.js';
import authRouter, { requireAuth } from './routes/auth.js';
import { requireAuthOrSignedUrl } from './middleware/signedUrl.js';
import { initTelegramBot } from './services/telegramBot.js';
import { initTelegramUserClient, isTelegramUserClientReady } from './services/telegramUserClient.js';
import { isInitialSetupRequired } from './utils/authSettings.js';
import { get2FAReadiness } from './utils/security.js';
import { ensureDatabaseInitialized, pool } from './db/index.js';
import helmet from 'helmet';
import crypto from 'node:crypto';
import { normalizeRequestId } from './services/operationalEvents.js';
import { markTransferTasksAfterRestart } from './services/transferTasks.js';
import { initializeYtDlpQueue } from './services/ytDlpDownload.js';
import { logRuntimeConfigSummary, validateRuntimeConfig } from './utils/runtimeConfig.js';

dotenv.config();
const runtimeConfigSummary = validateRuntimeConfig();
logRuntimeConfigSummary(runtimeConfigSummary);

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
const PORT = process.env.PORT || 51947;

// 确保上传目录存在
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR || './data/thumbnails';
const PREVIEW_DIR = process.env.PREVIEW_DIR || './data/previews';
const CHUNK_DIR = process.env.CHUNK_DIR || './data/chunks';

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    console.log(`📁 创建上传目录: ${UPLOAD_DIR}`);
}

if (!fs.existsSync(THUMBNAIL_DIR)) {
    fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
    console.log(`📁 创建缩略图目录: ${THUMBNAIL_DIR}`);
}

if (!fs.existsSync(PREVIEW_DIR)) {
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    console.log(`🎞️ 创建预览目录: ${PREVIEW_DIR}`);
}

if (!fs.existsSync(CHUNK_DIR)) {
    fs.mkdirSync(CHUNK_DIR, { recursive: true });
    console.log(`📁 创建分块目录: ${CHUNK_DIR}`);
}

const configuredCorsOrigin = process.env.CORS_ORIGIN || '';
const allowedOrigins = configuredCorsOrigin
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const allowAnyOrigin = allowedOrigins.includes('*');

app.use(cors({
    origin: allowAnyOrigin
        ? true
        : (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(null, false);
        },
    credentials: !allowAnyOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Upload-Id', 'X-Chunk-Index', 'X-Chunk-Size', 'X-Chunk-Sha256', 'X-Confirmation-Token', 'Authorization'],
}));

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));

app.use((req, res, next) => {
    const provided = normalizeRequestId(req.headers['x-request-id']);
    const requestId = provided || crypto.randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
});

// Browser-side CSRF/origin guard for state-changing requests. Non-browser API clients
// often omit Origin; those requests still require normal authentication/API keys.
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    if (!allowAnyOrigin && !allowedOrigins.includes(origin)) {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    next();
});

// 安全头部
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            "default-src": ["'self'"],
            "img-src": ["'self'", "data:", "blob:", "https:"],
            "media-src": ["'self'", "blob:", "https:"],
            "connect-src": ["'self'", "https:"],
            "style-src": ["'self'", "'unsafe-inline'"],
            "script-src": ["'self'"],
        },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    hsts: { maxAge: 31536000, includeSubDomains: true },
}));

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
// 文件夹操作路由仅提供更具体的 batch-delete/rename-folder/move-folder 端点，需先挂载。
// 不能在挂载点套 requireAuth，否则会抢先拦截 /api/files/:id/thumbnail 这类签名 URL。
app.use('/api/files', scopedFolderOperationsRouter);
app.use('/api/files', requireAuthOrSignedUrl, filesRouter);
app.use('/api/upload', requireAuth, uploadRouter);
app.use('/api/v1/upload', apiUploadRouter);
app.use('/api/chunked', requireAuth, chunkedUploadRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/storage', storageRouter);

// 健康检查（不需要认证）
let applicationReady = false;
let readinessError: string | null = null;
app.get('/livez', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/readyz', async (_req, res) => {
    try {
        if (!applicationReady) throw new Error(readinessError || '应用仍在初始化');
        await ensureDatabaseInitialized();
        await pool.query('SELECT 1');
        const { storageManager } = await import('./services/storage.js');
        await storageManager.assertReady();
        const twoFactor = await get2FAReadiness();
        if (!twoFactor.ready) throw new Error('2FA 密钥不可读取');
        res.json({ status: 'ready', timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(503).json({ status: 'not_ready', error: error instanceof Error ? error.message : String(error) });
    }
});
// Backward-compatible liveness alias. Deployments should route traffic based on /readyz.
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 错误处理
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('❌ 错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
});

let server: ReturnType<typeof app.listen> | null = null;

async function initializeApplication(): Promise<void> {
    const telegramEnabled = !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_API_ID && !!process.env.TELEGRAM_API_HASH;
    await ensureDatabaseInitialized();
    await markTransferTasksAfterRestart();
    const { storageManager } = await import('./services/storage.js');
    await storageManager.init();
    const twoFactor = await get2FAReadiness();
    if (!twoFactor.ready) throw new Error('2FA 已启用但密钥不可读取');
    if (telegramEnabled) {
        await initTelegramUserClient();
        await initTelegramBot();
    }
    await initializeYtDlpQueue();
    applicationReady = true;
    readinessError = null;
}

async function startApplication(): Promise<void> {
    await initializeApplication();
    server = app.listen(PORT, async () => {
        const telegramEnabled = !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_API_ID && !!process.env.TELEGRAM_API_HASH;
        const initialSetupRequired = await isInitialSetupRequired();
        console.log(`
🚀 TG Vault 后端服务已启动
📍 端口: ${PORT}
📁 上传目录: ${path.resolve(UPLOAD_DIR)}
🖼️  缩略图目录: ${path.resolve(THUMBNAIL_DIR)}
🎞️  预览目录: ${path.resolve(PREVIEW_DIR)}
🔐 密码保护: ${initialSetupRequired ? '待首次初始化' : '已启用'}
🤖 Telegram Bot: ${telegramEnabled ? '已启用 (最大 2GB，账号级下载器不受此限制)' : '未启用'}
👤 Telegram User Download: ${isTelegramUserClientReady() ? '已启用' : '未启用'}
        `);
    });
}

void startApplication().catch(error => {
    applicationReady = false;
    readinessError = error instanceof Error ? error.message : String(error);
    console.error('应用初始化失败，拒绝监听业务端口:', error);
    process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    applicationReady = false;
    readinessError = `正在因 ${signal} 停机`;
    const forceTimer = setTimeout(() => process.exit(1), 30_000);
    forceTimer.unref();
    if (server) {
        server.close(async () => {
            try {
                await pool.end();
                process.exit(0);
            } catch (error) {
                console.error('优雅停机失败:', error);
                process.exit(1);
            }
        });
    } else {
        await pool.end().catch(() => undefined);
        process.exit(0);
    }
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

export default app;
