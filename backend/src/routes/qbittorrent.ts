import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { requireAuth } from './auth.js';
import { getQbConfig, publicQbConfig, mergeQbConfig, saveQbConfig, probeQbConfig, qbEnabled } from '../services/qbittorrentConfig.js';
import { createQbTask, listQbTasks, controlQbTask, qbTaskFiles, startQbTasks, stopQbTasks } from '../services/qbittorrentTasks.js';

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

router.get('/config', async (_req, res, next) => {
    try { res.json(publicQbConfig(await getQbConfig())); } catch (error) { next(error); }
});
router.put('/config', async (req, res, next) => {
    try {
        const config = await saveQbConfig(req.body || {});
        if (config.enabled) startQbTasks(); else await stopQbTasks();
        res.json(publicQbConfig(config));
    } catch (error) { next(error); }
});
router.use(async (_req, res, next) => {
    try {
        if (!await qbEnabled()) { res.status(403).json({ error: 'qBittorrent 扩展未开启' }); return; }
        next();
    } catch (error) { next(error); }
});
router.post('/test', async (req, res, next) => {
    try { res.json(await probeQbConfig(mergeQbConfig(await getQbConfig(), req.body || {}))); } catch (error) { next(error); }
});
router.get('/tasks', async (_req, res, next) => {
    try { res.json({ tasks: await listQbTasks() }); } catch (error) { next(error); }
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 6, fieldSize: 65536 } });
router.post('/tasks', upload.single('torrent'), async (req, res, next) => {
    try {
        if (req.file && !req.file.originalname.toLowerCase().endsWith('.torrent')) throw new Error('请选择 .torrent 种子文件');
        const preserve = req.body.preserveLocalFiles;
        if (preserve !== undefined && preserve !== 'true' && preserve !== 'false') throw new Error('保留源文件选项无效');
        res.status(201).json(await createQbTask({ magnet: req.body.magnet?.trim(), torrent: req.file?.buffer,
            targetAccountId: req.body.targetAccountId, targetFolder: req.body.targetFolder,
            preserveLocalFiles: preserve === undefined ? undefined : preserve === 'true' }));
    } catch (error) { next(error); }
});
router.get('/tasks/:id/files', async (req, res, next) => {
    try { res.json(await qbTaskFiles(String(req.params.id))); } catch (error) { next(error); }
});
router.post('/tasks/:id/files', async (req, res, next) => {
    try {
        if (!Array.isArray(req.body.indexes)) throw new Error('文件选择格式错误');
        res.json(await qbTaskFiles(String(req.params.id), req.body.indexes));
    } catch (error) { next(error); }
});
router.post('/tasks/:id/:action', async (req, res, next) => {
    try { await controlQbTask(String(req.params.id), String(req.params.action)); res.json({ success: true }); } catch (error) { next(error); }
});
router.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof multer.MulterError ? 413 : 400).json({ error: error.message || 'qBittorrent 操作失败' });
});
export default router;
