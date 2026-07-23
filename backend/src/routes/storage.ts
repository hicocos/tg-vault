import { Router, Request, Response } from 'express';
import checkDiskSpaceModule from 'check-disk-space';
import { pool, query } from '../db/index.js';
import { requireAuth } from './auth.js';
import os from 'os';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import crypto from 'crypto';
import { getSetting, setSetting } from '../utils/settings.js';
import { getConfiguredTelegramAllowedUsers, parseTelegramAllowedUserIds, setTelegramAllowedUsers } from '../utils/authSettings.js';
import { getTelegramUserSessionFilePath, isTelegramUserClientReady } from '../services/telegramUserClient.js';
import { assertPublicStorageEndpoint } from '../utils/networkSecurity.js';
import { getCurrentStorageScope } from '../utils/fileScope.js';
import { getAuthToken } from './auth.js';
import { oauthFlowStore, OAuthFlowError, type OAuthProvider } from '../services/oauthFlowStore.js';
import { getOAuthRouteConfig, renderOAuthSuccessPage } from '../services/oauthRouteConfig.js';
import { deleteStorageAccountWithClient, StorageAccountConflictError, StorageAccountNotFoundError } from '../services/storageAccountLifecycle.js';
import { logOperationalEvent } from '../services/operationalEvents.js';
import { webDestructiveConfirmationStore } from '../services/webDestructiveConfirmation.js';
import { StorageProbeError } from '../services/storage.js';
import { getTelegramUserClientStatus } from '../services/telegramUserClientStatus.js';
import { maintenanceImpact } from '../utils/maintenanceActions.js';
import { buildStorageCapabilities, buildStorageStatsPayload } from '../utils/storageProductContract.js';
import { buildAdvancedSettings, normalizeAdvancedSettingsPatch } from '../utils/advancedSettings.js';
import { getFileDownloadConcurrency, setFileDownloadConcurrency } from '../services/telegramUpload.js';
import { startPeriodicCleanup, stopPeriodicCleanup } from '../services/orphanCleanup.js';

// ESM compatibility
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';

function sendStorageOperationError(res: Response, error: unknown, fallback: string): void {
    if (error instanceof StorageProbeError) {
        res.status(error.causeCode === 'ACCOUNT_NOT_FOUND' ? 404 : 422).json({
            error: error.message,
            code: 'STORAGE_PROBE_FAILED',
            provider: error.provider,
            retryable: true,
        });
        return;
    }
    res.status(500).json({ error: fallback });
}

function sendOAuthSuccessPage(res: Response, input: {
    provider: OAuthProvider;
    providerName: string;
    frontendOrigin: string;
    flowNonce: string;
    accountId?: string;
}): void {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "style-src 'unsafe-inline'",
        `script-src 'nonce-${nonce}'`,
        "script-src-attr 'none'",
        "base-uri 'none'",
        "object-src 'none'",
    ].join('; '));
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    res.type('html').send(renderOAuthSuccessPage({ ...input, scriptNonce: nonce }));
}

function getOAuthSessionToken(req: Request): string {
    const token = getAuthToken(req);
    if (!token) throw new OAuthFlowError();
    return token;
}

function sendOAuthFlowError(res: Response, error: unknown): void {
    if (error instanceof OAuthFlowError) {
        res.status(400).type('text/plain').send(error.message);
        return;
    }
    throw error;
}

// 获取存储统计：服务器临时空间、当前账户索引量和远端 quota 分开表达。
router.get('/stats', requireAuth, async (_req: Request, res: Response) => {
    try {
        const diskPath = os.platform() === 'win32' ? 'C:' : path.resolve(UPLOAD_DIR);
        const diskSpace = await checkDiskSpace(diskPath);
        const scope = await getCurrentStorageScope();
        const result = await query(`
            SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size
            FROM files WHERE ${scope.clause}
        `, scope.params);
        const { storageManager } = await import('../services/storage.js');
        const provider = storageManager.getProvider();
        const activeAccountId = storageManager.getActiveAccountId();
        const account = activeAccountId
            ? (await query(`SELECT last_probe_status, last_probed_at FROM storage_accounts WHERE id = $1`, [activeAccountId])).rows[0]
            : null;
        const cooldown = activeAccountId
            ? (await query(`SELECT reason, cooldown_until FROM storage_account_cooldowns
                            WHERE storage_account_id = $1 AND cooldown_until > NOW()
                            ORDER BY cooldown_until DESC LIMIT 1`, [activeAccountId])).rows[0]
            : null;
        let remoteQuota: { totalBytes: number; usedBytes: number } | null = null;
        if (provider.getQuota) {
            try { remoteQuota = await provider.getQuota(); }
            catch (error) { console.warn('获取远端存储配额失败:', (error as Error).message); }
        }
        const payload = buildStorageStatsPayload({
            disk: { totalBytes: diskSpace.size, freeBytes: diskSpace.free },
            indexed: {
                usedBytes: Number(result.rows[0]?.total_size || 0),
                fileCount: Number(result.rows[0]?.file_count || 0),
            },
            remoteQuota,
            health: {
                probeStatus: account?.last_probe_status || (provider.name === 'local' ? 'available' : null),
                lastProbedAt: account?.last_probed_at ? new Date(account.last_probed_at).toISOString() : null,
                cooldownUntil: cooldown?.cooldown_until ? new Date(cooldown.cooldown_until).toISOString() : null,
                cooldownReason: cooldown?.reason || null,
            },
        });
        res.json({
            ...payload,
            provider: provider.name,
            accountId: activeAccountId,
            capabilities: buildStorageCapabilities(provider.name),
            // Transitional aliases for already-deployed clients. Indexed usage has no fake percentage.
            server: {
                total: formatBytes(payload.temporary.totalBytes), totalBytes: payload.temporary.totalBytes,
                used: formatBytes(payload.temporary.usedBytes), usedBytes: payload.temporary.usedBytes,
                free: formatBytes(payload.temporary.freeBytes), freeBytes: payload.temporary.freeBytes,
                usedPercent: payload.temporary.usedPercent,
            },
            tgvault: {
                used: formatBytes(payload.indexed.usedBytes), usedBytes: payload.indexed.usedBytes,
                fileCount: payload.indexed.fileCount,
            },
        });
    } catch (error) {
        console.error('获取存储统计失败:', error);
        res.status(500).json({ error: '获取存储统计失败' });
    }
});

// 获取文件类型统计
router.get('/stats/types', requireAuth, async (_req: Request, res: Response) => {
    try {
        const scope = await getCurrentStorageScope();
        const result = await query(`
            SELECT
                type,
                COUNT(*) as count,
                COALESCE(SUM(size), 0) as total_size
            FROM files
            WHERE ${scope.clause}
            GROUP BY type
            ORDER BY total_size DESC
        `, scope.params);

        const stats = result.rows.map(row => ({
            type: row.type,
            count: parseInt(row.count),
            size: formatBytes(parseInt(row.total_size)),
            sizeBytes: parseInt(row.total_size),
        }));

        res.json(stats);
    } catch (error) {
        console.error('获取类型统计失败:', error);
        res.status(500).json({ error: '获取类型统计失败' });
    }
});

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}


// 获取存储配置
router.get('/config', requireAuth, async (req: Request, res: Response) => {
    try {
        const { storageManager } = await import('../services/storage.js');
        const provider = storageManager.getProvider();
        const activeAccountId = storageManager.getActiveAccountId();

        // 获取所有账户概览（不包含敏感配置）
        const accounts = await storageManager.getAccounts();
        const activeAccount = accounts.find(account => String(account.id) === String(activeAccountId || ''));
        const telegramUserDownloadEnabled = await getSetting('telegram_user_download_enabled', 'false');
        const telegramAllowedUserIds = await getConfiguredTelegramAllowedUsers();
        const telegramAllowedUserIdsFromEnv = parseTelegramAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS || '').length > 0;
        const telegramUserSessionFilePath = getTelegramUserSessionFilePath();
        const telegramUserSessionReady = fs.existsSync(telegramUserSessionFilePath) && isTelegramUserClientReady();

        const oneDriveOAuth = getOAuthRouteConfig('onedrive');
        const googleDriveOAuth = getOAuthRouteConfig('google_drive');

        res.json({
            provider: provider.name,
            activeAccountId,
            activeAccountName: activeAccount?.name || (provider.name === 'local' ? '服务器本地目录' : undefined),
            capabilities: buildStorageCapabilities(provider.name),
            accounts: accounts.map(account => ({ ...account, capabilities: buildStorageCapabilities(String(account.type)) })),
            redirectUri: oneDriveOAuth.redirectUri,
            googleDriveRedirectUri: googleDriveOAuth.redirectUri,
            telegramUserDownloadEnabled: telegramUserDownloadEnabled === 'true',
            telegramUserSessionReady,
            telegramUserClientStatus: getTelegramUserClientStatus(),
            telegramAllowedUserIds,
            telegramAllowedUserIdsFromEnv,
        });
    } catch (error) {
        console.error('获取存储配置失败:', error);
        res.status(500).json({ error: '获取存储配置失败' });
    }
});

router.get('/config/advanced-tasks', requireAuth, async (_req: Request, res: Response) => {
    try {
        res.json(buildAdvancedSettings({
            telegramDownloadWorkers: await getSetting('telegram_download_workers', process.env.TELEGRAM_DOWNLOAD_WORKERS || '4'),
            telegramFileConcurrency: await getSetting('telegram_file_download_concurrency', String(getFileDownloadConcurrency())),
            duplicateMode: await getSetting('duplicate_file_mode', process.env.DUPLICATE_FILE_MODE || 'copy'),
            autoCleanupOrphans: await getSetting('auto_cleanup_orphans', process.env.AUTO_CLEANUP_ORPHANS || 'true'),
        }));
    } catch (error) {
        console.error('获取高级任务设置失败:', error);
        res.status(500).json({ error: '获取高级任务设置失败' });
    }
});

router.patch('/config/advanced-tasks', requireAuth, async (req: Request, res: Response) => {
    try {
        const { confirmed, ...requestedPatch } = req.body || {};
        const patch = normalizeAdvancedSettingsPatch(requestedPatch);
        if (patch.highRisk && confirmed !== true) {
            return res.status(409).json({ error: '高并发设置需要二次确认', code: 'CONFIRMATION_REQUIRED' });
        }
        if ('telegramDownloadWorkers' in patch) {
            await setSetting('telegram_download_workers', String(patch.telegramDownloadWorkers));
            process.env.TELEGRAM_DOWNLOAD_WORKERS = String(patch.telegramDownloadWorkers);
        } else if ('telegramFileConcurrency' in patch) {
            await setSetting('telegram_file_download_concurrency', String(patch.telegramFileConcurrency));
            setFileDownloadConcurrency(Number(patch.telegramFileConcurrency));
        } else if ('duplicateMode' in patch) {
            await setSetting('duplicate_file_mode', String(patch.duplicateMode));
            process.env.DUPLICATE_FILE_MODE = String(patch.duplicateMode);
        } else if ('autoCleanupOrphans' in patch) {
            const enabled = Boolean(patch.autoCleanupOrphans);
            await setSetting('auto_cleanup_orphans', String(enabled));
            process.env.AUTO_CLEANUP_ORPHANS = String(enabled);
            if (enabled) startPeriodicCleanup(); else stopPeriodicCleanup();
        }
        return res.json({ success: true, ...patch });
    } catch (error) {
        res.status(400).json({ error: (error as Error).message });
    }
});

router.post('/config/telegram-user-download', requireAuth, async (req: Request, res: Response) => {
    try {
        const enabled = !!req.body?.enabled;
        if (enabled && !isTelegramUserClientReady()) {
            return res.status(400).json({ error: 'Telegram 用户 session 未就绪，请先生成 session 并重启后端' });
        }
        await setSetting('telegram_user_download_enabled', enabled ? 'true' : 'false');
        res.json({ success: true, enabled });
    } catch (error) {
        console.error('更新 Telegram 用户下载设置失败:', error);
        res.status(500).json({ error: '更新 Telegram 用户下载设置失败' });
    }
});

router.post('/config/telegram-allowed-users', requireAuth, async (req: Request, res: Response) => {
    try {
        if (parseTelegramAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS || '').length > 0) {
            return res.status(409).json({ error: '当前已通过 TELEGRAM_ALLOWED_USER_IDS 环境变量配置允许列表，请修改 .env 并重启后端。' });
        }
        const rawUserIds = Array.isArray(req.body?.userIds)
            ? req.body.userIds.join(',')
            : String(req.body?.userIds ?? '');
        const userIds = parseTelegramAllowedUserIds(rawUserIds);
        if (userIds.length === 0) {
            return res.status(400).json({ error: '请至少填写一个 Telegram user id' });
        }
        const saved = await setTelegramAllowedUsers(userIds);
        res.json({ success: true, userIds: saved });
    } catch (error) {
        console.error('更新 Telegram 允许用户列表失败:', error);
        res.status(500).json({ error: '更新 Telegram 允许用户列表失败' });
    }
});

router.post('/maintenance/download-items/cleanup', requireAuth, async (req: Request, res: Response) => {
    try {
        const retentionDays = Math.min(365, Math.max(1, parseInt(String(req.body?.retentionDays ?? '7'), 10) || 7));
        const preview = await query(
            `SELECT COUNT(*)::int AS count FROM telegram_download_items
             WHERE status IN ('success', 'failed', 'skipped')
               AND COALESCE(completed_at, updated_at, created_at) < NOW() - ($1::int * INTERVAL '1 day')`,
            [retentionDays]
        );
        const dryRunCount = Number(preview.rows[0]?.count || 0);
        if (req.body?.dryRun === true) {
            return res.json({ success: true, retentionDays, ...maintenanceImpact('DELETE_TASK_HISTORY', dryRunCount) });
        }
        const result = await query(
            `DELETE FROM telegram_download_items
             WHERE status IN ('success', 'failed', 'skipped')
               AND COALESCE(completed_at, updated_at, created_at) < NOW() - ($1::int * INTERVAL '1 day')`,
            [retentionDays]
        );
        res.json({
            success: true,
            deletedCount: result.rowCount || 0,
            retentionDays,
            ...maintenanceImpact('DELETE_TASK_HISTORY', dryRunCount),
        });
    } catch (error) {
        console.error('清理下载任务明细失败:', error);
        res.status(500).json({ error: '清理下载任务明细失败' });
    }
});

// 获取 OneDrive 授权 URL
router.post('/config/onedrive/auth-url', requireAuth, async (req: Request, res: Response) => {
    try {
        const { clientId, tenantId, clientSecret, name } = req.body;
        if (!clientId) {
            return res.status(400).json({ error: '缺少 Client ID' });
        }
        const routeConfig = getOAuthRouteConfig('onedrive');
        const flow = await oauthFlowStore.issue({
            provider: 'onedrive',
            authSessionToken: getOAuthSessionToken(req),
            redirectUri: routeConfig.redirectUri,
            config: {
                clientId: String(clientId),
                clientSecret: clientSecret ? String(clientSecret) : '',
                tenantId: tenantId ? String(tenantId) : 'common',
                name: name ? String(name) : '',
            },
        });
        const { OneDriveStorageProvider } = await import('../services/storage.js');
        const authUrl = OneDriveStorageProvider.generateAuthUrl(
            String(clientId),
            tenantId ? String(tenantId) : 'common',
            routeConfig.redirectUri,
            flow.state,
        );
        res.json({ authUrl, flowNonce: flow.flowNonce, expiresAt: flow.expiresAt.toISOString(), frontendOrigin: routeConfig.frontendOrigin });
    } catch (error) {
        console.error('获取授权 URL 失败:', error);
        res.status(500).json({ error: '获取授权 URL 失败' });
    }
});

// OneDrive OAuth 回调
router.get('/onedrive/callback', async (req: Request, res: Response) => {
    try {
        const { code, state, error, error_description } = req.query;
        if (error) return res.type('text/plain').send(`授权失败: ${String(error_description || error)}`);
        if (!code || typeof code !== 'string') return res.status(400).send('缺少授权码 (code)');
        if (!state || typeof state !== 'string') return res.status(400).send('缺少 OAuth state');

        const flow = await oauthFlowStore.consume({
            state,
            provider: 'onedrive',
            authSessionToken: getOAuthSessionToken(req),
        });
        const { clientId, clientSecret = '', tenantId = 'common', name = '' } = flow.config;
        if (typeof clientId !== 'string' || !clientId) return res.status(400).send('OAuth 配置信息不完整');

        const { storageManager, OneDriveStorageProvider } = await import('../services/storage.js');
        let tokens;
        try {
            tokens = await OneDriveStorageProvider.exchangeCodeForToken(
                clientId,
                typeof clientSecret === 'string' ? clientSecret : '',
                typeof tenantId === 'string' ? tenantId : 'common',
                flow.redirectUri,
                code,
            );
        } catch (err: any) {
            const msError = err.response?.data;
            const errorCode = Array.isArray(msError?.error_codes) ? msError.error_codes[0] : undefined;
            const errorDescription = msError?.error_description || err.message || '未知错误';
            if (errorCode === 7000215 || /invalid client secret|AADSTS7000215/i.test(errorDescription)) {
                return res.status(400).send('授权失败：Microsoft 返回 AADSTS7000215，Client Secret 无效。请复制客户端密码的值 Value。');
            }
            return res.status(err.response?.status || 400).type('text/plain').send(`授权失败：${String(errorDescription)}`);
        }

        let accountName = 'OneDrive Account';
        try {
            const profileRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
                headers: { 'Authorization': `Bearer ${tokens.access_token}` }
            });
            accountName = profileRes.data.mail || profileRes.data.userPrincipalName || accountName;
        } catch {
            // User.Read is optional for account creation.
        }
        const accountId = await storageManager.addOneDriveAccount(
            typeof name === 'string' && name ? name : accountName,
            clientId,
            typeof clientSecret === 'string' ? clientSecret : '',
            tokens.refresh_token,
            typeof tenantId === 'string' ? tenantId : 'common',
        );
        await storageManager.switchAccount(accountId);
        const routeConfig = getOAuthRouteConfig('onedrive');
        sendOAuthSuccessPage(res, {
            provider: 'onedrive',
            providerName: 'OneDrive',
            frontendOrigin: routeConfig.frontendOrigin,
            flowNonce: flow.flowNonce,
            accountId,
        });
    } catch (error: any) {
        try {
            sendOAuthFlowError(res, error);
        } catch (unexpected) {
            console.error('OneDrive 回调处理失败:', unexpected);
            res.status(500).send('授权处理出错，请检查后端日志。');
        }
    }
});

// 获取 Google Drive 授权 URL
router.post('/config/google-drive/auth-url', requireAuth, async (req: Request, res: Response) => {
    try {
        const { clientId, clientSecret, name, sharedDriveId } = req.body;
        if (!clientId || !clientSecret) {
            return res.status(400).json({ error: '缺少必要参数 (Client ID 或 Client Secret)' });
        }
        const routeConfig = getOAuthRouteConfig('google_drive');
        const flow = await oauthFlowStore.issue({
            provider: 'google_drive',
            authSessionToken: getOAuthSessionToken(req),
            redirectUri: routeConfig.redirectUri,
            config: {
                clientId: String(clientId),
                clientSecret: String(clientSecret),
                name: name ? String(name) : '',
                sharedDriveId: sharedDriveId ? String(sharedDriveId).trim() : '',
            },
        });
        const { GoogleDriveStorageProvider } = await import('../services/storage.js');
        const authUrl = GoogleDriveStorageProvider.generateAuthUrl(
            String(clientId),
            String(clientSecret),
            routeConfig.redirectUri,
            flow.state,
        );
        res.json({ authUrl, flowNonce: flow.flowNonce, expiresAt: flow.expiresAt.toISOString(), frontendOrigin: routeConfig.frontendOrigin });
    } catch (error) {
        console.error('获取 Google Drive 授权 URL 失败:', error);
        res.status(500).json({ error: '获取授权 URL 失败' });
    }
});

// Google Drive OAuth 回调
router.get('/google-drive/callback', async (req: Request, res: Response) => {
    try {
        const { code, state, error } = req.query;
        if (error) return res.type('text/plain').send(`授权失败: ${String(error)}`);
        if (!code || typeof code !== 'string') return res.status(400).send('缺少授权码 (code)');
        if (!state || typeof state !== 'string') return res.status(400).send('缺少 OAuth state');

        const flow = await oauthFlowStore.consume({
            state,
            provider: 'google_drive',
            authSessionToken: getOAuthSessionToken(req),
        });
        const { clientId, clientSecret, name = '', sharedDriveId = '' } = flow.config;
        if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) {
            return res.status(400).send('OAuth 配置信息不完整');
        }
        const { storageManager, GoogleDriveStorageProvider } = await import('../services/storage.js');
        const tokens = await GoogleDriveStorageProvider.exchangeCodeForToken(clientId, clientSecret, flow.redirectUri, code);
        if (!tokens.refresh_token) {
            return res.status(400).send('授权失败：未获得 Refresh Token。请在 Google 控制台中撤销权限后重试。');
        }
        const accountId = await storageManager.addGoogleDriveAccount(
            typeof name === 'string' && name ? name : 'Google Drive Account',
            clientId,
            clientSecret,
            tokens.refresh_token,
            flow.redirectUri,
            typeof sharedDriveId === 'string' ? sharedDriveId : '',
        );
        await storageManager.switchAccount(accountId);
        const routeConfig = getOAuthRouteConfig('google_drive');
        sendOAuthSuccessPage(res, {
            provider: 'google_drive',
            providerName: 'Google Drive',
            frontendOrigin: routeConfig.frontendOrigin,
            flowNonce: flow.flowNonce,
            accountId,
        });
    } catch (error: any) {
        try {
            sendOAuthFlowError(res, error);
        } catch (unexpected) {
            console.error('Google Drive 回调处理失败:', unexpected);
            res.status(500).send('授权处理出错，请检查后端日志。');
        }
    }
});

// 更新 OneDrive 配置
router.put('/config/onedrive', requireAuth, async (req: Request, res: Response) => {
    try {
        const { clientId, clientSecret, refreshToken, tenantId, name } = req.body;

        if (!clientId || !refreshToken) {
            return res.status(400).json({ error: '缺少必要参数 (Client ID 和 Refresh Token)' });
        }

        const { storageManager } = await import('../services/storage.js');
        await storageManager.updateOneDriveConfig(clientId, clientSecret || '', refreshToken, tenantId || 'common', name);

        res.json({ success: true, message: 'OneDrive 配置已更新并切换' });
    } catch (error) {
        console.error('更新 OneDrive 配置失败:', error);
        res.status(500).json({ error: '更新 OneDrive 配置失败' });
    }
});

// 添加 Aliyun OSS 配置
router.post('/config/aliyun-oss', requireAuth, async (req: Request, res: Response) => {
    try {
        const { name, region, accessKeyId, accessKeySecret, bucket } = req.body;

        if (!name || !region || !accessKeyId || !accessKeySecret || !bucket) {
            return res.status(400).json({ error: '缺少必要参数' });
        }

        const { storageManager } = await import('../services/storage.js');
        const accountId = await storageManager.addAliyunOSSAccount(name, region, accessKeyId, accessKeySecret, bucket);

        res.json({ success: true, message: 'Aliyun OSS 账户已添加', accountId });
    } catch (error) {
        console.error('添加 Aliyun OSS 配置失败:', error);
        sendStorageOperationError(res, error, '添加 Aliyun OSS 配置失败');
    }
});

// 添加 S3 存储配置
router.post('/config/s3', requireAuth, async (req: Request, res: Response) => {
    try {
        const { name, endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle } = req.body;

        if (!name || !endpoint || !region || !accessKeyId || !accessKeySecret || !bucket) {
            return res.status(400).json({ error: '缺少必要参数' });
        }

        await assertPublicStorageEndpoint(endpoint);

        const { storageManager } = await import('../services/storage.js');
        const accountId = await storageManager.addS3Account(name, endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle || false);

        res.json({ success: true, message: 'S3 存储账户已添加', accountId });
    } catch (error) {
        console.error('添加 S3 配置失败:', error);
        sendStorageOperationError(res, error, '添加 S3 配置失败');
    }
});

// 添加 WebDAV 存储配置
router.post('/config/webdav', requireAuth, async (req: Request, res: Response) => {
    try {
        const { name, url, username, password } = req.body;

        if (!name || !url) {
            return res.status(400).json({ error: '缺少必要参数 (名称和 URL)' });
        }

        await assertPublicStorageEndpoint(url);

        const { storageManager } = await import('../services/storage.js');
        const accountId = await storageManager.addWebDAVAccount(name, url, username, password);

        res.json({ success: true, message: 'WebDAV 存储账户已添加', accountId });
    } catch (error) {
        console.error('添加 WebDAV 配置失败:', error);
        sendStorageOperationError(res, error, '添加 WebDAV 配置失败');
    }
});

// 切换存储提供商或具体账户
router.post('/switch', requireAuth, async (req: Request, res: Response) => {
    try {
        const { provider, accountId } = req.body;
        const { storageManager } = await import('../services/storage.js');

        if (provider === 'local') {
            await storageManager.switchToLocal();
            return res.json({ success: true, message: '已切换到本地存储。该系统默认值只影响后续新任务，已提交任务目标保持不变。', scope: 'global_default', inFlightTargetsPreserved: true });
        } else if (provider === 'onedrive' || provider === 'aliyun_oss' || provider === 's3' || provider === 'webdav' || provider === 'google_drive') {
            if (accountId) {
                await storageManager.switchAccount(accountId);
                return res.json({ success: true, message: `已切换 ${provider} 账户。该系统默认值只影响后续新任务，已提交任务目标保持不变。`, scope: 'global_default', inFlightTargetsPreserved: true });
            } else {
                // 如果没有指定 accountId，尝试切换到最后一个激活的或第一个该类型的账户
                const accounts = await storageManager.getAccounts();
                const account = accounts.find(a => a.type === provider);
                if (!account) {
                    return res.status(400).json({ error: `未配置任何 ${provider} 账户` });
                }
                await storageManager.switchAccount(account.id);
                return res.json({ success: true, message: `已切换到 ${provider}。该系统默认值只影响后续新任务，已提交任务目标保持不变。`, scope: 'global_default', inFlightTargetsPreserved: true });
            }
        } else {
            return res.status(400).json({ error: '无效的存储提供商' });
        }
    } catch (error) {
        console.error('切换存储失败:', error);
        sendStorageOperationError(res, error, '切换存储失败，当前默认账户未改变');
    }
});

// 获取账户列表
router.get('/accounts', requireAuth, async (req: Request, res: Response) => {
    try {
        const { storageManager } = await import('../services/storage.js');
        const accounts = await storageManager.getAccounts();
        res.json(accounts);
    } catch (error) {
        console.error('获取账户列表失败:', error);
        res.status(500).json({ error: '获取账户列表失败' });
    }
});

// 对现有账户执行只读连接测试，不创建、修改或删除远端对象。
router.post('/accounts/:id/probe', requireAuth, async (req: Request, res: Response) => {
    try {
        const { storageManager } = await import('../services/storage.js');
        const result = await storageManager.probeAccount(req.params.id);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('存储账户连接测试失败:', error);
        sendStorageOperationError(res, error, '存储账户连接测试失败');
    }
});

// 为账户及其索引删除签发一次性确认令牌，同时返回当前影响快照。
router.post('/accounts/:id/delete-confirmation', requireAuth, async (req: Request, res: Response) => {
    const account = await query('SELECT id, name, type, is_active FROM storage_accounts WHERE id = $1', [req.params.id]);
    if (!account.rows[0]) return res.status(404).json({ error: '存储账户不存在' });
    if (account.rows[0].is_active) return res.status(409).json({ error: '不能删除当前正在使用的存储账户' });
    const authToken = getAuthToken(req);
    if (!authToken) return res.status(401).json({ error: '未认证' });
    const [impact, leases, tasks, uploads] = await Promise.all([
        query(`SELECT COUNT(*)::int AS file_count,
                      COALESCE(SUM(size), 0)::bigint AS total_size,
                      COUNT(DISTINCT folder) FILTER (WHERE folder IS NOT NULL AND folder <> '')::int AS folder_count,
                      encode(digest(COALESCE(string_agg(id::text, ',' ORDER BY id), ''), 'sha256'), 'hex') AS file_fingerprint
               FROM files WHERE storage_account_id = $1`, [req.params.id]),
        query(`SELECT COUNT(*)::int AS count FROM storage_account_leases
               WHERE storage_account_id = $1 AND released_at IS NULL AND expires_at > NOW()`, [req.params.id]),
        query(`SELECT COUNT(*)::int AS count FROM transfer_tasks
               WHERE target_account_id = $1
                 AND (status IN ('pending', 'running', 'paused', 'interrupted', 'retry_required') OR retryable = true)`, [req.params.id]),
        query(`SELECT COUNT(*)::int AS count FROM chunk_upload_sessions
               WHERE target_account_id = $1 AND status IN ('open', 'completing', 'failed')`, [req.params.id]),
    ]);
    const snapshot = impact.rows[0] || {};
    res.json({
        ...webDestructiveConfirmationStore.issue({ authToken, action: 'delete_storage_account', objectId: req.params.id, context: String(snapshot.file_fingerprint) }),
        impact: {
            accountId: req.params.id,
            accountName: String(account.rows[0].name),
            provider: String(account.rows[0].type),
            fileCount: Number(snapshot.file_count || 0),
            totalSizeBytes: Number(snapshot.total_size || 0),
            folderCount: Number(snapshot.folder_count || 0),
            activeLeaseCount: Number(leases.rows[0]?.count || 0),
            activeTaskCount: Number(tasks.rows[0]?.count || 0),
            activeUploadCount: Number(uploads.rows[0]?.count || 0),
            remoteObjectsDeleted: false,
        },
    });
});

// 删除账户
router.delete('/accounts/:id', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    const authToken = getAuthToken(req);
    const confirmationToken = String(req.header('x-confirmation-token') || '');
    if (!authToken || !confirmationToken) return res.status(409).json({ error: '需要一次性删除确认令牌', code: 'CONFIRMATION_REQUIRED' });
    const { storageManager } = await import('../services/storage.js');
    const client = await pool.connect();
    let accountName = '';
    let accountType = '';
    let deletedFiles = 0;
    try {
        await client.query('BEGIN');
        const lockedAccount = await client.query('SELECT id FROM storage_accounts WHERE id = $1 FOR UPDATE', [id]);
        if (!lockedAccount.rows[0]) throw new StorageAccountNotFoundError();
        const fingerprint = await client.query(
            `SELECT encode(digest(COALESCE(string_agg(id::text, ',' ORDER BY id), ''), 'sha256'), 'hex') AS value
             FROM files WHERE storage_account_id = $1`,
            [id],
        );
        const confirmation = webDestructiveConfirmationStore.consume(confirmationToken, {
            authToken,
            action: 'delete_storage_account',
            objectId: id,
            context: String(fingerprint.rows[0]?.value || ''),
        });
        if (confirmation.status !== 'ok') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: '账户内容已变化，请重新预览并确认', code: 'CONFIRMATION_REQUIRED' });
        }
        const deleted = await deleteStorageAccountWithClient(client, id);
        if (storageManager.getActiveAccountId() === id) throw new StorageAccountConflictError('active');
        accountName = deleted.name;
        accountType = deleted.type;
        deletedFiles = deleted.deletedFiles;
        await client.query('COMMIT');

        storageManager.removeProvider(`${accountType}:${id}`);
        logOperationalEvent('storage.account.deleted', res.locals.requestId || null, {
            accountId: id,
            provider: accountType,
            deletedIndexes: deletedFiles,
        });
        res.json({ success: true, message: `已删除账户: ${accountName}，已清理 ${deletedFiles} 条关联文件索引` });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (error instanceof StorageAccountNotFoundError) {
            return res.status(404).json({ error: error.message });
        }
        if (error instanceof StorageAccountConflictError) {
            return res.status(error.kind === 'active' ? 400 : 409).json({ error: error.message });
        }
        console.error('删除账户失败:', error);
        res.status(500).json({ error: '删除账户失败' });
    } finally {
        client.release();
    }
});

export default router;
