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
import subscriptionsRouter from './routes/subscriptions.js';
import authRouter, { requireAuth } from './routes/auth.js';
import { createSystemRouter } from './routes/system.js';
import { requireAuthOrSignedUrl } from './middleware/signedUrl.js';
import { initTelegramBot, sendUpdateNotificationToUser } from './services/telegramBot.js';
import { applyEffectiveTelegramBotConfig } from './services/telegramBotConfig.js';
import { getTelegramBotStatus, markTelegramBotError, telegramBotBlocksReadiness } from './services/telegramBotStatus.js';
import { initTelegramUserClient, isTelegramUserClientReady } from './services/telegramUserClient.js';
import { initializeTelegramMultiAccountRuntime } from './services/telegramMultiAccountRuntime.js';
import { isInitialSetupRequired } from './utils/authSettings.js';
import { get2FAReadiness } from './utils/security.js';
import { ensureDatabaseInitialized, pool } from './db/index.js';
import helmet from 'helmet';
import crypto from 'node:crypto';
import { normalizeRequestId } from './services/operationalEvents.js';
import { markTransferTasksAfterRestart } from './services/transferTasks.js';
import { initializeYtDlpQueue } from './services/ytDlpDownload.js';
import { recoverMediaDerivativeJobs } from './services/mediaDerivatives.js';
import { logRuntimeConfigSummary, validateRuntimeConfig } from './utils/runtimeConfig.js';
import { APP_VERSION } from './services/appVersion.js';
import { createUpdateChecker } from './services/updateChecker.js';

dotenv.config();
const runtimeConfigSummary = validateRuntimeConfig();
logRuntimeConfigSummary(runtimeConfigSummary);

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
const PORT = process.env.PORT || 51947;
const updateCheckEnabled = !/^(0|false|no|off)$/i.test(process.env.UPDATE_CHECK_ENABLED || 'true');
const updateChecker = createUpdateChecker({
    currentVersion: APP_VERSION,
    repository: process.env.UPDATE_CHECK_REPOSITORY || 'hicocos/tg-vault',
    enabled: updateCheckEnabled,
    sendBotMessage: sendUpdateNotificationToUser,
});
let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let readinessProbeTimer: ReturnType<typeof setInterval> | null = null;

interface DependencyReadinessSnapshot {
    ready: boolean;
    checkedAt: string | null;
    error: string | null;
}

let dependencyReadiness: DependencyReadinessSnapshot = { ready: false, checkedAt: null, error: '依赖尚未检查' };

async function refreshDependencyReadiness(): Promise<DependencyReadinessSnapshot> {
    try {
        await ensureDatabaseInitialized();
        await pool.query('SELECT 1');
        const { storageManager } = await import('./services/storage.js');
        await storageManager.assertReady();
        const twoFactor = await get2FAReadiness();
        if (!twoFactor.ready) throw new Error('2FA 密钥不可读取');
        dependencyReadiness = { ready: true, checkedAt: new Date().toISOString(), error: null };
    } catch (error) {
        dependencyReadiness = {
            ready: false,
            checkedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
        };
    }
    return dependencyReadiness;
}

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
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/storage', storageRouter);
app.use('/api/system', createSystemRouter(updateChecker));

// 健康检查（不需要认证）
let applicationReady = false;
let readinessError: string | null = null;
app.get('/livez', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/readyz', (_req, res) => {
    try {
        if (!applicationReady) throw new Error(readinessError || '应用仍在初始化');
        if (!dependencyReadiness.ready) throw new Error(dependencyReadiness.error || '依赖未就绪');
        const bot = getTelegramBotStatus();
        if (telegramBotBlocksReadiness(bot)) {
            throw new Error(`Telegram Bot 未就绪：${bot.status}${bot.action ? `；${bot.action}` : ''}`);
        }
        res.json({
            status: bot.degraded ? 'degraded' : 'ready',
            timestamp: new Date().toISOString(),
            components: { dependencies: dependencyReadiness, telegramBot: bot },
        });
    } catch (error) {
        res.status(503).json({ status: 'not_ready', error: error instanceof Error ? error.message : String(error) });
    }
});
app.get('/deepz', async (_req, res) => {
    const dependencies = await refreshDependencyReadiness();
    const bot = getTelegramBotStatus();
    const ready = dependencies.ready && !telegramBotBlocksReadiness(bot);
    res.status(ready ? 200 : 503).json({
        status: ready ? (bot.degraded ? 'degraded' : 'ready') : 'not_ready',
        timestamp: new Date().toISOString(),
        components: { dependencies, telegramBot: bot },
    });
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
    await ensureDatabaseInitialized();
    const telegramConfig = await applyEffectiveTelegramBotConfig();
    const telegramEnabled = telegramConfig.configured && telegramConfig.enabled;
    await markTransferTasksAfterRestart();
    const { storageManager } = await import('./services/storage.js');
    await storageManager.init();
    const twoFactor = await get2FAReadiness();
    if (!twoFactor.ready) throw new Error('2FA 已启用但密钥不可读取');
    if (telegramEnabled) {
        await initTelegramUserClient(telegramConfig.credentials || undefined);
        try {
            await initTelegramBot();
        } catch (error) {
            if (telegramConfig.required) throw error;
            const message = error instanceof Error ? error.message : String(error);
            markTelegramBotError('error', message, '检查 Telegram 凭证/网络并重启后端');
            console.warn('Telegram Bot 可选组件启动失败，应用以 degraded 状态继续:', message);
        }
    } else if (telegramConfig.credentials) {
        await initializeTelegramMultiAccountRuntime({ apiId: telegramConfig.credentials.apiId, apiHash: telegramConfig.credentials.apiHash });
    }
    await initializeYtDlpQueue();
    await recoverMediaDerivativeJobs();
    const dependencies = await refreshDependencyReadiness();
    if (!dependencies.ready) throw new Error(dependencies.error || '依赖就绪检查失败');
    applicationReady = true;
    readinessError = null;
    readinessProbeTimer = setInterval(() => { void refreshDependencyReadiness(); }, 60_000);
    readinessProbeTimer.unref?.();
    if (updateCheckEnabled) {
        const configuredInitialDelayMs = Number(process.env.UPDATE_CHECK_INITIAL_DELAY_MS || 30_000);
        const configuredIntervalMs = Number(process.env.UPDATE_CHECK_INTERVAL_MS || 6 * 60 * 60 * 1000);
        const initialDelayMs = Number.isFinite(configuredInitialDelayMs) ? Math.max(5_000, configuredInitialDelayMs) : 30_000;
        const intervalMs = Number.isFinite(configuredIntervalMs) ? Math.max(60 * 60 * 1000, configuredIntervalMs) : 6 * 60 * 60 * 1000;
        const initialTimer = setTimeout(() => {
            void updateChecker.checkNow();
        }, initialDelayMs);
        initialTimer.unref?.();
        updateCheckTimer = setInterval(() => {
            void updateChecker.checkNow();
        }, intervalMs);
        updateCheckTimer.unref?.();
    }
}

async function startApplication(): Promise<void> {
    await initializeApplication();
    server = app.listen(PORT, async () => {
        const telegramConfig = await applyEffectiveTelegramBotConfig();
        const telegramEnabled = telegramConfig.configured && telegramConfig.enabled;
        const initialSetupRequired = await isInitialSetupRequired();
        console.log(`
🚀 TG Vault 后端服务已启动
🏷️  版本: v${APP_VERSION}
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
    if (updateCheckTimer) clearInterval(updateCheckTimer);
    updateCheckTimer = null;
    if (readinessProbeTimer) clearInterval(readinessProbeTimer);
    readinessProbeTimer = null;
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
