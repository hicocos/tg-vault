import { Api } from 'telegram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { query, pool } from '../db/index.js';
import { storageManager, isStorageQuotaCooldownError, type StorageTargetSnapshot } from './storage.js';
import { assertStorageTargetWritable, formatStorageCooldownNotice } from './storageCooldownGuard.js';
import { markStorageAccountCooldown } from './storageCooldown.js';
import { formatBytes, getFileType, getMimeTypeFromFilename, sanitizeFilename } from '../utils/telegramUtils.js';
import { generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';
import { getUniqueStoredName } from '../utils/fileUtils.js';
import { findDuplicateFile, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { acquireStorageAccountOperationLease, withStorageAccountOperationLease } from './storageAccountOperation.js';
import { lockStorageAccountForUse } from './storageAccountLifecycle.js';
import {
    createTransferTask,
    getTransferTask,
    listTransferTasks,
    type TransferTaskRecord,
} from './transferTasks.js';
import {
    beginYtDlpWrite,
    claimYtDlpExecution,
    markYtDlpIndexPresent,
    markYtDlpObjectPresent,
    renewYtDlpExecution,
    retryYtDlpExecution,
    cancelYtDlpExecution,
    settleYtDlpExecution,
    updateYtDlpCompensation,
    updateYtDlpExecutionProgress,
    type YtDlpExecutionClaim,
} from './ytDlpExecution.js';

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const YTDLP_WORK_DIR = process.env.YTDLP_WORK_DIR || './data/uploads/ytdlp';
const YTDLP_MAX_CONCURRENT = Math.max(1, parseInt(process.env.YTDLP_MAX_CONCURRENT || '1', 10) || 1);
const activeControllers = new Map<string, AbortController>();
let initialized = false;

type YtDlpNotifier = (chatId: string, message: string) => Promise<void>;
let taskNotifier: YtDlpNotifier | null = null;

export function setYtDlpNotifier(notifier: YtDlpNotifier | null): void {
    taskNotifier = notifier;
}

function ensureDir(directory: string): void {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

async function safeRmDir(directory: string): Promise<void> {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

function isYtDlpSidecarOrTemporaryFile(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return lower.endsWith('.part')
        || lower.endsWith('.ytdl')
        || lower.endsWith('.tmp')
        || lower.endsWith('.info.json')
        || lower.endsWith('.live_chat.json')
        || lower.endsWith('.description')
        || lower.endsWith('.annotations.xml');
}

export function selectPrimaryOutputFile(taskDir: string): { filePath: string; fileName: string; size: number } | null {
    const collectFiles = (directory: string): Array<{ name: string; fullPath: string; size: number }> => {
        const entries = fs.readdirSync(directory, { withFileTypes: true });
        return entries.flatMap(entry => {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) return collectFiles(fullPath);
            if (!entry.isFile() || isYtDlpSidecarOrTemporaryFile(entry.name)) return [];
            const size = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
            return size > 0 ? [{ name: entry.name, fullPath, size }] : [];
        });
    };

    const files = collectFiles(taskDir).sort((a, b) => b.size - a.size);
    if (files.length === 0) return null;
    return { filePath: files[0].fullPath, fileName: files[0].name, size: files[0].size };
}

interface ParsedYtDlpProgress {
    percent: number;
    speed?: string;
    eta?: string;
}

export function parseYtDlpProgress(line: string): ParsedYtDlpProgress | null {
    const match = line.match(/\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/i);
    if (!match) return null;
    const speed = line.match(/\bat\s+([^\s]+)/i)?.[1];
    const eta = line.match(/\bETA\s+([^\s]+)/i)?.[1];
    return { percent: Math.max(0, Math.min(100, Number(match[1]))), speed, eta };
}

async function runYtDlpDownload(
    url: string,
    taskDir: string,
    signal: AbortSignal,
    onProgress: (progress: ParsedYtDlpProgress) => void,
): Promise<void> {
    ensureDir(taskDir);
    const outputTemplate = path.join(taskDir, '%(title).200s-%(id)s.%(ext)s');
    const args = ['--no-playlist', '--newline', '--merge-output-format', 'mp4', '-o', outputTemplate, '--', url];

    await new Promise<void>((resolve, reject) => {
        const binLower = YTDLP_BIN.toLowerCase();
        const needsShell = os.platform() === 'win32' && (binLower.endsWith('.cmd') || binLower.endsWith('.bat'));
        const child = spawn(YTDLP_BIN, args, { windowsHide: true, shell: needsShell });
        let stderr = '';
        let lineBuffer = '';
        let killTimer: NodeJS.Timeout | null = null;
        let settled = false;
        let abortRequested = false;

        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abortChild);
            if (killTimer) clearTimeout(killTimer);
            error ? reject(error) : resolve();
        };
        const abortChild = () => {
            if (abortRequested || settled) return;
            abortRequested = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        };
        const cancellationError = () => Object.assign(new Error('yt-dlp task cancelled'), { name: 'AbortError' });
        const consume = (text: string, isError: boolean) => {
            if (isError) {
                stderr += text;
                if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
            }
            lineBuffer += text;
            const lines = lineBuffer.split(/\r?\n|\r/);
            lineBuffer = lines.pop() || '';
            for (const line of lines) {
                const parsed = parseYtDlpProgress(line);
                if (parsed) onProgress(parsed);
            }
        };

        child.stdout.on('data', data => consume(data.toString(), false));
        child.stderr.on('data', data => consume(data.toString(), true));
        child.once('error', error => finish(abortRequested ? cancellationError() : error));
        child.once('close', code => {
            if (abortRequested || signal.aborted) return finish(cancellationError());
            if (code === 0) return finish();
            finish(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        });
        if (signal.aborted) abortChild();
        else signal.addEventListener('abort', abortChild, { once: true });
    });
}

function taskTarget(task: TransferTaskRecord): StorageTargetSnapshot {
    if (!task.targetProvider) throw new Error('任务缺少存储目标快照');
    return storageManager.getTarget(task.targetProvider, task.targetAccountId);
}

async function uploadDownloadedFile(
    task: TransferTaskRecord,
    execution: YtDlpExecutionClaim,
    localFilePath: string,
    originalFileName: string,
    signal: AbortSignal,
): Promise<{ finalPath: string; providerName: string; size: number; storedName: string; folder: string; operationId: string | null; fileId: string }> {
    const target = taskTarget(task);
    const { provider, accountId } = target;
    await assertStorageTargetWritable(target);
    if (signal.aborted) throw Object.assign(new Error('yt-dlp task cancelled'), { name: 'AbortError' });

    const safeName = sanitizeFilename(originalFileName);
    const mimeType = getMimeTypeFromFilename(safeName);
    const fileType = getFileType(mimeType);
    const folder = task.targetFolder || 'ytdlp';
    const storedName = await getUniqueStoredName(safeName, folder, accountId);
    const stats = await fs.promises.stat(localFilePath);
    const size = stats.size;
    const duplicateMode = await getDuplicateMode();
    if (duplicateMode === 'skip') {
        const duplicate = await findDuplicateFile(safeName, folder, size, accountId);
        if (duplicate) {
            return {
                finalPath: duplicate.path || '',
                providerName: provider.name,
                size,
                storedName: duplicate.name,
                folder,
                operationId: null,
                fileId: duplicate.id,
            };
        }
    }

    let thumbnailPath: string | null = null;
    let dimensions: { width?: number; height?: number } = {};
    if (provider.name === 'local' && (mimeType.startsWith('image/') || mimeType.startsWith('video/'))) {
        try {
            thumbnailPath = await generateThumbnail(localFilePath, storedName, mimeType);
            dimensions = await getImageDimensions(localFilePath, mimeType);
        } catch {
            thumbnailPath = null;
        }
    }

    const operationId = crypto.randomUUID();
    await beginYtDlpWrite(pool, {
        operationId,
        taskId: task.id,
        generation: execution.generation,
        leaseToken: execution.leaseToken,
        provider: provider.name,
        accountId,
    });
    let finalPath: string | null = null;
    let fileId: string | null = null;
    try {
        finalPath = await withStorageAccountOperationLease(pool, accountId, 'ytdlp_upload', async () => {
            if (!(await renewYtDlpExecution(pool, task.id, execution.generation, execution.leaseToken))) {
                throw Object.assign(new Error('yt-dlp execution lease lost'), { name: 'AbortError' });
            }
            const savedPath = await provider.saveFile(localFilePath, storedName, mimeType, folder);
            finalPath = savedPath;
            await markYtDlpObjectPresent(pool, operationId, savedPath);
            if (signal.aborted || !(await renewYtDlpExecution(pool, task.id, execution.generation, execution.leaseToken))) {
                throw Object.assign(new Error('yt-dlp task cancelled'), { name: 'AbortError' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const inserted = await client.query(
                    `INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
                    [safeName, storedName, fileType, mimeType, size, savedPath, thumbnailPath, dimensions.width, dimensions.height, provider.name, folder, accountId],
                );
                fileId = String(inserted.rows[0].id);
                await markYtDlpIndexPresent(client, operationId, fileId);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw error;
            } finally {
                client.release();
            }
            return savedPath;
        });
    } catch (error) {
        let objectDeleted = finalPath === null;
        let indexDeleted = fileId === null;
        if (finalPath) {
            try { await provider.deleteFile(finalPath); objectDeleted = true; } catch { objectDeleted = false; }
        }
        if (fileId) {
            try {
                const deleted = await query('DELETE FROM files WHERE id = $1', [fileId]);
                indexDeleted = deleted.rowCount === 1;
            } catch {
                indexDeleted = false;
            }
        }
        await updateYtDlpCompensation(pool, {
            operationId,
            objectDeleted,
            indexDeleted,
            reason: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        throw error;
    }
    await fs.promises.rm(localFilePath, { force: true }).catch(() => undefined);
    return { finalPath, providerName: provider.name, size, storedName, folder, operationId, fileId: fileId! };
}

function classifyYtDlpError(error: unknown): string {
    const raw = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (/unsupported url/i.test(raw)) return '该网站或链接暂不受 yt-dlp 支持，请检查链接是否为具体视频页面。';
    if (/sign in|login|cookies|members-only|private video|authentication/i.test(raw)) return '该内容需要登录或无权访问；当前任务未配置站点 Cookie。';
    if (/not available|video unavailable|removed/i.test(raw)) return '内容不存在、已下架或当前地区不可用。';
    if (/timed? out|network|connection|temporary failure|http error 5\d\d/i.test(raw)) return '下载站点或网络暂时不可用，可稍后重试。';
    if (/no space left|enospc/i.test(raw)) return '服务器临时磁盘空间不足，请清理空间后重试。';
    const oneLine = raw.replace(/\s+/g, ' ');
    return oneLine.length > 500 ? `${oneLine.slice(0, 500)}...` : oneLine || '未知错误';
}

async function notifyTask(task: TransferTaskRecord, message: string): Promise<void> {
    if (!task.chatId || !taskNotifier) return;
    await taskNotifier(task.chatId, message).catch(() => undefined);
}

async function executeYtDlpTask(id: string): Promise<void> {
    const leaseToken = crypto.randomUUID();
    const execution = await claimYtDlpExecution(pool, id, leaseToken);
    if (!execution) return;
    const task = await getTransferTask('ytdlp', id);
    if (!task) return;
    const controller = new AbortController();
    activeControllers.set(id, controller);
    const heartbeat = setInterval(() => {
        void renewYtDlpExecution(pool, id, execution.generation, execution.leaseToken).then(owned => {
            if (!owned) controller.abort('execution_lease_lost');
        }).catch(() => controller.abort('execution_heartbeat_failed'));
    }, 30_000);
    const workBaseDir = path.isAbsolute(YTDLP_WORK_DIR) ? YTDLP_WORK_DIR : path.join(process.cwd(), YTDLP_WORK_DIR);
    const taskDir = path.join(workBaseDir, id);
    await safeRmDir(taskDir);
    ensureDir(taskDir);
    let lastProgressPersistedAt = 0;

    try {
        await runYtDlpDownload(String(task.payload.url || task.source || ''), taskDir, controller.signal, progress => {
            const now = Date.now();
            if (now - lastProgressPersistedAt < 1_000 && progress.percent < 100) return;
            lastProgressPersistedAt = now;
            void updateYtDlpExecutionProgress(pool, id, execution.generation, execution.leaseToken, {
                progress: Math.min(90, progress.percent * 0.9),
                payload: { speed: progress.speed || null, eta: progress.eta || null },
            }).then(owned => {
                if (!owned) controller.abort('execution_lease_lost');
            }).catch(error => {
                console.error(`[yt-dlp] progress persistence failed: ${id}`, error);
                controller.abort('progress_persistence_failed');
            });
        });
        const primary = selectPrimaryOutputFile(taskDir);
        if (!primary) throw new Error('下载完成但未找到可上传的输出文件');
        const advancing = await updateYtDlpExecutionProgress(pool, id, execution.generation, execution.leaseToken, {
            stage: 'uploading',
            progress: 92,
            totalBytes: primary.size,
            payload: { outputFileName: primary.fileName },
        });
        if (!advancing) throw Object.assign(new Error('yt-dlp execution lease lost'), { name: 'AbortError' });
        const freshTask = await getTransferTask('ytdlp', id);
        if (!freshTask) throw new Error('任务记录不存在');
        const uploadResult = await uploadDownloadedFile(freshTask, execution, primary.filePath, primary.fileName, controller.signal);
        const completed = await settleYtDlpExecution(pool, {
            id,
            generation: execution.generation,
            leaseToken: execution.leaseToken,
            status: 'completed',
            stage: 'completed',
            progress: 100,
            completedItems: 1,
            transferredBytes: uploadResult.size,
            operationId: uploadResult.operationId || undefined,
            payload: {
                finalPath: uploadResult.finalPath,
                storedName: uploadResult.storedName,
                outputFileName: primary.fileName,
            },
        });
        if (!completed) {
            if (uploadResult.operationId) {
                const target = taskTarget(freshTask);
                let objectDeleted = false;
                let indexDeleted = false;
                try { await target.provider.deleteFile(uploadResult.finalPath); objectDeleted = true; } catch { objectDeleted = false; }
                try {
                    const deleted = await query('DELETE FROM files WHERE id = $1', [uploadResult.fileId]);
                    indexDeleted = deleted.rowCount === 1;
                } catch { indexDeleted = false; }
                await updateYtDlpCompensation(pool, {
                    operationId: uploadResult.operationId,
                    objectDeleted,
                    indexDeleted,
                    reason: '任务终态 CAS 失败，已执行取消补偿',
                });
            }
            throw Object.assign(new Error('yt-dlp completion lost execution ownership'), { name: 'AbortError' });
        }
        const completedTask = await getTransferTask('ytdlp', id);
        if (completedTask) {
            await notifyTask(completedTask, [
                '✅ yt-dlp 任务已完成',
                '',
                `文件: ${primary.fileName}`,
                `大小: ${formatBytes(uploadResult.size)}`,
                `存储源: ${uploadResult.providerName}`,
                `保存位置: ${uploadResult.folder}`,
                `任务: ${completedTask.id}`,
            ].join('\n'));
        }
    } catch (error) {
        const current = await getTransferTask('ytdlp', id);
        const cancelled = controller.signal.aborted || current?.status === 'cancelled' || current?.status === 'pending';
        if (!cancelled) {
            let message = classifyYtDlpError(error);
            if (isStorageQuotaCooldownError(error)) {
                await markStorageAccountCooldown(error.storageAccountId || task.targetAccountId, error.provider, error.reason, error.cooldownUntil, error.message);
                message = `${formatStorageCooldownNotice(error.cooldownUntil)} 可在恢复时间后重试本任务。`;
            }
            const pendingJournal = (await query(
                `SELECT operation_id FROM ytdlp_write_reconciliations WHERE task_id = $1 AND status = 'pending' LIMIT 1`,
                [id],
            )).rows[0];
            const failed = await settleYtDlpExecution(pool, {
                id,
                generation: execution.generation,
                leaseToken: execution.leaseToken,
                status: 'failed',
                stage: pendingJournal ? 'reconciliation_required' : 'failed',
                error: pendingJournal ? `${message}；外部写结果待对账，已阻止重试。` : message,
                retryable: !pendingJournal,
                failedItems: 1,
            });
            if (failed) {
                const failedTask = await getTransferTask('ytdlp', id);
                if (failedTask) await notifyTask(failedTask, `❌ yt-dlp 任务失败\n\n原因: ${failedTask.error}\n任务: ${failedTask.id}${failedTask.retryable ? '\n可在 Web 任务中心重试。' : ''}`);
            }
        }
    } finally {
        clearInterval(heartbeat);
        activeControllers.delete(id);
        await safeRmDir(taskDir);
        const current = await getTransferTask('ytdlp', id);
        if (current?.status === 'pending') ytDlpQueue.enqueue(id);
    }
}

export class PersistentYtDlpQueue {
    private readonly pending: string[] = [];
    private readonly known = new Set<string>();
    private activeCount = 0;

    constructor(
        private readonly maxConcurrent = YTDLP_MAX_CONCURRENT,
        private readonly worker: (id: string) => Promise<void> = executeYtDlpTask,
        private readonly shouldRequeue: (id: string) => Promise<boolean> = async id => (await getTransferTask('ytdlp', id))?.status === 'pending',
    ) {}

    enqueue(id: string): void {
        if (this.known.has(id) || activeControllers.has(id)) return;
        this.known.add(id);
        this.pending.push(id);
        this.process();
    }

    private process(): void {
        while (this.activeCount < this.maxConcurrent && this.pending.length > 0) {
            const id = this.pending.shift()!;
            this.activeCount += 1;
            void this.worker(id).finally(() => {
                this.known.delete(id);
                this.activeCount -= 1;
                void this.shouldRequeue(id).then(requeue => {
                    if (requeue) this.enqueue(id);
                    this.process();
                }).catch(error => {
                    console.error(`[yt-dlp] durable requeue check failed: ${id}`, error);
                    this.process();
                });
            });
        }
    }
}

const ytDlpQueue = new PersistentYtDlpQueue();

export async function initializeYtDlpQueue(): Promise<void> {
    if (initialized) return;
    initialized = true;
    ensureDir(path.isAbsolute(YTDLP_WORK_DIR) ? YTDLP_WORK_DIR : path.join(process.cwd(), YTDLP_WORK_DIR));
    const tasks = await listTransferTasks({ sourceType: 'ytdlp', limit: 500 });
    for (const task of tasks) {
        if (task.status === 'pending') ytDlpQueue.enqueue(task.id);
    }
}

export async function cancelYtDlpTask(id: string): Promise<TransferTaskRecord | null> {
    const task = await getTransferTask('ytdlp', id);
    if (!task || ['completed', 'cancelled'].includes(task.status)) return task;
    const cancelled = await cancelYtDlpExecution(pool, id);
    if (!cancelled) return null;
    activeControllers.get(id)?.abort('user_cancelled');
    if (!activeControllers.has(id)) {
        const workBaseDir = path.isAbsolute(YTDLP_WORK_DIR) ? YTDLP_WORK_DIR : path.join(process.cwd(), YTDLP_WORK_DIR);
        await safeRmDir(path.join(workBaseDir, id));
    }
    return getTransferTask('ytdlp', id);
}

export async function retryYtDlpTask(id: string): Promise<TransferTaskRecord | null> {
    const task = await getTransferTask('ytdlp', id);
    if (!task || !['failed', 'interrupted', 'retry_required', 'cancelled'].includes(task.status)) return null;
    const pending = await retryYtDlpExecution(pool, id);
    if (!pending) return null;
    ytDlpQueue.enqueue(id);
    return getTransferTask('ytdlp', id);
}

export async function handleYtDlpCommand(message: Api.Message, url: string): Promise<void> {
    const id = `yd-${crypto.randomBytes(8).toString('hex')}`;
    const target = storageManager.getActiveTarget();
    await assertStorageTargetWritable(target);
    const client = target.accountId ? await pool.connect() : null;
    let admissionLease: Awaited<ReturnType<typeof acquireStorageAccountOperationLease>> | null = null;
    let account: { name?: string } | null = null;
    try {
        if (client && target.accountId) {
            await client.query('BEGIN');
            const locked = await lockStorageAccountForUse(client, target.accountId);
            if (locked.type !== target.provider.name) throw new Error('yt-dlp 目标账户与 provider 不匹配');
            admissionLease = await acquireStorageAccountOperationLease(pool, target.accountId, 'ytdlp_admission');
            account = (await client.query('SELECT name FROM storage_accounts WHERE id = $1', [target.accountId])).rows[0] || null;
            await client.query('COMMIT');
        }
        const task = await createTransferTask({
            sourceType: 'ytdlp',
            id,
            kind: 'video_download',
            title: `yt-dlp: ${new URL(url).hostname}`,
            status: 'pending',
            stage: 'waiting',
            ownerUserId: message.senderId?.toJSNumber() ?? null,
            chatId: message.chatId?.toString() || null,
            source: url,
            targetProvider: target.provider.name,
            targetAccountId: target.accountId,
            targetFolder: 'ytdlp',
            totalItems: 1,
            payload: { url, targetAccountName: account?.name || (target.provider.name === 'local' ? '服务器本地目录' : null) },
            retryable: false,
        });
        ytDlpQueue.enqueue(task.id);
        await message.reply({
            message: [
                '⏬ yt-dlp 任务已提交',
                `任务: ${task.id}`,
                `目标: ${task.targetProvider} / ${String(task.payload.targetAccountName || '默认账户')}`,
                `目录: ${task.targetFolder}`,
                '',
                '可用 /tasks 查看阶段和进度；提交后的目标不会随系统默认存储切换而改变。',
            ].join('\n'),
        });
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client?.release();
        await admissionLease?.release();
    }
}
