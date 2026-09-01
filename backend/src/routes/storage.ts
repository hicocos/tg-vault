import { Router, Request, Response } from 'express';
import checkDiskSpaceModule from 'check-disk-space';
import { pool, query } from '../db/index.js';
import { requireAuth } from './auth.js';
import os from 'os';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import crypto from 'crypto';
import { rateLimit } from 'express-rate-limit';
import { getSetting, setSetting } from '../utils/settings.js';
import { changeTelegramPin, ensureTelegramPinConfigured, getConfiguredTelegramAllowedUsers, parseTelegramAllowedUserIds, setTelegramAllowedUsersAndReconcile, TelegramPinChangeError } from '../utils/authSettings.js';
import { activateTelegramUserAccount, disableTelegramUserAccount, enableTelegramUserAccount, getTelegramUserAccountStatus, getTelegramUserSessionFilePath, isTelegramUserClientReady, telegramUserWebLogin, unlinkTelegramUserAccount } from '../services/telegramUserClient.js';
import { telegramAccountRepository } from '../services/telegramAccountRepository.js';
import { telegramUserClientPool } from '../services/telegramMultiAccountRuntime.js';
import { triggerTelegramAccountAccessSweep, getTelegramAccountAccessSweepSummary } from '../services/telegramAccountAccessSweep.js';
import { telegramMultiAccountLoginFlows } from '../services/telegramMultiAccountLogin.js';
import { assertPublicStorageEndpoint, assertStorageEndpoint } from '../utils/networkSecurity.js';
import { getCurrentStorageScope } from '../utils/fileScope.js';
import { getAuthToken } from './auth.js';
import { oauthFlowStore, OAuthFlowError, type OAuthProvider } from '../services/oauthFlowStore.js';
import { getOAuthRouteConfig, renderOAuthFailurePage, renderOAuthSuccessPage } from '../services/oauthRouteConfig.js';
import { deleteStorageAccountWithClient, StorageAccountConflictError, StorageAccountNotFoundError } from '../services/storageAccountLifecycle.js';
import { logOperationalEvent } from '../services/operationalEvents.js';
import { webDestructiveConfirmationStore } from '../services/webDestructiveConfirmation.js';
import { buildStorageDeletePreviewQueries } from '../services/storageDeletePreview.js';
import { StorageProbeError } from '../services/storage.js';
import { getTelegramUserClientStatus } from '../services/telegramUserClientStatus.js';
import { getTelegramBotStatus } from '../services/telegramBotStatus.js';
import { formatBytes } from '../utils/fileMetadata.js';
import {
    applyEffectiveTelegramBotConfig,
    deleteTelegramBotConfig,
    getEnvironmentTelegramBotCredentials,
    getEffectiveTelegramBotConfig,
    getTelegramBotPublicConfig,
    migrateEnvironmentTelegramBotConfig,
    normalizeTelegramBotCredentials,
    restoreTelegramBotConfig,
    saveTelegramBotConfig,
    snapshotTelegramBotConfig,
    setTelegramBotEnabled,
    setTelegramBotIdentity,
    testTelegramBotCredentials,
} from '../services/telegramBotConfig.js';
import { withTelegramBotLifecycle } from '../services/telegramBot.js';
import { maintenanceImpact } from '../utils/maintenanceActions.js';
import { buildStorageCapabilities, buildStorageScopeForTarget, buildStorageStatsPayload } from '../utils/storageProductContract.js';
import { buildAdvancedSettings, normalizeAdvancedSettingsPatch } from '../utils/advancedSettings.js';
import { getFileDownloadConcurrency, setFileDownloadConcurrency } from '../services/telegramUpload.js';
import { startPeriodicCleanup, stopPeriodicCleanup } from '../services/orphanCleanup.js';
import {
    compactTelegramDownloadHistory,
    DEFAULT_TELEGRAM_DOWNLOAD_HISTORY_POLICY,
    TELEGRAM_DOWNLOAD_HISTORY_POLICY_SETTING,
} from '../services/telegramDownloadHistoryPolicy.js';

// ESM compatibility
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';

const telegramPinChangeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: '修改 Telegram Bot PIN 请求过于频繁，请 15 分钟后再试' },
    standardHeaders: true,
    legacyHeaders: false,
});

const telegramUserLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Telegram 用户账号登录请求过于频繁，请稍后再试' }, standardHeaders: true, legacyHeaders: false });
const telegramUserLoginStatusLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Telegram 登录状态查询过于频繁，请稍后再试' }, standardHeaders: true, legacyHeaders: false });
function getTelegramUserLoginSessionKey(req: Request): string { const token = getAuthToken(req); if (!token) throw new Error('UNAUTHORIZED'); return crypto.createHash('sha256').update(token).digest('base64url'); }
function sendTelegramUserLoginError(res: Response, error: unknown): void { const candidate = error as { code?: string; message?: string }; const status = candidate.code === 'ACCOUNT_ALREADY_BOUND' ? 409 : candidate.code === 'FLOW_NOT_FOUND' || candidate.code === 'FLOW_EXPIRED' ? 404 : candidate.code === 'TOO_MANY_ERRORS' ? 429 : 400; res.status(status).json({ error: candidate.message || 'Telegram 登录失败', code: candidate.code || 'TELEGRAM_ERROR' }); }

function noStore(res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
}

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

function sendStorageEndpointValidationError(res: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : '';
    const safeMessages = [
        '链接格式无效',
        '仅允许 http/https 链接',
        '不允许访问本机地址',
        '不允许访问内网、回环或保留地址',
        '存储端点仅允许 https；如确需 http，请显式设置 ALLOW_INSECURE_STORAGE_ENDPOINTS=true',
    ];
    res.status(400).json({ error: safeMessages.includes(message) ? message : '无法解析存储端点地址' });
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

function sendOAuthFailurePage(res: Response, input: {
    provider: OAuthProvider;
    providerName: string;
    frontendOrigin: string;
    flowNonce: string;
    error: string;
}): void {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`,
        "script-src-attr 'none'", "base-uri 'none'", "object-src 'none'",
    ].join('; '));
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    res.status(400).type('html').send(renderOAuthFailurePage({ ...input, scriptNonce: nonce }));
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
        const { storageManager } = await import('../services/storage.js');
        const target = storageManager.getActiveTarget();
        const provider = target.provider;
        const activeAccountId = target.accountId;
        const scope = buildStorageScopeForTarget({ providerName: provider.name, accountId: activeAccountId });
        const diskPath = os.platform() === 'win32' ? 'C:' : path.resolve(UPLOAD_DIR);
        const diskSpace = await checkDiskSpace(diskPath);
        const result = await query(`
            SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size
            FROM files WHERE ${scope.clause}
        `, scope.params);
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
        const allowUnsafeWebdavEndpoints = await getSetting('allow_unsafe_webdav_endpoints', 'false');
        const telegramAllowedUserIds = await getConfiguredTelegramAllowedUsers();
        const telegramAllowedUserIdsFromEnv = parseTelegramAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS || '').length > 0;
        const telegramUserSessionReady = isTelegramUserClientReady();

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
            allowUnsafeWebdavEndpoints: allowUnsafeWebdavEndpoints === 'true',
            telegramUserSessionReady,
            telegramUserClientStatus: getTelegramUserClientStatus(),
            telegramBotStatus: getTelegramBotStatus(),
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
            skipTelegramPhotosInBatch: await getSetting('skip_telegram_photos_in_batch', 'false'),
            telegramDownloadHistoryPolicy: await getSetting(
                TELEGRAM_DOWNLOAD_HISTORY_POLICY_SETTING,
                DEFAULT_TELEGRAM_DOWNLOAD_HISTORY_POLICY,
            ),
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
            const photoFilter = patch.skipTelegramPhotosInBatch === true;
            return res.status(409).json({
                error: photoFilter ? '开启跳过频道普通图片需要二次确认' : '高并发设置需要二次确认',
                code: 'CONFIRMATION_REQUIRED',
            });
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
        } else if ('skipTelegramPhotosInBatch' in patch) {
            const enabled = Boolean(patch.skipTelegramPhotosInBatch);
            await setSetting('skip_telegram_photos_in_batch', String(enabled));
        } else if ('telegramDownloadHistoryPolicy' in patch) {
            await setSetting(TELEGRAM_DOWNLOAD_HISTORY_POLICY_SETTING, String(patch.telegramDownloadHistoryPolicy));
            const deletedCount = await compactTelegramDownloadHistory();
            return res.json({ success: true, ...patch, deletedCount });
        }
        return res.json({ success: true, ...patch });
    } catch (error) {
        res.status(400).json({ error: (error as Error).message });
    }
});

router.patch('/config/webdav-security', requireAuth, async (req: Request, res: Response) => {
    try {
        const enabled = req.body?.enabled === true;
        const { confirmed } = req.body || {};
        if (enabled && confirmed !== true) {
            return res.status(409).json({
                error: '开启内网和不安全 WebDAV 地址需要二次确认',
                code: 'CONFIRMATION_REQUIRED',
            });
        }
        await setSetting('allow_unsafe_webdav_endpoints', enabled ? 'true' : 'false');
        return res.json({ success: true, allowUnsafeWebdavEndpoints: enabled });
    } catch (error) {
        console.error('更新 WebDAV 安全设置失败:', error);
        return res.status(500).json({ error: '更新 WebDAV 安全设置失败' });
    }
});

router.get('/config/telegram-bot', requireAuth, async (_req: Request, res: Response) => {
    noStore(res);
    try {
        return res.json(await getTelegramBotPublicConfig());
    } catch (error) {
        console.error('获取 Telegram Bot 配置状态失败:', (error as Error).message);
        return res.status(500).json({ error: '获取 Telegram Bot 配置状态失败' });
    }
});

router.post('/config/telegram-bot/test', requireAuth, async (req: Request, res: Response) => {
    noStore(res);
    try {
        const credentials = normalizeTelegramBotCredentials(req.body);
        const bot = await testTelegramBotCredentials(credentials);
        return res.json({ success: true, bot });
    } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : 'Telegram Bot 凭证测试失败' });
    }
});

router.put('/config/telegram-bot', requireAuth, async (req: Request, res: Response) => {
    noStore(res);
    try {
        const credentials = normalizeTelegramBotCredentials(req.body);
        const enabled = req.body?.enabled !== false;
        const required = req.body?.required === true;
        await withTelegramBotLifecycle(async controls => {
            await ensureTelegramPinConfigured(req.body?.telegramPin);
            const previous = await snapshotTelegramBotConfig();
            const previousEffective = await getEffectiveTelegramBotConfig();
            await saveTelegramBotConfig(credentials, { enabled, required });
            await applyEffectiveTelegramBotConfig();
            try {
                if (enabled) await controls.restart(credentials); else await controls.stop();
            } catch (activationError) {
                await restoreTelegramBotConfig(previous);
                const restored = await applyEffectiveTelegramBotConfig();
                if (previousEffective.enabled && restored.credentials) await controls.restart(restored.credentials);
                else await controls.stop();
                throw activationError;
            }
        });
        return res.json({ success: true, config: await getTelegramBotPublicConfig() });
    } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : '保存 Telegram Bot 配置失败' });
    }
});

router.post('/config/telegram-bot/migrate', requireAuth, async (req: Request, res: Response) => {
    noStore(res);
    try {
        const credentials = getEnvironmentTelegramBotCredentials();
        const bot = await testTelegramBotCredentials(credentials);
        await withTelegramBotLifecycle(async controls => {
            await ensureTelegramPinConfigured(req.body?.telegramPin);
            const previous = await snapshotTelegramBotConfig();
            try {
                await migrateEnvironmentTelegramBotConfig(credentials);
                setTelegramBotIdentity(bot);
                await applyEffectiveTelegramBotConfig();
                await controls.restart(credentials);
            } catch (activationError) {
                await restoreTelegramBotConfig(previous);
                await applyEffectiveTelegramBotConfig();
                await controls.restart(credentials);
                throw activationError;
            }
        });
        return res.json({ success: true, config: await getTelegramBotPublicConfig() });
    } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : '迁移 Telegram Bot 配置失败' });
    }
});

router.post('/config/telegram-bot/disable', requireAuth, async (_req: Request, res: Response) => {
    noStore(res);
    try {
        await withTelegramBotLifecycle(async controls => {
            await setTelegramBotEnabled(false);
            await applyEffectiveTelegramBotConfig();
            await controls.stop();
        });
        return res.json({ success: true, config: await getTelegramBotPublicConfig() });
    } catch {
        return res.status(500).json({ error: '停用 Telegram Bot 失败' });
    }
});

router.put('/config/telegram-bot/pin', requireAuth, telegramPinChangeLimiter, async (req: Request, res: Response) => {
    noStore(res);
    try {
        const current = await getTelegramBotPublicConfig();
        if (!current.configured) {
            return res.status(409).json({ error: '请先配置 Telegram Bot，再设置 PIN' });
        }
        await changeTelegramPin(req.body?.verificationMethod, req.body?.verificationSecret, req.body?.newPin);
        return res.json({
            success: true,
            message: current.pinConfigured
                ? 'Telegram Bot PIN 已修改；所有已认证的 Telegram 用户需要使用新 PIN 重新验证'
                : 'Telegram Bot PIN 已设置',
        });
    } catch (error) {
        if (error instanceof TelegramPinChangeError) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('修改 Telegram Bot PIN 失败:', error);
        return res.status(500).json({ error: '修改 Telegram Bot PIN 失败' });
    }
});

router.delete('/config/telegram-bot', requireAuth, async (req: Request, res: Response) => {
    noStore(res);
    if (req.body?.confirmed !== true) return res.status(409).json({ error: '删除 Telegram Bot 配置需要二次确认', code: 'CONFIRMATION_REQUIRED' });
    try {
        const current = await getTelegramBotPublicConfig();
        if (current.source !== 'web') return res.status(409).json({ error: '当前没有可删除的网页 Telegram Bot 配置' });
        await withTelegramBotLifecycle(async controls => {
            await controls.stop();
            await deleteTelegramBotConfig();
            const sessionPath = process.env.TELEGRAM_SESSION_FILE || './data/telegram_session.txt';
            if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { force: true });
            const effective = await applyEffectiveTelegramBotConfig();
            if (effective.source === 'environment' && effective.enabled && effective.credentials) await controls.restart(effective.credentials);
        });
        return res.json({ success: true, config: await getTelegramBotPublicConfig() });
    } catch {
        return res.status(500).json({ error: '删除 Telegram Bot 配置失败' });
    }
});

router.post('/config/telegram-user-download', requireAuth, async (req: Request, res: Response) => {
    try {
        const enabled = !!req.body?.enabled;
        if (enabled) await enableTelegramUserAccount(); else await disableTelegramUserAccount();
        if (enabled && !isTelegramUserClientReady()) return res.status(400).json({ error: 'Telegram 用户账号未就绪，请先在网页中登录' });
        res.json({ success: true, enabled });
    } catch (error) {
        console.error('更新 Telegram 用户下载设置失败:', error);
        res.status(500).json({ error: '更新 Telegram 用户下载设置失败' });
    }
});

router.get('/config/telegram-user', requireAuth, async (_req: Request, res: Response) => { noStore(res); res.json(await getTelegramUserAccountStatus()); });

// Multi-account login API. Successful authorization is delegated to the
// registered repository/pool adapter, which upserts by Telegram user id.
router.get('/config/telegram-user/accounts', requireAuth, async (_req: Request, res: Response) => {
    noStore(res);
    const accounts = await telegramAccountRepository.listAccounts();
    const publicAccounts = await Promise.all(accounts.map(async account => {
    const permissions = await telegramAccountRepository.listAccessForAccount(account.id);
        const permissionSummary = await telegramAccountRepository.getAccessSummaryForAccount(account.id);
        const allowed = permissionSummary.allowed;
        const denied = permissionSummary.denied;
        const unknown = permissionSummary.unknown;
        const lastCheckedAt = permissionSummary.lastCheckedAt?.toISOString?.() || null;
        return {
            id: account.id,
            userId: account.telegramUserId,
            username: account.username,
            displayName: account.displayName,
            enabled: account.enabled,
            connected: Boolean(telegramUserClientPool.getAccountClient(account.id)?.connected),
            health: !account.enabled ? 'disabled' : account.healthState === 'session_expired' ? 'expired' : account.cooldownUntil && new Date(account.cooldownUntil).getTime() > Date.now() ? 'cooldown' : telegramUserClientPool.getAccountClient(account.id) ? 'ready' : 'error',
            checkedAt: lastCheckedAt,
            lastError: account.lastError,
            cooldownUntil: account.cooldownUntil ? new Date(account.cooldownUntil).toISOString() : null,
            permissionSummary: { allowed, denied, unknown, total: permissionSummary.total, lastCheckedAt },
            permissions: permissions.map(row => ({ sourceId: row.sourceKey, sourceName: row.sourceKey, status: row.accessState, checkedAt: row.checkedAt?.toISOString?.() || null, reason: row.lastError })),
            scheduling: { weight: account.weight, activeDownloads: telegramUserClientPool.getActiveConnections(account.id), lastSelectedAt: null },
        };
    }));
    const aggregate = publicAccounts.reduce((sum, row) => ({
        allowed: sum.allowed + row.permissionSummary.allowed,
        denied: sum.denied + row.permissionSummary.denied,
        unknown: sum.unknown + row.permissionSummary.unknown,
        total: sum.total + row.permissionSummary.total,
        lastCheckedAt: !sum.lastCheckedAt || (row.permissionSummary.lastCheckedAt && row.permissionSummary.lastCheckedAt > sum.lastCheckedAt) ? row.permissionSummary.lastCheckedAt : sum.lastCheckedAt,
    }), { allowed: 0, denied: 0, unknown: 0, total: 0, lastCheckedAt: null as string | null });
    return res.json({
        accounts: publicAccounts,
        summary: { total: publicAccounts.length, enabled: publicAccounts.filter(row => row.enabled).length, ready: publicAccounts.filter(row => row.health === 'ready').length, coolingDown: publicAccounts.filter(row => row.health === 'cooldown').length, permissions: aggregate },
        scheduling: { strategy: 'weighted_least_connections', description: '权限感知的加权最少连接；同等负载自动轮换账号' },
        accessSweep: getTelegramAccountAccessSweepSummary(),
    });
});
router.post('/config/telegram-user/accounts/:accountId/enable', requireAuth, async (req: Request, res: Response) => { noStore(res); const ok = await telegramAccountRepository.setEnabled(req.params.accountId, true); if (!ok) return res.status(404).json({ error: '账号不存在' }); await activateTelegramUserAccount(req.params.accountId); return res.json({ success: true, enabled: true }); });
router.post('/config/telegram-user/accounts/:accountId/disable', requireAuth, async (req: Request, res: Response) => { noStore(res); const ok = await telegramAccountRepository.setEnabled(req.params.accountId, false); if (!ok) return res.status(404).json({ error: '账号不存在' }); await telegramUserClientPool.deactivateAccount(req.params.accountId); return res.json({ success: true, enabled: false }); });
router.delete('/config/telegram-user/accounts/:accountId', requireAuth, async (req: Request, res: Response) => { noStore(res); await telegramUserClientPool.expireAccount(req.params.accountId); const ok = await telegramAccountRepository.deleteAccount(req.params.accountId); return ok ? res.json({ success: true }) : res.status(404).json({ error: '账号不存在' }); });
router.post('/config/telegram-user/accounts/:accountId/check', requireAuth, async (req: Request, res: Response) => { noStore(res); const summary = await triggerTelegramAccountAccessSweep({ accountIds: [req.params.accountId], reason: 'manual' }); return res.json({ success: true, summary }); });
router.post('/config/telegram-user/accounts/:accountId/permissions/check', requireAuth, async (req: Request, res: Response) => { noStore(res); const summary = await triggerTelegramAccountAccessSweep({ accountIds: [req.params.accountId], reason: 'manual' }); return res.json({ success: true, summary }); });
router.post('/config/telegram-user/access/check-all', requireAuth, async (_req: Request, res: Response) => { noStore(res); return res.json({ success: true, summary: await triggerTelegramAccountAccessSweep({ reason: 'manual' }) }); });
router.post('/config/telegram-user/accounts/permissions/check-all', requireAuth, async (_req: Request, res: Response) => { noStore(res); return res.json({ success: true, summary: await triggerTelegramAccountAccessSweep({ reason: 'manual' }) }); });

function normalizeMultiAccountLoginPayload(payload: any): any {
    if (!payload || typeof payload !== 'object') return payload;
    const status = payload.status === 'pending' ? 'waiting_for_scan' : payload.status;
    const stepStatus = payload.step === 'password_required' ? 'password_required' : payload.step === 'complete' ? 'complete' : undefined;
    return {
        ...payload,
        status: stepStatus || status,
        qrCode: payload.qrCode || payload.qrData || undefined,
        qrExpiresAt: payload.qrExpiresAt || payload.expiresAt,
        message: payload.message || payload.error || undefined,
    };
}

// QR/phone aliases consumed by the current Web multi-account panel.
router.post('/config/telegram-user/accounts/login/qr', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => { noStore(res); try { return res.json(normalizeMultiAccountLoginPayload(await telegramMultiAccountLoginFlows.startQr(getTelegramUserLoginSessionKey(req)))); } catch (error) { return sendTelegramUserLoginError(res, error); } });
router.post('/config/telegram-user/login/qr', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => { noStore(res); try { return res.json(normalizeMultiAccountLoginPayload(await telegramMultiAccountLoginFlows.startQr(getTelegramUserLoginSessionKey(req)))); } catch (error) { return sendTelegramUserLoginError(res, error); } });
router.get('/config/telegram-user/login/:flowId', requireAuth, telegramUserLoginStatusLimiter, async (req: Request, res: Response) => { noStore(res); try { return res.json(normalizeMultiAccountLoginPayload(await telegramMultiAccountLoginFlows.getQrStatus(getTelegramUserLoginSessionKey(req), req.params.flowId))); } catch (error) { return sendTelegramUserLoginError(res, error); } });
router.delete('/config/telegram-user/login/:flowId', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => { noStore(res); try { return res.json(await telegramMultiAccountLoginFlows.cancel(getTelegramUserLoginSessionKey(req), req.params.flowId)); } catch (error) { return sendTelegramUserLoginError(res, error); } });
router.post('/config/telegram-user/login/phone', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => { noStore(res); try { const started = await telegramMultiAccountLoginFlows.startPhone(getTelegramUserLoginSessionKey(req), req.body?.phone); return res.json({ ...started, status: 'code_required', message: started.delivery === 'app' ? '验证码已发送到 Telegram 应用' : '验证码已通过短信发送' }); } catch (error) { return sendTelegramUserLoginError(res, error); } });
router.post('/config/telegram-user/login/:flowId/code', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => { noStore(res); try { return res.json(normalizeMultiAccountLoginPayload(await telegramMultiAccountLoginFlows.submitCode(getTelegramUserLoginSessionKey(req), req.params.flowId, req.body?.code))); } catch (error) { return sendTelegramUserLoginError(res, error); } });
router.post('/config/telegram-user/login/:flowId/password', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => { noStore(res); try { return res.json(normalizeMultiAccountLoginPayload(await telegramMultiAccountLoginFlows.submitPassword(getTelegramUserLoginSessionKey(req), req.params.flowId, req.body?.password))); } catch (error) { return sendTelegramUserLoginError(res, error); } });

router.post('/config/telegram-accounts/login/phone', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => {
    noStore(res);
    try {
        return res.json(await telegramMultiAccountLoginFlows.startPhone(getTelegramUserLoginSessionKey(req), req.body?.phone));
    } catch (error) {
        return sendTelegramUserLoginError(res, error);
    }
});
router.post('/config/telegram-accounts/login/code', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => {
    noStore(res);
    try {
        return res.json(await telegramMultiAccountLoginFlows.submitCode(getTelegramUserLoginSessionKey(req), req.body?.flowId, req.body?.code));
    } catch (error) {
        return sendTelegramUserLoginError(res, error);
    }
});
router.post('/config/telegram-accounts/login/password', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => {
    noStore(res);
    try {
        return res.json(await telegramMultiAccountLoginFlows.submitPassword(getTelegramUserLoginSessionKey(req), req.body?.flowId, req.body?.password));
    } catch (error) {
        return sendTelegramUserLoginError(res, error);
    }
});
router.post('/config/telegram-accounts/login/qr', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => {
    noStore(res);
    try {
        return res.json(await telegramMultiAccountLoginFlows.startQr(getTelegramUserLoginSessionKey(req)));
    } catch (error) {
        return sendTelegramUserLoginError(res, error);
    }
});
router.get('/config/telegram-accounts/login/qr/:flowId', requireAuth, telegramUserLoginStatusLimiter, async (req: Request, res: Response) => {
    noStore(res);
    try {
        return res.json(await telegramMultiAccountLoginFlows.getQrStatus(getTelegramUserLoginSessionKey(req), req.params.flowId));
    } catch (error) {
        return sendTelegramUserLoginError(res, error);
    }
});
router.post('/config/telegram-accounts/login/qr/:flowId/refresh', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => {
    noStore(res);
    try {
        return res.json(await telegramMultiAccountLoginFlows.refreshQr(getTelegramUserLoginSessionKey(req), req.params.flowId));
    } catch (error) {
        return sendTelegramUserLoginError(res, error);
    }
});
router.delete('/config/telegram-accounts/login/:flowId', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => {
    noStore(res);
    try {
        return res.json(await telegramMultiAccountLoginFlows.cancel(getTelegramUserLoginSessionKey(req), req.params.flowId));
    } catch (error) {
        return sendTelegramUserLoginError(res, error);
    }
});

// Legacy single-account login API remains available for deployed clients.
router.post('/config/telegram-user/login/phone', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => {
    noStore(res);
    try {
        const account = await getTelegramUserAccountStatus();
        if (account.configured) {
            return res.status(409).json({ error: '当前已绑定 Telegram 用户账号，请先解除绑定后再登录其他账号', code: 'ACCOUNT_ALREADY_BOUND' });
        }
        return res.json(await telegramUserWebLogin.start(getTelegramUserLoginSessionKey(req), req.body?.phone));
    } catch (error) {
        return sendTelegramUserLoginError(res, error);
    }
});
router.post('/config/telegram-user/login/code', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => { noStore(res); try { res.json(await telegramUserWebLogin.submitCode(getTelegramUserLoginSessionKey(req), req.body?.flowId, req.body?.code)); } catch (error) { sendTelegramUserLoginError(res, error); } });
router.post('/config/telegram-user/login/password', requireAuth, telegramUserLoginLimiter, async (req: Request, res: Response) => { noStore(res); try { res.json(await telegramUserWebLogin.submitPassword(getTelegramUserLoginSessionKey(req), req.body?.flowId, req.body?.password)); } catch (error) { sendTelegramUserLoginError(res, error); } });
router.post('/config/telegram-user/disable', requireAuth, async (_req: Request, res: Response) => {
    noStore(res);
    const account = await getTelegramUserAccountStatus();
    if (!account.enabled) return res.status(409).json({ error: '账号级下载器当前已经停用', code: 'ALREADY_DISABLED' });
    await disableTelegramUserAccount();
    return res.json({ success: true, enabled: false });
});
router.delete('/config/telegram-user', requireAuth, async (_req: Request, res: Response) => { noStore(res); await unlinkTelegramUserAccount(); res.json({ success: true }); });

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
        const reconciliation = await setTelegramAllowedUsersAndReconcile(userIds);
        res.json({
            success: true,
            userIds: reconciliation.allowed,
            added: reconciliation.added.length,
            removed: reconciliation.removed.length,
            revoked: reconciliation.revoked.length,
            message: reconciliation.revoked.length > 0
                ? '允许列表已保存；移除用户的 Bot 认证已立即撤销。'
                : '允许列表已保存。',
        });
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
        if (!state || typeof state !== 'string') return res.status(400).send('缺少 OAuth state');
        const flow = await oauthFlowStore.consume({
            state,
            provider: 'onedrive',
            authSessionToken: getOAuthSessionToken(req),
        });
        const routeConfig = getOAuthRouteConfig('onedrive');
        const fail = (message: string) => sendOAuthFailurePage(res, {
            provider: 'onedrive', providerName: 'OneDrive', frontendOrigin: routeConfig.frontendOrigin,
            flowNonce: flow.flowNonce, error: message,
        });
        if (error) return fail(`授权失败：${String(error_description || error)}`);
        if (!code || typeof code !== 'string') return fail('授权失败：未收到授权码');

        const { clientId, clientSecret = '', tenantId = 'common', name = '' } = flow.config;
        if (typeof clientId !== 'string' || !clientId) return fail('OAuth 配置信息不完整');
        try {
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
                const description = String(msError?.error_description || err.message || '未知错误');
                if (errorCode === 7000215 || /invalid client secret|AADSTS7000215/i.test(description)) {
                    return fail('Microsoft 返回 AADSTS7000215，Client Secret 无效。请复制客户端密码的值 Value。');
                }
                return fail(`授权失败：${description}`);
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
            return sendOAuthSuccessPage(res, {
                provider: 'onedrive', providerName: 'OneDrive', frontendOrigin: routeConfig.frontendOrigin,
                flowNonce: flow.flowNonce, accountId,
            });
        } catch (unexpected) {
            console.error('OneDrive 回调处理失败:', unexpected);
            return fail('授权处理失败，请检查配置后重试');
        }
    } catch (error: any) {
        try {
            sendOAuthFlowError(res, error);
        } catch (unexpected) {
            console.error('OneDrive OAuth 流程校验失败:', unexpected);
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
    const fail = async (message: string, flow?: { flowNonce: string }) => {
        if (flow) {
            const routeConfig = getOAuthRouteConfig('google_drive');
            return sendOAuthFailurePage(res, {
                provider: 'google_drive', providerName: 'Google Drive', frontendOrigin: routeConfig.frontendOrigin,
                flowNonce: flow.flowNonce, error: message,
            });
        }
        return res.status(400).type('text/plain').send(message);
    };
    try {
        const { code, state, error } = req.query;
        if (!state || typeof state !== 'string') return fail('缺少 OAuth state');
        const flow = await oauthFlowStore.consume({
            state,
            provider: 'google_drive',
            authSessionToken: getOAuthSessionToken(req),
        });
        if (error) return fail(`授权失败：${String(error)}`, flow);
        if (!code || typeof code !== 'string') return fail('授权失败：未收到授权码', flow);
        const { clientId, clientSecret, name = '', sharedDriveId = '' } = flow.config;
        if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) {
            return fail('OAuth 配置信息不完整', flow);
        }
        try {
            const { storageManager, GoogleDriveStorageProvider } = await import('../services/storage.js');
            const tokens = await GoogleDriveStorageProvider.exchangeCodeForToken(clientId, clientSecret, flow.redirectUri, code);
            if (!tokens.refresh_token) return fail('授权失败：未获得 Refresh Token。请在 Google 控制台中撤销权限后重试。', flow);
            const accountId = await storageManager.addGoogleDriveAccount(
                typeof name === 'string' && name ? name : 'Google Drive Account',
                clientId, clientSecret, tokens.refresh_token, flow.redirectUri,
                typeof sharedDriveId === 'string' ? sharedDriveId : '',
            );
            await storageManager.switchAccount(accountId);
            const routeConfig = getOAuthRouteConfig('google_drive');
            return sendOAuthSuccessPage(res, {
                provider: 'google_drive', providerName: 'Google Drive', frontendOrigin: routeConfig.frontendOrigin,
                flowNonce: flow.flowNonce, accountId,
            });
        } catch (unexpected) {
            console.error('Google Drive 回调处理失败:', unexpected);
            return fail('授权处理失败，请检查配置后重试', flow);
        }
    } catch (error: any) {
        try {
            sendOAuthFlowError(res, error);
        } catch (unexpected) {
            console.error('Google Drive OAuth 流程校验失败:', unexpected);
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

        try {
            await assertPublicStorageEndpoint(endpoint);
        } catch (error) {
            return sendStorageEndpointValidationError(res, error);
        }

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

        try {
            const allowUnsafeWebdavEndpoints = await getSetting('allow_unsafe_webdav_endpoints', 'false') === 'true';
            await assertStorageEndpoint(url, {
                allowPrivateAddresses: allowUnsafeWebdavEndpoints,
                allowInsecureHttp: allowUnsafeWebdavEndpoints,
            });
        } catch (error) {
            return sendStorageEndpointValidationError(res, error);
        }

        const { storageManager } = await import('../services/storage.js');
        const accountId = await storageManager.addWebDAVAccount(name, url, username, password);

        res.json({ success: true, message: 'WebDAV 存储账户已添加', accountId });
    } catch (error) {
        console.error('添加 WebDAV 配置失败:', error);
        sendStorageOperationError(res, error, '添加 WebDAV 配置失败');
    }
});

// 添加 OpenList 原生存储配置。仅保存连接凭据，不提供 OpenList 远端管理功能。
router.post('/config/openlist', requireAuth, async (req: Request, res: Response) => {
    try {
        const { name, baseUrl, rootPath = '/', username, password } = req.body || {};
        if (!name || !baseUrl || !username || !password) {
            return res.status(400).json({ error: '缺少必要参数（名称、地址、用户名和密码）' });
        }
        try {
            await assertPublicStorageEndpoint(baseUrl);
        } catch (error) {
            return sendStorageEndpointValidationError(res, error);
        }
        const normalizedRoot = `/${String(rootPath || '/').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '') || '/';
        if (normalizedRoot.includes('..')) return res.status(400).json({ error: '根目录不能包含 ..' });

        const { storageManager } = await import('../services/storage.js');
        const accountId = await storageManager.addOpenListAccount(
            String(name).trim(),
            String(baseUrl).trim(),
            normalizedRoot,
            String(username),
            String(password),
        );
        res.json({ success: true, message: 'OpenList 原生存储账户已添加', accountId });
    } catch (error) {
        const message = String((error as Error)?.message || '');
        if (/OpenList 请求失败|OpenList 请求超时|OpenList 端点无法连接|OpenList 上传后文件大小校验失败|OpenList 写入测试|OpenList 未返回|OpenList 文件读取/.test(message)) {
            res.status(422).json({ error: message, code: 'STORAGE_PROBE_FAILED', provider: 'openlist', retryable: true });
            return;
        }
        console.error('添加 OpenList 配置失败:', error);
        res.status(500).json({ error: '添加 OpenList 配置失败' });
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
        } else if (provider === 'onedrive' || provider === 'aliyun_oss' || provider === 's3' || provider === 'webdav' || provider === 'openlist' || provider === 'google_drive') {
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
    try {
        const account = await query('SELECT id, name, type, is_active FROM storage_accounts WHERE id = $1', [req.params.id]);
        if (!account.rows[0]) return res.status(404).json({ error: '存储账户不存在' });
        if (account.rows[0].is_active) return res.status(409).json({ error: '不能删除当前正在使用的存储账户' });
        const authToken = getAuthToken(req);
        if (!authToken) return res.status(401).json({ error: '未认证' });
        const previewQueries = buildStorageDeletePreviewQueries(req.params.id);
        const [impact, leases, tasks, uploads] = await Promise.all([
            query(previewQueries.impact.text, previewQueries.impact.values),
            query(previewQueries.leases.text, previewQueries.leases.values),
            query(previewQueries.tasks.text, previewQueries.tasks.values),
            query(previewQueries.uploads.text, previewQueries.uploads.values),
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
    } catch (error) {
        console.error('创建存储账户删除确认失败:', error);
        res.status(500).json({ error: '无法创建删除确认' });
    }
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
