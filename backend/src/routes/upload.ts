
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { pool } from '../db/index.js';
import { validateApiKey, requireApiKeyPermission } from '../middleware/apiKey.js';

import { uploadIndexedFile } from '../services/indexedUpload.js';
import { isStorageCooldownError, sendStorageCooldownHttpError } from '../services/storageCooldownGuard.js';
import { storageManager } from '../services/storage.js';
import { getSignedUrl } from '../middleware/signedUrl.js';
import { rateLimit } from 'express-rate-limit';
import { lockStorageAccountForUse } from '../services/storageAccountLifecycle.js';
import { normalizeFolderPath } from '../utils/folderPath.js';
import { buildUploadCapabilities, SIMPLE_UPLOAD_MAX_BYTES } from '../utils/uploadCapabilities.js';

const router = Router();
export const apiRouter = Router();

const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '上传请求过于频繁，请稍后再试' },
});

// 修复中文文件名编码问题
function decodeFilename(filename: string): string {
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
        fileSize: SIMPLE_UPLOAD_MAX_BYTES,
    }
});

// 处理上传请求
const handleUpload = async (req: Request, res: Response, source: string = 'web') => {
    if (!req.file) {
        return res.status(400).json({ error: '没有上传文件' });
    }

    const file = req.file;
    const { folder, targetProvider, targetAccountId } = req.body;
    const originalName = decodeFilename(file.originalname);
    const mimeType = file.mimetype;
    const size = file.size;
    const tempPath = path.resolve(file.path);

    let target;
    try {
        if (targetProvider) {
            if (targetAccountId) {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    const account = await lockStorageAccountForUse(client, String(targetAccountId));
                    if (account.type !== String(targetProvider)) throw new Error('上传目标账户与 provider 不匹配');
                    await client.query('COMMIT');
                } catch (error) {
                    await client.query('ROLLBACK').catch(() => undefined);
                    throw error;
                } finally {
                    client.release();
                }
            } else if (String(targetProvider) !== 'local') {
                throw new Error('云存储上传目标缺少账户');
            }
            target = storageManager.getTarget(String(targetProvider), targetAccountId ? String(targetAccountId) : null);
        } else {
            target = storageManager.getActiveTarget();
        }
    } catch (error) {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return res.status(409).json({ error: error instanceof Error ? error.message : '上传目标无效' });
    }
    let requestedFolder: string | null;
    try {
        requestedFolder = folder ? normalizeFolderPath(folder) : null;
    } catch (error) {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return res.status(400).json({ error: error instanceof Error ? error.message : '文件夹路径无效' });
    }
    try {
        const result = await uploadIndexedFile({ target, source: source === 'api' ? 'api' : 'web',
            originalName, mimeType, size, tempPath, folder: requestedFolder });
        res.json({ ...result, file: { ...result.file,
            ...('skipped' in result ? {} : { previewUrl: getSignedUrl(result.file.id, 'preview') }) } });
    } catch (error) {
        console.error('上传处理失败:', error);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (isStorageCooldownError(error)) return sendStorageCooldownHttpError(res, error);
        res.status(500).json({ error: '文件上传失败' });
    }

};

// 服务端上传能力契约（前端必须以此决定直传/分片与展示真实限制）
router.get('/capabilities', (_req: Request, res: Response) => {
    res.json(buildUploadCapabilities());
});

// 内部上传接口（前端使用）
router.post('/', uploadLimiter, upload.single('file'), async (req: Request, res: Response) => {
    await handleUpload(req, res, 'web');
});

// 外部 API 上传接口（仅 API Key + upload 权限）
apiRouter.post('/', uploadLimiter, validateApiKey, requireApiKeyPermission('upload'), upload.single('file'), async (req: Request, res: Response) => {
    await handleUpload(req, res, 'api');
});

export default router;
