import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import parseTorrent from 'parse-torrent';
import { pool, query } from '../db/index.js';
import { createTransferTask, getTransferTask, listTransferTasks, updateTransferTask, type TransferTaskRecord } from './transferTasks.js';
import { QbittorrentClient, type QbFile, type QbTorrent } from './qbittorrentClient.js';
import { getQbConfig, qbEnabled, type QbConfig } from './qbittorrentConfig.js';
import { storageManager } from './storage.js';
import { withStorageAccountOperationLease } from './storageAccountOperation.js';
import { assertStorageTargetWritable } from './storageCooldownGuard.js';
import { saveAndIndexWithCompensation } from './storageWrite.js';
import { normalizeFolderPath } from '../utils/folderPath.js';
import { getUniqueStoredName } from '../utils/fileUtils.js';
import { getMimeTypeFromFilename } from '../utils/telegramUtils.js';
import { getFileType } from '../utils/fileMetadata.js';
import { enqueueMediaDerivatives } from './mediaDerivatives.js';
import { qbDownloadProgress, QbTransferProgress } from './qbittorrentProgress.js';
import { filterDismissedTasks, loadTaskCenterDismissals } from './taskCenterDismissals.js';

interface TransferredFile {
    index: number;
    name: string;
    size: number;
    storedName: string;
    fileId?: string;
}
interface QbPayload extends Record<string, unknown> {
    hash: string;
    connection: string;
    savePath: string;
    downloadRoot: string;
    preserveLocalFiles: boolean;
    magnet?: string;
    torrent?: string;
    files: TransferredFile[];
    downloadProgress: number;
    downloadSpeed: number;
    downloadedBytes?: number;
    uploadSpeed?: number;
    cleanupStarted?: boolean;
    cleanupRequestedAt?: number | null;
    submissionPending?: boolean;
}

const running = new Map<string, AbortController>();
const controlling = new Map<string, number>();
let timer: NodeJS.Timeout | undefined;
let tickFlight: Promise<void> | null = null;
let stopped = true;

export function qbTaskView(task: TransferTaskRecord) {
    const payload = task.payload as QbPayload;
    return {
        id: task.id, title: task.title, status: task.status, stage: task.stage, progress: task.progress, cancelRequested: task.cancelRequested,
        downloadProgress: payload.downloadProgress || 0, downloadSpeed: task.status === 'running' && task.stage === 'downloading' ? payload.downloadSpeed || 0 : 0,
        downloadedBytes: payload.downloadedBytes ?? Math.floor(task.totalBytes * (payload.downloadProgress || 0) / 100),
        uploadSpeed: task.status === 'running' && task.stage === 'uploading' ? Number(payload.uploadSpeed || 0) : 0,
        totalBytes: task.totalBytes, transferredBytes: task.transferredBytes, totalItems: task.totalItems, completedItems: task.completedItems,
        error: task.error, retryable: task.retryable, targetAccountId: task.targetAccountId, targetProvider: task.targetProvider,
        targetFolder: task.targetFolder, preserveLocalFiles: payload.preserveLocalFiles, createdAt: task.createdAt, updatedAt: task.updatedAt, finishedAt: task.finishedAt,
    };
}

export async function listQbTasks() {
    const [tasks, dismissals] = await Promise.all([listTransferTasks({ sourceType: 'qbittorrent', limit: 500 }), loadTaskCenterDismissals()]);
    return filterDismissedTasks(tasks.map(task => ({ ...qbTaskView(task), sourceType: 'qbittorrent', updatedAt: task.updatedAt.toISOString() })), dismissals);
}

async function requireTask(id: string): Promise<TransferTaskRecord> {
    const task = await getTransferTask('qbittorrent', id);
    if (!task) throw new Error('BT 任务不存在');
    return task;
}

async function taskLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    const key = `qbittorrent:${id}`;
    try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
        return await operation();
    } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]).catch(() => undefined);
        client.release();
    }
}

function assertConnection(payload: QbPayload, config: QbConfig): void {
    if (payload.connection !== `${config.apiUrl}|${config.username}`) throw new Error('下载器连接已变更，请恢复原连接后重试此任务');
}

function assertQbTaskDirectory(task: TransferTaskRecord): void {
    const payload = task.payload as QbPayload;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(task.id)
        || !path.isAbsolute(payload.downloadRoot) || path.resolve(payload.downloadRoot) === path.parse(payload.downloadRoot).root
        || payload.savePath !== path.join(payload.downloadRoot, task.id)) throw new Error('任务下载目录不安全，已停止处理');
}

export async function assertQbOwnedTorrent(task: TransferTaskRecord, client: QbittorrentClient): Promise<QbTorrent | null> {
    const payload = task.payload as QbPayload;
    assertQbTaskDirectory(task);
    const torrent = (await client.torrents(payload.hash))[0];
    if (!torrent) return null;
    if (torrent.hash.toLowerCase() !== payload.hash || path.resolve(torrent.save_path) !== payload.savePath) {
        throw new Error('种子标识或下载位置已变化，为保护其他数据已停止处理');
    }
    return torrent;
}

function assertQbFileName(name: string): void {
    if (path.isAbsolute(name) || name.includes('\\') || name.includes('\0') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('种子包含不安全的文件路径');
}

// The backend download mount is read-only. Only qBittorrent may remove source data;
// inspect the whole UUID directory, including partial/unselected files, before and after deletion.
async function inspectCancellationSource(task: TransferTaskRecord): Promise<boolean> {
    const payload = task.payload as QbPayload;
    assertQbTaskDirectory(task);
    const root = await fs.realpath(payload.downloadRoot);
    const inspect = async (directory: string): Promise<boolean> => {
        if (await fs.realpath(directory) !== path.join(root, path.relative(payload.downloadRoot, directory))) throw new Error('任务下载目录被替换为其他位置，已停止删除');
        let entries;
        try { entries = await fs.readdir(directory, { withFileTypes: true }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
        }
        let hasFiles = false;
        for (const entry of entries) {
            if (entry.isSymbolicLink()) throw new Error('任务下载目录包含符号链接，已停止删除');
            if (entry.isDirectory()) hasFiles = await inspect(path.join(directory, entry.name)) || hasFiles;
            else hasFiles = true;
        }
        return hasFiles;
    };
    try {
        const stat = await fs.lstat(payload.savePath);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(payload.savePath) !== path.join(root, task.id)) throw new Error('任务下载目录被替换为其他位置，已停止删除');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
    return inspect(payload.savePath);
}

async function cancelTaskSource(task: TransferTaskRecord, client: QbittorrentClient): Promise<void> {
    const payload = task.payload as QbPayload;
    const torrent = await assertQbOwnedTorrent(task, client);
    const hasFiles = await inspectCancellationSource(task);
    if (!torrent) {
        if (payload.submissionPending && !payload.cleanupStarted) throw new Error('种子提交结果尚未确认，暂不能确认取消；请稍后重试清理');
        if (hasFiles) {
            if (payload.cleanupStarted && payload.cleanupRequestedAt && Date.now() - payload.cleanupRequestedAt < 30_000) return;
            throw new Error('qBittorrent 种子已移除，但下载源文件仍存在；请在下载器中清理后重试取消');
        }
        await updateTransferTask('qbittorrent', task.id, { status: 'cancelled', stage: 'cancelled', error: null, retryable: false, finishedAt: new Date(), payload: { downloadSpeed: 0, uploadSpeed: 0 } });
        return;
    }
    if (torrent.content_path && path.resolve(torrent.content_path) !== payload.savePath && !path.resolve(torrent.content_path).startsWith(`${payload.savePath}${path.sep}`)) throw new Error('种子内容位置超出任务下载目录，已停止删除');
    for (const file of await client.files(payload.hash)) assertQbFileName(file.name);
    if (payload.cleanupStarted) {
        if (!payload.cleanupRequestedAt || Date.now() - payload.cleanupRequestedAt >= 30_000) throw new Error('qBittorrent 删除尚未完成，请稍后重试取消');
        return;
    }
    // Persist intent before the API call: a crash/timeout must never resume or resubmit this torrent.
    await updateTransferTask('qbittorrent', task.id, { payload: { cleanupStarted: true, cleanupRequestedAt: Date.now(), submissionPending: false } });
    await client.control(payload.hash, 'delete');
}

export async function resolveQbSource(savePath: string, file: QbFile): Promise<string> {
    assertQbFileName(file.name);
    const root = await fs.realpath(savePath);
    const source = await fs.realpath(path.join(root, file.name));
    if (!source.startsWith(`${root}${path.sep}`)) throw new Error('种子文件超出任务下载目录');
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size !== file.size) throw new Error(`下载文件缺失或大小不符: ${file.name}`);
    return source;
}

export async function createQbTask(input: { magnet?: string; torrent?: Buffer; targetAccountId?: string; targetFolder?: string; preserveLocalFiles?: boolean }) {
    const config = await getQbConfig();
    if (!config.enabled) throw new Error('qBittorrent 扩展未开启');
    if (!config.apiUrl || !config.username || !config.password) throw new Error('请先配置 qBittorrent 连接');
    if (Boolean(input.magnet) === Boolean(input.torrent)) throw new Error('请提交一个磁力链接或种子文件');
    if (input.magnet && (!input.magnet.startsWith('magnet:?') || input.magnet.length > 65536)) throw new Error('磁力链接格式无效');
    if (input.torrent && input.torrent[0] !== 100) throw new Error('种子文件必须是有效的 bencode 字典');
    const metadata = await parseTorrent(input.torrent || input.magnet!);
    const hash = metadata.infoHash.toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error('不支持的种子标识');
    const targetId = input.targetAccountId || config.targetAccountId;
    let providerName = 'local';
    if (targetId !== 'local') {
        const account = (await query('SELECT type FROM storage_accounts WHERE id=$1::uuid', [targetId])).rows[0];
        if (!account) throw new Error('目标存储账户不存在');
        providerName = account.type;
    }
    storageManager.getTarget(providerName, targetId === 'local' ? null : targetId);
    const folder = normalizeFolderPath(input.targetFolder || config.targetFolder);
    await fs.access(config.downloadDir, fs.constants.R_OK | fs.constants.X_OK);
    return taskLock('submission', async () => {
        const duplicate = await query(`SELECT id FROM transfer_tasks WHERE source_type='qbittorrent' AND payload->>'hash'=$1 AND status NOT IN ('completed','cancelled')`, [hash]);
        if (duplicate.rowCount) throw new Error('该种子已有未完成的转存任务');
        const client = new QbittorrentClient(config);
        if ((await client.torrents(hash)).length) throw new Error('该种子已存在于 qBittorrent，请勿重复添加');
        const id = crypto.randomUUID();
        const payload: QbPayload = {
            hash, connection: `${config.apiUrl}|${config.username}`,
            savePath: path.join(config.downloadDir, id), downloadRoot: config.downloadDir,
            preserveLocalFiles: input.preserveLocalFiles ?? config.preserveLocalFiles,
            magnet: input.magnet, torrent: input.torrent?.toString('base64'), files: [], downloadProgress: 0, downloadSpeed: 0,
        };
        const task = await createTransferTask({ sourceType: 'qbittorrent', id, kind: 'torrent', title: metadata.name || hash,
            status: 'pending', stage: 'submitting', source: 'qBittorrent', targetProvider: providerName,
            targetAccountId: targetId === 'local' ? null : targetId, targetFolder: folder, payload });
        void tickQbTasks();
        return qbTaskView(task);
    });
}

async function transferFile(task: TransferTaskRecord, payload: QbPayload, file: QbFile, signal: AbortSignal): Promise<void> {
    const source = await resolveQbSource(payload.savePath, file);
    const sourceDirectory = path.posix.dirname(file.name);
    const folder = normalizeFolderPath(`${task.targetFolder}${sourceDirectory === '.' ? '' : `/${sourceDirectory}`}`);
    const name = path.posix.basename(file.name);
    let entry = payload.files.find(item => item.index === file.index);
    if (!entry) {
        entry = { index: file.index, name: file.name, size: file.size, storedName: await getUniqueStoredName(name, folder, task.targetAccountId) };
        payload.files.push(entry);
        await updateTransferTask('qbittorrent', task.id, { payload });
    }
    const target = storageManager.getTarget(task.targetProvider!, task.targetAccountId);
    await withStorageAccountOperationLease(pool, task.targetAccountId, `qbittorrent:${task.id}`, async () => {
        await assertStorageTargetWritable(target);
        signal.throwIfAborted();
        const mime = getMimeTypeFromFilename(name);
        const type = getFileType(mime);
        const fileId = crypto.randomUUID();
        const committedBytes = payload.files.filter(item => item.fileId).reduce((sum, item) => sum + item.size, 0);
        await updateTransferTask('qbittorrent', task.id, { transferredBytes: committedBytes,
            progress: task.totalBytes > 0 ? Math.min(99, committedBytes / task.totalBytes * 100) : 0, payload: { uploadSpeed: 0 } });
        const progress = new QbTransferProgress({ committedBytes, fileBytes: file.size, totalBytes: task.totalBytes,
            persist: async sample => {
                await updateTransferTask('qbittorrent', task.id, { transferredBytes: sample.transferredBytes, progress: sample.progress, payload: { uploadSpeed: sample.uploadSpeed } });
            } });
        let temporary: string | null = null;
        let derivativeSource: string | null = null;
        try {
            // The local provider consumes its input; never hand it a seeding file.
            if (target.provider.name === 'local') {
                const dir = path.join(process.env.CHUNK_DIR || './data/chunks', 'qbittorrent');
                await fs.mkdir(dir, { recursive: true });
                temporary = path.join(dir, `${task.id}-${file.index}`);
                await fs.copyFile(source, temporary, fs.constants.COPYFILE_FICLONE);
            }
            if (type === 'image' || type === 'video') {
                const dir = path.join(process.env.CHUNK_DIR || './data/chunks', 'qbittorrent-media');
                await fs.mkdir(dir, { recursive: true });
                derivativeSource = path.join(dir, fileId);
                await fs.copyFile(source, derivativeSource, fs.constants.COPYFILE_FICLONE);
            }
            await saveAndIndexWithCompensation(target.provider, temporary || source, entry!.storedName, mime, folder, async storedPath => {
                await progress.flush();
                await progress.close();
                signal.throwIfAborted();
                const completed = payload.files.map(item => item.index === file.index ? { ...item, fileId } : item);
                const completedFiles = completed.filter(item => item.fileId);
                const db = await pool.connect();
                try {
                    await db.query('BEGIN');
                    await db.query(`INSERT INTO files (id,name,stored_name,type,mime_type,size,path,source,folder,storage_account_id,derivative_status,derivative_source_path,derivative_cleanup_source)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                    [fileId, name, entry!.storedName, type, mime, file.size, storedPath, target.provider.name, folder, task.targetAccountId,
                        derivativeSource ? 'queued' : 'not_required', derivativeSource, Boolean(derivativeSource)]);
                    await db.query(`UPDATE transfer_tasks SET payload=payload || $2::jsonb,completed_items=$3,transferred_bytes=$4,progress=$5,updated_at=NOW() WHERE source_type='qbittorrent' AND id=$1`,
                        [task.id, JSON.stringify({ files: completed, uploadSpeed: 0 }), completedFiles.length, completedFiles.reduce((sum, item) => sum + item.size, 0), completedFiles.length === task.totalItems ? 100 : task.totalBytes > 0 ? Math.min(99, completedFiles.reduce((sum, item) => sum + item.size, 0) * 100 / task.totalBytes) : 0]);
                    await db.query('COMMIT');
                    payload.files = completed;
                } catch (error) {
                    await db.query('ROLLBACK').catch(() => undefined);
                    throw error;
                } finally { db.release(); }
            }, { signal, onProgress: progress.report });
            if (derivativeSource) {
                enqueueMediaDerivatives({ fileId, sourcePath: derivativeSource, storedName: entry!.storedName, mimeType: mime, cleanupSource: true });
                derivativeSource = null;
            }
        } catch (error) {
            await progress.close();
            await updateTransferTask('qbittorrent', task.id, { transferredBytes: committedBytes,
                progress: task.totalBytes > 0 ? Math.min(99, committedBytes / task.totalBytes * 100) : 0, payload: { uploadSpeed: 0 } });
            throw error;
        } finally {
            await progress.close();
            if (temporary) await fs.rm(temporary, { force: true }).catch(() => undefined);
            if (derivativeSource) await fs.rm(derivativeSource, { force: true }).catch(() => undefined);
        }
    });
}

async function processTask(id: string, config: QbConfig): Promise<void> {
    await taskLock(id, async () => {
        const task = await requireTask(id);
        if (controlling.has(id) || !['pending', 'running'].includes(task.status)) return;
        const payload = task.payload as QbPayload;
        const controller = new AbortController();
        running.set(id, controller);
        try {
            assertConnection(payload, config);
            const client = new QbittorrentClient(config);
            if (task.cancelRequested || task.stage === 'cancelling') {
                await cancelTaskSource(task, client);
                return;
            }
            let torrent = await assertQbOwnedTorrent(task, client);
            controller.signal.throwIfAborted();
            if (task.stage === 'submitting') {
                if (!torrent) {
                    await updateTransferTask('qbittorrent', id, { payload: { submissionPending: true } });
                    await client.add({ magnet: payload.magnet, torrent: payload.torrent ? Buffer.from(payload.torrent, 'base64') : undefined, savePath: payload.savePath });
                    return;
                }
                delete payload.magnet;
                delete payload.torrent;
                await updateTransferTask('qbittorrent', id, { stage: 'metadata', payload: { ...payload, magnet: null, torrent: null, submissionPending: false } });
            }
            if (task.stage === 'cleaning' && payload.cleanupStarted && !torrent) {
                for (const file of payload.files) {
                    try {
                        await fs.access(path.join(payload.savePath, file.name));
                        throw new Error(`qBittorrent 已移除任务，但本地文件仍存在: ${file.name}`);
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    }
                }
                await updateTransferTask('qbittorrent', id, { status: 'completed', stage: 'completed', progress: 100, error: null, retryable: false, finishedAt: new Date() });
                return;
            }
            if (!torrent) throw new Error('qBittorrent 中的种子已不存在，源文件未被本项目删除');
            if (task.stage !== 'cleaning') {
                const files = await client.files(payload.hash);
                const selected = files.filter(file => file.priority > 0);
                controller.signal.throwIfAborted();
                for (const file of selected) {
                    const saved = payload.files.find(item => item.index === file.index);
                    if (saved && (saved.name !== file.name || saved.size !== file.size)) throw new Error('种子文件列表已变化，已停止转存以保护源文件');
                }
                const { totalBytes, downloadedBytes, downloadProgress } = qbDownloadProgress(selected);
                payload.downloadedBytes = downloadedBytes;
                payload.downloadProgress = downloadProgress;
                payload.downloadSpeed = torrent.dlspeed;
                if (['error', 'missingFiles', 'unknown'].includes(torrent.state)) throw new Error(`qBittorrent 状态异常: ${torrent.state}`);
                const stable = !/checking|moving|metaDL|allocating/i.test(torrent.state);
                const complete = selected.length > 0 && selected.every(file => file.progress >= 1) && stable;
                const qbPaused = /^(paused|stopped)DL$/.test(torrent.state);
                await updateTransferTask('qbittorrent', id, { title: torrent.name, status: qbPaused && !complete ? 'paused' : 'running',
                    stage: complete ? 'uploading' : files.length ? 'downloading' : 'metadata', totalItems: selected.length, totalBytes, payload, error: null });
                if (!complete) return;
                const downloadRoot = await fs.realpath(payload.downloadRoot);
                if (await fs.realpath(payload.savePath) !== path.join(downloadRoot, task.id)) throw new Error('任务下载目录被替换为其他位置');
                task.totalItems = selected.length;
                task.totalBytes = totalBytes;
                const next = selected.find(file => !payload.files.some(item => item.index === file.index && item.fileId));
                if (next) {
                    await transferFile(task, payload, next, controller.signal);
                    return;
                }
                controller.signal.throwIfAborted();
                if (payload.preserveLocalFiles) {
                    await updateTransferTask('qbittorrent', id, { status: 'completed', stage: 'completed', progress: 100, error: null, retryable: false, finishedAt: new Date() });
                    return;
                }
                await updateTransferTask('qbittorrent', id, { stage: 'cleaning', payload: { cleanupStarted: false } });
            }
            controller.signal.throwIfAborted();
            const downloadRoot = await fs.realpath(payload.downloadRoot);
            if (await fs.realpath(payload.savePath) !== path.join(downloadRoot, task.id)) throw new Error('清理目录已变化，已保留源文件');
            torrent = await assertQbOwnedTorrent(task, client);
            if (!torrent) throw new Error('清理前种子不存在，请检查本地文件后重试');
            const allFiles = await client.files(payload.hash);
            for (const file of allFiles) {
                if (path.isAbsolute(file.name) || file.name.includes('\\') || file.name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('种子文件路径已变化，已停止清理');
            }
            const files = allFiles.filter(file => file.priority > 0);
            if (!files.length || files.some(file => !payload.files.some(item => item.index === file.index && item.fileId && item.name === file.name && item.size === file.size))) throw new Error('清理前发现尚未转存的文件，已保留源文件');
            const savedIds = payload.files.filter(file => file.fileId).map(file => file.fileId!);
            const indexed = await query('SELECT id FROM files WHERE id=ANY($1::uuid[])', [savedIds]);
            if (indexed.rowCount !== savedIds.length) throw new Error('转存文件索引不完整，已保留源文件');
            controller.signal.throwIfAborted();
            await updateTransferTask('qbittorrent', id, { payload: { cleanupStarted: true } });
            await client.control(payload.hash, 'delete');
            // qBittorrent deletion is asynchronous; completion is confirmed on the next poll.
        } catch (error) {
            if (controller.signal.aborted) return;
            await updateTransferTask('qbittorrent', id, { status: 'failed', retryable: true, error: error instanceof Error ? error.message : String(error) });
        } finally { running.delete(id); }
    });
}

export async function tickQbTasks(): Promise<void> {
    if (stopped || tickFlight) return tickFlight || undefined;
    tickFlight = (async () => {
        if (!await qbEnabled()) return;
        const config = await getQbConfig();
        const tasks = await query(`SELECT id FROM transfer_tasks WHERE source_type='qbittorrent' AND status IN ('pending','running') ORDER BY created_at ASC`);
        for (const row of tasks.rows) {
            if (stopped || !await qbEnabled()) break;
            await processTask(String(row.id), config);
        }
    })().catch(error => { console.error('[qBittorrent] task polling failed:', error); }).finally(() => { tickFlight = null; });
    return tickFlight;
}

export function startQbTasks(): void {
    stopped = false;
    if (!timer) { timer = setInterval(() => { void tickQbTasks(); }, 5_000); timer.unref(); }
    void tickQbTasks();
}

export async function stopQbTasks(): Promise<void> {
    stopped = true;
    clearInterval(timer);
    timer = undefined;
    for (const controller of running.values()) controller.abort();
    await tickFlight;
}

export async function controlQbTask(id: string, action: string): Promise<void> {
    if (!await qbEnabled()) throw new Error('qBittorrent 扩展未开启');
    if (!['pause', 'resume', 'retry', 'cancel'].includes(action)) throw new Error('不支持的 BT 任务操作');
    controlling.set(id, (controlling.get(id) || 0) + 1);
    running.get(id)?.abort();
    try {
        // Waiting for this lock joins the uploader, including abort compensation and temp cleanup.
        await taskLock(id, async () => {
            const task = await requireTask(id);
            if (['completed', 'cancelled'].includes(task.status)) throw new Error('任务已结束');
            const payload = task.payload as QbPayload;
            const config = await getQbConfig();
            assertConnection(payload, config);
            if (action === 'retry') {
                if (task.status !== 'failed') throw new Error('仅失败任务可以重试');
                await updateTransferTask('qbittorrent', id, { status: 'pending', error: null, retryable: false,
                    ...(task.cancelRequested || task.stage === 'cancelling' ? { stage: 'cancelling', cancelRequested: true, payload: { cleanupStarted: false, cleanupRequestedAt: null } } : {}) });
                return;
            }
            if (task.cancelRequested || task.stage === 'cancelling') throw new Error('任务正在取消清理，仅失败后可重试');
            if (task.stage === 'cleaning') throw new Error('源文件清理阶段仅支持重试');
            const client = new QbittorrentClient(config);
            if (action === 'cancel') {
                await updateTransferTask('qbittorrent', id, { status: 'running', stage: 'cancelling', cancelRequested: true,
                    retryable: false, error: null, finishedAt: null, payload: { cleanupStarted: false, cleanupRequestedAt: null, uploadSpeed: 0, downloadSpeed: 0 } });
                // Polling executes deletion from durable intent, also after a process restart.
                return;
            }
            const torrent = await assertQbOwnedTorrent(task, client);
            if (torrent) await client.control(payload.hash, action === 'resume' ? 'resume' : 'pause');
            if (!torrent && task.stage !== 'submitting') throw new Error('种子已被移除');
            await updateTransferTask('qbittorrent', id, { status: action === 'pause' ? 'paused' : 'pending', retryable: false, error: null, finishedAt: null });
        });
    } finally {
        const remaining = (controlling.get(id) || 1) - 1;
        if (remaining) controlling.set(id, remaining);
        else controlling.delete(id);
    }
    void tickQbTasks();
}

export async function qbTaskFiles(id: string, indexes?: number[]) {
    return taskLock(id, async () => {
        const task = await requireTask(id);
        const payload = task.payload as QbPayload;
        const config = await getQbConfig();
        assertConnection(payload, config);
        const client = new QbittorrentClient(config);
        if (!await assertQbOwnedTorrent(task, client)) throw new Error('种子尚未提交或已被移除');
        const files = await client.files(payload.hash);
        if (indexes) {
            if (task.cancelRequested || task.stage === 'cancelling') throw new Error('任务正在取消清理，不能更改文件选择');
            if (task.completedItems > 0 || ['uploading', 'cleaning', 'completed', 'cancelled'].includes(task.stage)) throw new Error('开始转存后不能更改文件选择');
            if (!indexes.length || indexes.some(index => !Number.isInteger(index) || !files.some(file => file.index === index))) throw new Error('至少选择一个有效文件');
            await client.select(payload.hash, files, indexes);
            return { files: await client.files(payload.hash) };
        }
        return { files };
    });
}
