import { Api } from 'telegram';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';
import { query, pool } from '../db/index.js';
import { storageManager, isStorageQuotaCooldownError } from './storage.js';
import { assertActiveStorageWritable, formatStorageCooldownNotice } from './storageCooldownGuard.js';
import { markStorageAccountCooldown } from './storageCooldown.js';
import { formatBytes, getFileType, getMimeTypeFromFilename, sanitizeFilename } from '../utils/telegramUtils.js';
import { generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';
import { getUniqueStoredName } from '../utils/fileUtils.js';
import { buildStorageFolderWithRules, getStoragePathRules } from '../utils/storagePath.js';
import { findDuplicateFile, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { saveAndIndexWithCompensation } from './storageWrite.js';
import { withStorageAccountOperationLease } from './storageAccountOperation.js';

type YtDlpTaskStatus = 'pending' | 'active' | 'success' | 'failed';

interface YtDlpTask {
    id: string;
    url: string;
    status: YtDlpTaskStatus;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
}

class YtDlpQueue {
    private queue: Array<() => Promise<void>> = [];
    private activeCount = 0;
    constructor(private maxConcurrent: number) { }

    add(job: () => Promise<void>) {
        this.queue.push(job);
        this.process();
    }

    private process() {
        while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
            const job = this.queue.shift()!;
            this.activeCount += 1;
            job().finally(() => {
                this.activeCount -= 1;
                this.process();
            });
        }
    }
}

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const YTDLP_WORK_DIR = process.env.YTDLP_WORK_DIR || './data/uploads/ytdlp';
const YTDLP_MAX_CONCURRENT = Math.max(1, parseInt(process.env.YTDLP_MAX_CONCURRENT || '1', 10) || 1);

const ytDlpQueue = new YtDlpQueue(YTDLP_MAX_CONCURRENT);

function ensureDir(p: string) {
    if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
    }
}

function safeRmDir(dir: string) {
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch {
    }
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
    const collectFiles = (dir: string): Array<{ name: string; fullPath: string; size: number }> => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return entries.flatMap(entry => {
            const fullPath = path.join(dir, entry.name);
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

async function runYtDlpDownload(url: string, taskDir: string): Promise<void> {
    ensureDir(taskDir);

    const outputTemplate = path.join(taskDir, '%(title).200s-%(id)s.%(ext)s');
    const args = [
        '--no-playlist',
        '--newline',
        '--merge-output-format',
        'mp4',
        '-o',
        outputTemplate,
        '--',
        url,
    ];

    await new Promise<void>((resolve, reject) => {
        const binLower = YTDLP_BIN.toLowerCase();
        const isWindows = os.platform() === 'win32';
        const needsShell = isWindows && (binLower.endsWith('.cmd') || binLower.endsWith('.bat'));

        const child = spawn(YTDLP_BIN, args, {
            windowsHide: true,
            shell: needsShell,
        });

        let stderr = '';

        child.stderr.on('data', (d) => {
            stderr += d.toString();
            if (stderr.length > 4000) stderr = stderr.slice(-4000);
        });

        child.on('error', (err) => {
            reject(err);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            const msg = stderr.trim() || `yt-dlp exited with code ${code}`;
            reject(new Error(msg));
        });
    });
}

async function uploadDownloadedFile(localFilePath: string, originalFileName: string): Promise<{ finalPath: string; providerName: string; size: number; storedName: string; folder: string }> {
    const provider = storageManager.getProvider();
    const activeAccountId = storageManager.getActiveAccountId();
    await assertActiveStorageWritable();

    const safeName = sanitizeFilename(originalFileName);
    const ext = path.extname(safeName) || path.extname(localFilePath) || '';

    const mimeType = getMimeTypeFromFilename(safeName);
    const fileType = getFileType(mimeType);
    const storageRules = await getStoragePathRules();
    const folder = buildStorageFolderWithRules({ source: 'ytdlp', mimeType, fileName: safeName }, storageRules) || 'ytdlp';

    // 获取唯一的存储文件名
    const storedName = await getUniqueStoredName(safeName, folder, activeAccountId);

    const stats = await fs.promises.stat(localFilePath);
    const size = stats.size;
    const duplicateMode = await getDuplicateMode();
    if (duplicateMode === 'skip') {
        const duplicate = await findDuplicateFile(safeName, folder, size, activeAccountId);
        if (duplicate) {
            return { finalPath: duplicate.path || '', providerName: provider.name, size, storedName: duplicate.name, folder };
        }
    }

    let thumbnailPath: string | null = null;
    let dimensions: { width?: number; height?: number } = {};
    // 方案A：只在本地存储生成缩略图；第三方存储不生成本地缩略图。
    if (provider.name === 'local' && (mimeType.startsWith('image/') || mimeType.startsWith('video/'))) {
        try {
            thumbnailPath = await generateThumbnail(localFilePath, storedName, mimeType);
            dimensions = await getImageDimensions(localFilePath, mimeType);
        } catch {
        }
    }

    const finalPath = await withStorageAccountOperationLease(pool, activeAccountId, 'ytdlp_upload', () =>
        saveAndIndexWithCompensation(provider, localFilePath, storedName, mimeType, folder, async savedPath => {
            await query(`
                INSERT INTO files (name, stored_name, type, mime_type, size, path, thumbnail_path, width, height, source, folder, storage_account_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [safeName, storedName, fileType, mimeType, size, savedPath, thumbnailPath, dimensions.width, dimensions.height, provider.name, folder, activeAccountId]);
        }),
    );
    try {
        if (fs.existsSync(localFilePath)) await fs.promises.unlink(localFilePath);
    } catch {
    }

    return { finalPath, providerName: provider.name, size, storedName, folder };
}

export async function handleYtDlpCommand(message: Api.Message, url: string): Promise<void> {
    const task: YtDlpTask = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        url,
        status: 'pending',
        createdAt: Date.now(),
    };

    const workBaseDir = path.isAbsolute(YTDLP_WORK_DIR) ? YTDLP_WORK_DIR : path.join(process.cwd(), YTDLP_WORK_DIR);
    ensureDir(workBaseDir);

    const taskDir = path.join(workBaseDir, task.id);

    await message.reply({ message: `⏬ 开始解析并下载...\nTask: ${task.id}` });

    ytDlpQueue.add(async () => {
        task.status = 'active';
        task.startedAt = Date.now();

        try {
            await runYtDlpDownload(task.url, taskDir);
            const primary = selectPrimaryOutputFile(taskDir);
            if (!primary) {
                throw new Error('下载完成但未找到输出文件');
            }

            const uploadResult = await uploadDownloadedFile(primary.filePath, primary.fileName);

            task.status = 'success';
            task.finishedAt = Date.now();

            const text = `✅ 已上传\n\n文件: ${primary.fileName}\n大小: ${formatBytes(uploadResult.size)}\n存储源: ${uploadResult.providerName}`;

            try {
                await message.reply({ message: text });
            } catch {
            }

        } catch (e: any) {
            task.status = 'failed';
            task.finishedAt = Date.now();
            task.error = (e instanceof Error) ? e.message : String(e);

            let replyText: string;
            if (isStorageQuotaCooldownError(e)) {
                await markStorageAccountCooldown(e.storageAccountId || storageManager.getActiveAccountId(), e.provider, e.reason, e.cooldownUntil, e.message);
                replyText = [
                    formatStorageCooldownNotice(e.cooldownUntil),
                    '',
                    'yt-dlp 任务没有持久化恢复队列；请在恢复时间后重新发送该链接，或先切换其它存储源。',
                ].join('\n');
            } else {
                const errText = (task.error || '未知错误').toString().trim();
                const trimmed = errText.length > 1500 ? errText.slice(0, 1500) + '...' : errText;
                replyText = `❌ 下载/上传失败\n\n原因: ${trimmed}`;
            }

            try {
                await message.reply({ message: replyText });
            } catch {
            }
        } finally {
            safeRmDir(taskDir);
        }
    });
}
