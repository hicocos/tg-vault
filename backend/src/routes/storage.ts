import { Router, Request, Response } from 'express';
import checkDiskSpaceModule from 'check-disk-space';
import { query } from '../db/index.js';
import os from 'os';

// ESM compatibility
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';

// 获取存储统计
router.get('/stats', async (_req: Request, res: Response) => {
    try {
        // 获取服务器磁盘空间
        const diskPath = os.platform() === 'win32' ? 'C:' : '/';
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
router.get('/stats/types', async (_req: Request, res: Response) => {
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
router.get('/config', async (_req: Request, res: Response) => {
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

// 更新 OneDrive 配置
router.put('/config/onedrive', async (req: Request, res: Response) => {
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
router.post('/switch', async (req: Request, res: Response) => {
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
