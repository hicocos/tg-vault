import { Router, Request, Response } from 'express';
import checkDiskSpaceModule from 'check-disk-space';
import { query } from '../db/index.js';
import { requireAuth } from './auth.js';
import os from 'os';
import path from 'path';

// ESM compatibility
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';

// 获取存储统计
router.get('/stats', requireAuth, async (_req: Request, res: Response) => {
    try {
        // 获取服务器磁盘空间（使用上传目录所在的路径，Docker 中反映卷的空间）
        const diskPath = os.platform() === 'win32' ? 'C:' : path.resolve(UPLOAD_DIR);
        const diskSpace = await checkDiskSpace(diskPath);

        // 获取 FoomClous 使用的空间
        const result = await query(`
            SELECT 
                COUNT(*) as file_count,
                COALESCE(SUM(size), 0) as total_size
            FROM files
        `);

        const foomclousStats = result.rows[0];

        res.json({
            server: {
                total: formatBytes(diskSpace.size),
                totalBytes: diskSpace.size,
                used: formatBytes(diskSpace.size - diskSpace.free),
                usedBytes: diskSpace.size - diskSpace.free,
                free: formatBytes(diskSpace.free),
                freeBytes: diskSpace.free,
                usedPercent: Math.round(((diskSpace.size - diskSpace.free) / diskSpace.size) * 100),
            },
            foomclous: {
                used: formatBytes(parseInt(foomclousStats.total_size)),
                usedBytes: parseInt(foomclousStats.total_size),
                fileCount: parseInt(foomclousStats.file_count),
                usedPercent: Math.round((parseInt(foomclousStats.total_size) / diskSpace.size) * 100),
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
        const result = await query(`
            SELECT 
                type,
                COUNT(*) as count,
                COALESCE(SUM(size), 0) as total_size
            FROM files
            GROUP BY type
            ORDER BY total_size DESC
        `);

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
router.get('/config', requireAuth, async (_req: Request, res: Response) => {
    try {
        const { storageManager } = await import('../services/storage.js');
        const provider = storageManager.getProvider();
        const onedriveConfig = {
            clientId: await storageManager.getSetting('onedrive_client_id'),
            tenantId: await storageManager.getSetting('onedrive_tenant_id') || 'common',
            // 不返回 clientSecret 和 refreshToken，只返回是否存在
            hasSecret: !!(await storageManager.getSetting('onedrive_client_secret')),
            hasRefreshToken: !!(await storageManager.getSetting('onedrive_refresh_token')),
        };

        res.json({
            provider: provider.name,
            onedrive: onedriveConfig,
        });
    } catch (error) {
        console.error('获取存储配置失败:', error);
        res.status(500).json({ error: '获取存储配置失败' });
    }
});

// 获取 OneDrive 授权 URL
router.post('/config/onedrive/auth-url', requireAuth, async (req: Request, res: Response) => {
    try {
        const { clientId, tenantId, redirectUri } = req.body;
        if (!clientId || !redirectUri) {
            return res.status(400).json({ error: '缺少 Client ID 或 Redirect URI' });
        }

        const { OneDriveStorageProvider } = await import('../services/storage.js');
        const authUrl = OneDriveStorageProvider.generateAuthUrl(clientId, tenantId || 'common', redirectUri);
        res.json({ authUrl });
    } catch (error) {
        console.error('获取授权 URL 失败:', error);
        res.status(500).json({ error: '获取授权 URL 失败' });
    }
});

// OneDrive OAuth 回调
router.get('/onedrive/callback', async (req: Request, res: Response) => {
    try {
        const { code, state, error, error_description } = req.query;

        if (error) {
            return res.send(`授权失败: ${error_description || error}`);
        }

        if (!code) {
            return res.send('缺少授权码 (code)');
        }

        // 从临时存储或数据库中恢复之前发起的配置请求信息
        // 简化起见，我们目前可以从数据库中读出最后一次尝试配置的 clientId/secret，或者要求前端在 state 中带上必要的参数
        // 但安全起见，我们假设用户在配置页面已经输入了这些信息并存在了系统设置中（未完成状态）
        const { storageManager, OneDriveStorageProvider } = await import('../services/storage.js');
        const clientId = await storageManager.getSetting('onedrive_client_id');
        const clientSecret = await storageManager.getSetting('onedrive_client_secret') || '';
        const tenantId = await storageManager.getSetting('onedrive_tenant_id') || 'common';

        // 我们需要知道当初请求授权时用的 redirectUri，必须与前端发起的完全一致
        const protocol = req.protocol; // 开启 trust proxy 后，这将正确返回 https
        const host = req.get('host');
        const redirectUri = `${protocol}://${host}/api/storage/onedrive/callback`;

        console.log(`[OneDrive] OAuth Callback, using redirectUri: ${redirectUri}`);

        if (!clientId) {
            return res.send('配置信息丢失（Client ID 未找到），请返回设置页面重试。');
        }

        const tokens = await OneDriveStorageProvider.exchangeCodeForToken(clientId, clientSecret, tenantId, redirectUri, code as string);

        // 保存刷新令牌并切换
        await storageManager.updateOneDriveConfig(clientId, clientSecret, tokens.refresh_token, tenantId);

        res.send(`
            <html>
                <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                    <div style="text-align: center; padding: 40px; border-radius: 20px; background: #f0fdf4; border: 1px solid #bbf7d0;">
                        <h2 style="color: #16a34a; margin-bottom: 10px;">🎉 授权成功！</h2>
                        <p style="color: #15803d; margin-bottom: 20px;">OneDrive 已成功连接并启用。</p>
                        <button onclick="window.close()" style="padding: 10px 20px; background: #16a34a; color: white; border: none; border-radius: 8px; cursor: pointer;">关闭此窗口</button>
                        <script>
                            setTimeout(() => {
                                // 尝试通知父窗口（如果是在弹出窗口中打开的）
                                if (window.opener) {
                                    window.opener.postMessage('onedrive_auth_success', '*');
                                }
                                window.close();
                            }, 3000);
                        </script>
                    </div>
                </body>
            </html>
        `);
    } catch (error: any) {
        console.error('OneDrive 回调处理失败:', error);
        res.status(500).send(`授权处理出错: ${error.message}`);
    }
});

// 更新 OneDrive 配置
router.put('/config/onedrive', requireAuth, async (req: Request, res: Response) => {
    try {
        const { clientId, clientSecret, refreshToken, tenantId } = req.body;

        if (!clientId || !refreshToken) {
            return res.status(400).json({ error: '缺少必要参数 (Client ID 和 Refresh Token)' });
        }

        const { storageManager } = await import('../services/storage.js');
        await storageManager.updateOneDriveConfig(clientId, clientSecret || '', refreshToken, tenantId || 'common');

        res.json({ success: true, message: 'OneDrive 配置已更新并切换' });
    } catch (error) {
        console.error('更新 OneDrive 配置失败:', error);
        res.status(500).json({ error: '更新 OneDrive 配置失败' });
    }
});

// 切换存储提供商
router.post('/switch', requireAuth, async (req: Request, res: Response) => {
    try {
        const { provider } = req.body;
        const { storageManager, StorageManager } = await import('../services/storage.js');

        if (provider === 'local') {
            await storageManager.switchToLocal();
        } else if (provider === 'onedrive') {
            // 检查是否已配置
            const hasToken = await storageManager.getSetting('onedrive_refresh_token');
            if (!hasToken) {
                return res.status(400).json({ error: 'OneDrive 未配置，无法切换' });
            }
            await StorageManager.updateSetting('storage_provider', 'onedrive');
            await storageManager.init(); // 重新加载
        } else {
            return res.status(400).json({ error: '无效的存储提供商' });
        }

        res.json({ success: true, message: `已切换到 ${provider} 存储` });
    } catch (error) {
        console.error('切换存储提供商失败:', error);
        res.status(500).json({ error: '切换存储提供商失败' });
    }
});

export default router;
