import { Api, TelegramClient } from 'telegram';
import { query } from '../db/index.js';
import checkDiskSpaceModule from 'check-disk-space';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { formatBytes, getTypeEmoji } from '../utils/telegramUtils.js';
import {
    MSG,
    buildWelcomeBack,
    buildHelp,
    buildStorageReport,
    buildFileList,
    buildTasksReport,
    buildDeleteSuccess,
} from '../utils/telegramMessages.js';
import { authenticatedUsers, passwordInputState, isAuthenticatedAsync } from './telegramState.js';
import { forceStopDownloadTasks, getDownloadQueueStats, getTaskStatus, pauseDownloadTasks, resumeDownloadTasks, cancelDownloadTask, retryFailedDownloadTasks, getFileDownloadConcurrency, setFileDownloadConcurrency } from './telegramUpload.js';
import { storageManager } from './storage.js';
import { listTelegramBackgroundJobs } from './telegramChannelJobs.js';
import { getSetting, setSetting } from '../utils/settings.js';
import { DuplicateMode, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { startPeriodicCleanup, stopPeriodicCleanup } from './orphanCleanup.js';
import { safeUnlink } from '../utils/localPath.js';
import { getCurrentStorageScope, nextParam, removePhysicalFile } from '../utils/fileScope.js';
import {
    buildPathSettingsKeyboard,
    buildPathSettingsText,
    buildPendingPathPromptPersistent,
    buildPathPreviewLine,
    clearTelegramPathState,
    getRecentTelegramPathsPersistent,
    setPendingTelegramPathInput,
    setNextTelegramPathPersistent,
    setSessionTelegramPathPersistent,
} from '../utils/telegramPathSettings.js';

// ESM compatibility
const checkDiskSpace = (checkDiskSpaceModule as any).default || checkDiskSpaceModule;
const DOWNLOAD_WORKER_OPTIONS = [4, 8, 12, 16];
const FILE_CONCURRENCY_OPTIONS = [1, 2, 3, 4];
const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR || './data/thumbnails';

interface PendingDeleteInfo {
    fileId: string;
    name: string;
    size: number;
    selector: string;
    createdAt: number;
}
const pendingDeleteConfirmations = new Map<string, PendingDeleteInfo>();
const DELETE_CONFIRM_TTL_MS = 5 * 60 * 1000;

function buildDeleteConfirmKeyboard(confirmId: string): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [new Api.KeyboardButtonRow({
            buttons: [
                new Api.KeyboardButtonCallback({ text: '⚠️ 确认删除', data: Buffer.from(`del_confirm_${confirmId}`) }),
                new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from(`del_cancel_${confirmId}`) }),
            ],
        })],
    });
}


function normalizeDownloadWorkers(value: unknown): number {
    const parsed = parseInt(String(value ?? '4'), 10);
    return DOWNLOAD_WORKER_OPTIONS.includes(parsed) ? parsed : 4;
}

async function getCurrentDownloadWorkers(): Promise<number> {
    const value = await getSetting('telegram_download_workers', process.env.TELEGRAM_DOWNLOAD_WORKERS || '4');
    return normalizeDownloadWorkers(value);
}

function buildDownloadWorkersKeyboard(current: number, confirmValue?: number): Api.ReplyInlineMarkup {
    if (confirmValue) {
        return new Api.ReplyInlineMarkup({
            rows: [
                new Api.KeyboardButtonRow({
                    buttons: [
                        new Api.KeyboardButtonCallback({ text: `⚠️ 确认使用 ${confirmValue}`, data: Buffer.from(`dw_confirm_${confirmValue}`) }),
                        new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('dw_cancel') }),
                    ],
                }),
            ],
        });
    }

    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${current === 4 ? '✅ ' : ''}4`, data: Buffer.from('dw_set_4') }),
                    new Api.KeyboardButtonCallback({ text: `${current === 8 ? '✅ ' : ''}8`, data: Buffer.from('dw_set_8') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${current === 12 ? '✅ ' : ''}12 ⚠️`, data: Buffer.from('dw_set_12') }),
                    new Api.KeyboardButtonCallback({ text: `${current === 16 ? '✅ ' : ''}16 ⚠️`, data: Buffer.from('dw_set_16') }),
                ],
            }),
        ],
    });
}

function buildStorageMaintenanceKeyboard(localFileCount: number, confirm = false): Api.ReplyInlineMarkup | undefined {
    if (localFileCount <= 0) return undefined;
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: confirm
                    ? [
                        new Api.KeyboardButtonCallback({ text: '⚠️ 确认删除本地全部下载文件', data: Buffer.from('storage_clear_confirm') }),
                        new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('storage_clear_cancel') }),
                    ]
                    : [
                        new Api.KeyboardButtonCallback({ text: `🧹 删除本地全部下载文件 (${localFileCount})`, data: Buffer.from('storage_clear_ask') }),
                    ],
            }),
        ],
    });
}

async function scanLocalDownloadFiles(): Promise<{ count: number; totalSize: number; paths: string[] }> {
    const baseDir = path.resolve(UPLOAD_DIR);
    const paths: string[] = [];
    let totalSize = 0;
    if (!fs.existsSync(baseDir)) return { count: 0, totalSize: 0, paths };

    async function walk(dir: string): Promise<void> {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                const stat = await fs.promises.stat(fullPath);
                totalSize += stat.size;
                paths.push(fullPath);
            }
        }
    }

    await walk(baseDir);
    return { count: paths.length, totalSize, paths };
}

async function pruneEmptyDirs(dir: string, baseDir = path.resolve(UPLOAD_DIR)): Promise<void> {
    if (!fs.existsSync(dir) || path.resolve(dir) === baseDir) return;
    const entries = await fs.promises.readdir(dir);
    if (entries.length === 0) {
        await fs.promises.rmdir(dir);
        await pruneEmptyDirs(path.dirname(dir), baseDir);
    }
}

function buildDownloadWorkersText(current: number): string {
    return [
        '⚙️ **Telegram 分片并发设置**',
        '',
        `当前 worker 数：**${current}**`,
        '',
        '说明：Telegram 单次请求上限仍是 512KB，这里调整的是单个文件内部的并发分片请求数。',
        '如果要调整“一次同时下载几个文件”，请使用 /file_concurrency。',
        '',
        '建议：',
        '- `4`：稳定优先',
        '- `8`：速度/稳定平衡',
        '- `12` / `16`：激进模式，可能触发风控、断流、限速，甚至账号风险，需要二次确认',
    ].join('\n');
}

function normalizeFileConcurrency(value: unknown): number {
    const parsed = parseInt(String(value ?? '2'), 10);
    return FILE_CONCURRENCY_OPTIONS.includes(parsed) ? parsed : 2;
}

async function getCurrentFileConcurrency(): Promise<number> {
    const value = await getSetting('telegram_file_download_concurrency', process.env.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY || String(getFileDownloadConcurrency()));
    return normalizeFileConcurrency(value);
}

function buildFileConcurrencyKeyboard(current: number, confirmValue?: number): Api.ReplyInlineMarkup {
    if (confirmValue) {
        return new Api.ReplyInlineMarkup({
            rows: [
                new Api.KeyboardButtonRow({
                    buttons: [
                        new Api.KeyboardButtonCallback({ text: `⚠️ 确认同时下载 ${confirmValue} 个文件`, data: Buffer.from(`fc_confirm_${confirmValue}`) }),
                        new Api.KeyboardButtonCallback({ text: '取消', data: Buffer.from('fc_cancel') }),
                    ],
                }),
            ],
        });
    }

    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${current === 1 ? '✅ ' : ''}1`, data: Buffer.from('fc_set_1') }),
                    new Api.KeyboardButtonCallback({ text: `${current === 2 ? '✅ ' : ''}2`, data: Buffer.from('fc_set_2') }),
                ],
            }),
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${current === 3 ? '✅ ' : ''}3`, data: Buffer.from('fc_set_3') }),
                    new Api.KeyboardButtonCallback({ text: `${current === 4 ? '✅ ' : ''}4 ⚠️`, data: Buffer.from('fc_set_4') }),
                ],
            }),
        ],
    });
}

function buildFileConcurrencyText(current: number): string {
    const stats = getDownloadQueueStats();
    return [
        '📦 **Telegram 文件级并发设置**',
        '',
        `当前同时下载文件数：**${current}**`,
        `当前队列：进行中 ${stats.active}，等待中 ${stats.pending}`,
        '',
        '说明：这里控制“一次同时下载几个文件”。',
        '它不同于 /download_workers：后者控制单个文件内部的 512KB 分片并发。',
        '',
        '建议：',
        '- `1`：最稳，适合风控/限速时使用',
        '- `2`：默认推荐，速度与稳定平衡',
        '- `3`：速度优先，适合线路稳定时使用',
        '- `4`：激进模式，可能触发 Telegram 限流或云盘上传限速，需要二次确认',
        '',
        '修改后会立即影响队列中新启动的文件下载；已在进行中的文件不会被中断。',
    ].join('\n');
}

function isOn(value: unknown, defaultValue = true): boolean {
    if (value === undefined || value === null || value === '') return defaultValue;
    return ON_VALUES.has(String(value).toLowerCase());
}

async function getPathCenterState(): Promise<{ automaticBySource: boolean; automaticByType: boolean }> {
    return { automaticBySource: true, automaticByType: true };
}

function buildDuplicateModeKeyboard(mode: DuplicateMode): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${mode === 'skip' ? '✅' : '⬜'} 跳过重复`, data: Buffer.from('dm_set_skip') }),
                    new Api.KeyboardButtonCallback({ text: `${mode === 'copy' ? '✅' : '⬜'} 生成副本`, data: Buffer.from('dm_set_copy') }),
                ],
            }),
        ],
    });
}

function buildDuplicateModeText(mode: DuplicateMode): string {
    return [
        '🧬 **重复文件处理**',
        '',
        `当前模式：${mode === 'skip' ? '跳过重复' : '生成副本'}`,
        '',
        '- 跳过重复：同名 + 同目录 + 同大小时不再保存',
        '- 生成副本：自动改名为 `文件 (1).ext` 保留副本',
        '',
        '说明：修改后只影响后续新上传/转存文件。',
    ].join('\n');
}

async function getCleanupEnabledSetting(): Promise<boolean> {
    const value = await getSetting('auto_cleanup_orphans', process.env.AUTO_CLEANUP_ORPHANS || 'true');
    return isOn(value, true);
}

function buildCleanupSettingsKeyboard(enabled: boolean): Api.ReplyInlineMarkup {
    return new Api.ReplyInlineMarkup({
        rows: [
            new Api.KeyboardButtonRow({
                buttons: [
                    new Api.KeyboardButtonCallback({ text: `${!enabled ? '✅' : '⬜'} 关闭自动清理`, data: Buffer.from('cs_set_off') }),
                    new Api.KeyboardButtonCallback({ text: `${enabled ? '✅' : '⬜'} 开启自动清理`, data: Buffer.from('cs_set_on') }),
                ],
            }),
        ],
    });
}

function buildCleanupSettingsText(enabled: boolean): string {
    return [
        '🧹 **自动清理设置**',
        '',
        `当前状态：${enabled ? '✅ 开启' : '⬜ 关闭'}`,
        '',
        '开启后会自动清理本地 uploads 中未登记到数据库的孤儿文件。',
        '如果你主要使用本地存储，建议点“关闭自动清理”，防止默认删除文件。',
        '',
        '说明：只影响本地 uploads 孤儿文件，不会主动清理第三方云存储。',
    ].join('\n');
}

function getCallbackChatKey(update: Api.UpdateBotCallbackQuery): string {
    const peer: any = update.peer as any;
    const value = peer?.userId || peer?.chatId || peer?.channelId || update.userId;
    if (value && typeof value.toJSNumber === 'function') return String(value.toJSNumber());
    if (value !== undefined && value !== null) return String(value);
    return String(update.userId.toJSNumber());
}

export async function handleStart(message: Api.Message, senderId: number): Promise<void> {
    if (await isAuthenticatedAsync(senderId)) {
        await message.reply({ message: buildWelcomeBack() });
    } else {
        passwordInputState.set(senderId, { password: '' });
    }
}

export async function handleHelp(message: Api.Message): Promise<void> {
    await message.reply({ message: buildHelp() });
}

export async function handleStorage(message: Api.Message): Promise<void> {
    try {
        const scope = await getCurrentStorageScope();
        const diskPath = os.platform() === 'win32' ? 'C:' : '/';
        const diskSpace = await checkDiskSpace(diskPath);

        // Fetch stats for the active account
        const result = await query(`
            SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size
            FROM files
            WHERE ${scope.clause}
        `, scope.params);
        const flcloudsStats = result.rows[0];
        const totalSize = parseInt(flcloudsStats.total_size);
        const fileCount = parseInt(flcloudsStats.file_count);
        const usedPercent = Math.round(((diskSpace.size - diskSpace.free) / diskSpace.size) * 100);

        const queueStats = getDownloadQueueStats();
        const localStats = await scanLocalDownloadFiles();

        const reply = buildStorageReport({
            diskTotal: diskSpace.size,
            diskFree: diskSpace.free,
            diskUsedPercent: usedPercent,
            fileCount,
            totalFileSize: totalSize,
            localFileCount: localStats.count,
            localTotalSize: localStats.totalSize,
            queueActive: queueStats.active,
            queuePending: queueStats.pending,
        });

        await message.reply({
            message: reply,
            buttons: buildStorageMaintenanceKeyboard(localStats.count),
        });
    } catch (error) {
        console.error('🤖 获取存储统计失败:', error);
        await message.reply({ message: MSG.ERR_STORAGE });
    }
}

export async function handleStorageCleanupCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const stats = await scanLocalDownloadFiles();
        if (data === 'storage_clear_cancel') {
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: stats.count > 0 ? `已取消清理。当前本地下载文件：${stats.count} 个，占用 ${formatBytes(stats.totalSize)}。` : '已取消清理。当前没有本地下载文件。',
                buttons: buildStorageMaintenanceKeyboard(stats.count),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
            return;
        }

        if (data === 'storage_clear_ask') {
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: [
                    '⚠️ **确认删除本地服务器全部下载文件？**',
                    '',
                    `将删除 uploads 本地目录中的 **${stats.count}** 个文件，占用 **${formatBytes(stats.totalSize)}**。`,
                    '这只清理服务器本地下载/缓存文件，不会主动删除 OneDrive 等云端存储里的文件记录。',
                    '',
                    '如确认，请点击下方红色确认按钮。',
                ].join('\n'),
                buttons: buildStorageMaintenanceKeyboard(stats.count, true),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '需要二次确认' }));
            return;
        }

        if (data === 'storage_clear_confirm') {
            let deletedCount = 0;
            let deletedBytes = 0;
            for (const filePath of stats.paths) {
                const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
                if (await safeUnlink(filePath, UPLOAD_DIR)) {
                    deletedCount += 1;
                    deletedBytes += size;
                    await pruneEmptyDirs(path.dirname(filePath));
                }
            }
            const after = await scanLocalDownloadFiles();
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: [
                    '✅ **本地服务器下载文件已清理**',
                    '',
                    `已删除：${deletedCount} 个文件`,
                    `释放空间：${formatBytes(deletedBytes)}`,
                    `剩余本地文件：${after.count} 个`,
                ].join('\n'),
                buttons: buildStorageMaintenanceKeyboard(after.count),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已删除 ${deletedCount} 个文件` }));
        }
    } catch (error) {
        console.error('🤖 清理本地下载文件失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `清理失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleList(message: Api.Message, args: string[]): Promise<void> {
    try {
        let limit = 10;
        let page = 1;
        if (args.length > 0) {
            const parsed = parseInt(args[0]);
            if (!isNaN(parsed) && parsed > 0 && parsed <= 50) {
                limit = parsed;
            }
        }
        if (args.length > 1) {
            const parsedPage = parseInt(args[1]);
            if (!isNaN(parsedPage) && parsedPage > 0) {
                page = parsedPage;
            }
        }

        const scope = await getCurrentStorageScope();
        const offset = (page - 1) * limit;
        const result = await query(`
            SELECT id, name, type, size, folder, created_at
            FROM files
            WHERE ${scope.clause}
            ORDER BY created_at DESC
            LIMIT ${nextParam(scope, 1)} OFFSET ${nextParam(scope, 2)}
        `, [...scope.params, limit, offset]);

        if (result.rows.length === 0) {
            await message.reply({ message: MSG.EMPTY_FILES });
            return;
        }

        const reply = buildFileList(result.rows, result.rows.length);
        await message.reply({ message: reply });
    } catch (error) {
        console.error('🤖 获取文件列表失败:', error);
        await message.reply({ message: MSG.ERR_FILE_LIST });
    }
}

export async function handleDelete(message: Api.Message, args: string[]): Promise<void> {
    if (args.length === 0) {
        await message.reply({
            message: '❌ 请提供要删除的文件 ID 前缀\n\n用法：/delete <至少 8 位 ID 前缀>\n提示：请从网页端文件列表复制文件 ID。'
        });
        return;
    }

    const selector = args[0].trim();

    try {
        const scope = await getCurrentStorageScope();
        if (/^\d+$/.test(selector)) {
            await message.reply({ message: '❌ 为避免误删，Telegram Bot 不再支持按列表序号删除。请从网页端复制至少 8 位文件 ID 前缀。' });
            return;
        }
        if (selector.length < 8) {
            await message.reply({ message: '❌ ID 前缀至少需要 8 位。请从网页端文件列表复制更长的文件 ID。' });
            return;
        }
        const result = await query(`
            SELECT *
            FROM files
            WHERE ${scope.clause} AND id::text LIKE ${nextParam(scope, 1)}
            ORDER BY created_at DESC
            LIMIT 3
        `, [...scope.params, selector + '%']);

        if (result.rows.length === 0) {
            await message.reply({ message: `❌ 未找到 ID 以 "${selector}" 开头的文件` });
            return;
        }
        if (result.rows.length > 1) {
            await message.reply({ message: `❌ ID 前缀 "${selector}" 匹配到多个文件，请复制更长的 ID 前缀后重试。` });
            return;
        }

        const file = result.rows[0];
        const confirmId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        pendingDeleteConfirmations.set(confirmId, { fileId: file.id, name: file.name, size: Number(file.size || 0), selector, createdAt: Date.now() });
        await message.reply({
            message: [
                '⚠️ **确认删除这个文件？**',
                '',
                `📄 ${file.name}`,
                `🆔 ${String(file.id).slice(0, 12)}`,
                `📦 ${formatBytes(Number(file.size || 0))}`,
                file.folder ? `📁 ${file.folder}` : '',
                '',
                '删除会移除数据库记录并尝试删除实际文件。请确认无误后点击按钮。',
            ].filter(Boolean).join('\n'),
            buttons: buildDeleteConfirmKeyboard(confirmId),
        });
    } catch (error) {
        console.error('🤖 删除文件失败:', error);
        await message.reply({ message: `${MSG.ERR_DELETE}: ${(error as Error).message}` });
    }
}

export async function handleDeleteConfirmCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }
    const match = data.match(/^del_(confirm|cancel)_(.+)$/);
    if (!match) return;
    const [, action, confirmId] = match;
    const pending = pendingDeleteConfirmations.get(confirmId);
    if (!pending || Date.now() - pending.createdAt > DELETE_CONFIRM_TTL_MS) {
        pendingDeleteConfirmations.delete(confirmId);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '删除确认已过期', alert: true }));
        return;
    }
    if (action === 'cancel') {
        pendingDeleteConfirmations.delete(confirmId);
        await client.editMessage(update.peer, { message: Number(update.msgId), text: `已取消删除：${pending.name}`, buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
        return;
    }
    try {
        const scope = await getCurrentStorageScope();
        const result = await query(`SELECT * FROM files WHERE ${scope.clause} AND id = ${nextParam(scope, 1)} LIMIT 1`, [...scope.params, pending.fileId]);
        const file = result.rows[0];
        if (!file) {
            pendingDeleteConfirmations.delete(confirmId);
            await client.editMessage(update.peer, { message: Number(update.msgId), text: '❌ 文件已不存在或不在当前存储范围内。', buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '文件不存在', alert: true }));
            return;
        }
        try { await removePhysicalFile(file); } catch (err) { console.warn('🤖 文件物理删除失败或文件已不存在:', err); }
        await query('DELETE FROM files WHERE id = $1', [file.id]);
        pendingDeleteConfirmations.delete(confirmId);
        await client.editMessage(update.peer, { message: Number(update.msgId), text: buildDeleteSuccess(file.name, file.id), buttons: new Api.ReplyInlineMarkup({ rows: [] }) });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已删除' }));
    } catch (error) {
        console.error('🤖 确认删除文件失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `删除失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleTasks(message: Api.Message): Promise<void> {
    try {
        const status = getTaskStatus();
        const activeCount = status.active.length;
        const pendingCount = status.pending.length;
        const historyCount = status.history.length;
        const senderId = message.senderId?.toJSNumber();
        const jobs = senderId ? await listTelegramBackgroundJobs(senderId, 5) : [];

        if (activeCount === 0 && pendingCount === 0 && historyCount === 0 && jobs.length === 0) {
            await message.reply({ message: MSG.EMPTY_TASKS });
            return;
        }

        const sections = [buildTasksReport(status.active, status.pending, status.history)];
        if (jobs.length > 0) {
            sections.push([
                '📡 **频道后台任务**',
                ...jobs.map((job: any, index: number) => [
                    `${index + 1}. ${job.kind} · ${job.status}`,
                    `   来源：${job.source}`,
                    `   进度：${job.enqueued_count || 0}/${job.total_count || 0}　跳过：${job.skipped_count || 0}`,
                    job.error ? `   ⚠️ ${job.error}` : '',
                    `   ID: ${String(job.id).slice(0, 8)}`,
                ].filter(Boolean).join('\n')),
            ].join('\n'));
        }
        await message.reply({ message: sections.filter(Boolean).join('\n\n') });

    } catch (error) {
        console.error('🤖 获取任务列表失败:', error);
        await message.reply({ message: MSG.ERR_TASKS });
    }
}

export async function handleStopTasks(message: Api.Message): Promise<void> {
    try {
        const result = forceStopDownloadTasks('用户通过 /stop_tasks 强制停止');
        if (result.total === 0) {
            await message.reply({ message: '📮 当前没有可停止的下载任务' });
            return;
        }

        await message.reply({
            message: `🛑 已发送停止指令\n\n处理中: ${result.active}\n等待中: ${result.pending}\n\n正在下载的任务会在当前分片结束后停止，并自动清理临时文件。`
        });
    } catch (error) {
        console.error('🤖 强制停止任务失败:', error);
        await message.reply({ message: `❌ 强制停止任务失败: ${(error as Error).message}` });
    }
}

export async function handlePauseTasks(message: Api.Message, args: string[] = []): Promise<void> {
    const taskId = args[0];
    const result = pauseDownloadTasks(taskId);
    await message.reply({ message: `⏸️ 已暂停全局下载队列${taskId ? `\n任务卡: ${taskId}` : ''}\n\n进行中: ${result.active}\n等待中: ${result.pending}\n\n当前正在下载的文件会继续完成，新的等待任务暂不开始。` });
}

export async function handleResumeTasks(message: Api.Message, args: string[] = []): Promise<void> {
    const taskId = args[0];
    const result = resumeDownloadTasks(taskId);
    await message.reply({ message: `▶️ 已继续全局下载队列${taskId ? `\n任务卡: ${taskId}` : ''}\n\n进行中: ${result.active}\n等待中: ${result.pending}` });
}

export async function handleCancelTask(message: Api.Message, args: string[]): Promise<void> {
    const selector = args.join(' ').trim() || 'all';
    const result = cancelDownloadTask(selector);
    await message.reply({ message: result.total > 0 ? `🛑 已取消匹配任务\n\n匹配: ${selector}\n处理中: ${result.active}\n等待中: ${result.pending}` : `📮 没有找到匹配的任务，未清空全局队列：${selector}` });
}

export async function handleRetryFailedTasks(message: Api.Message, args: string[]): Promise<void> {
    const taskId = args.find(arg => /^t[a-z0-9]+/i.test(arg));
    const numericArg = args.find(arg => /^\d+$/.test(arg));
    const limit = Math.max(1, Math.min(50, parseInt(numericArg || '10', 10) || 10));
    const result = await retryFailedDownloadTasks(limit, taskId);
    await message.reply({ message: result.retried > 0 ? `🔄 已重新加入 ${result.retried} 个失败任务${taskId ? `\n任务: ${taskId}` : ''}` : '📮 最近没有可重试的失败任务' });
}

export async function handleDownloadWorkers(message: Api.Message): Promise<void> {
    try {
        const current = await getCurrentDownloadWorkers();
        await message.reply({
            message: buildDownloadWorkersText(current),
            buttons: buildDownloadWorkersKeyboard(current),
        });
    } catch (error) {
        console.error('🤖 获取分片并发设置失败:', error);
        await message.reply({ message: `❌ 获取分片并发设置失败: ${(error as Error).message}` });
    }
}

export async function handleFileConcurrency(message: Api.Message): Promise<void> {
    try {
        const current = await getCurrentFileConcurrency();
        setFileDownloadConcurrency(current);
        await message.reply({
            message: buildFileConcurrencyText(current),
            buttons: buildFileConcurrencyKeyboard(current),
        });
    } catch (error) {
        console.error('🤖 获取文件级并发设置失败:', error);
        await message.reply({ message: `❌ 获取文件级并发设置失败: ${(error as Error).message}` });
    }
}

export async function handlePathRules(message: Api.Message): Promise<void> {
    const pathCenterState = await getPathCenterState();
    await message.reply({
        message: buildPathSettingsText(pathCenterState, message.chatId?.toString() || 'unknown'),
        buttons: buildPathSettingsKeyboard(pathCenterState),
    });
}

export async function handlePathOnce(message: Api.Message, args: string[]): Promise<void> {
    const folder = args.join(' ').trim();
    if (!folder) {
        await message.reply({ message: '❌ 用法：/p <目录>\n例如：/p PIXIV/每日Top50' });
        return;
    }
    try {
        const normalized = await setNextTelegramPathPersistent(message.chatId?.toString() || 'unknown', folder);
        await message.reply({ message: `📌 已设置下一次下载目录：\`${normalized}\`\n${buildPathPreviewLine(normalized)}\n\n此设置会在下一次成功进入下载流程时自动失效。` });
    } catch (error) {
        await message.reply({ message: `❌ 路径无效：${(error as Error).message}` });
    }
}

export async function handlePathSession(message: Api.Message, args: string[]): Promise<void> {
    const folder = args.join(' ').trim();
    if (!folder) {
        await message.reply({ message: '❌ 用法：/ps <目录>\n例如：/ps 相册/2026-07' });
        return;
    }
    try {
        const normalized = await setSessionTelegramPathPersistent(message.chatId?.toString() || 'unknown', folder);
        await message.reply({ message: `📍 已设置本会话下载目录：\`${normalized}\`\n${buildPathPreviewLine(normalized)}\n\n后续此聊天中的下载会优先保存到该目录，发送 /pc 可清除。` });
    } catch (error) {
        await message.reply({ message: `❌ 路径无效：${(error as Error).message}` });
    }
}

export async function handlePathClear(message: Api.Message): Promise<void> {
    clearTelegramPathState(message.chatId?.toString() || 'unknown');
    await message.reply({ message: '🧹 已清除下一次/本会话自定义下载目录，后续恢复使用默认自动分类目录。' });
}

export async function handlePathRulesCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const pathCenterState = await getPathCenterState();
        const chatKey = getCallbackChatKey(update);
        if (data === 'pr_clear_custom') {
            clearTelegramPathState(chatKey);
        } else if (data === 'pr_recent') {
            const recent = await getRecentTelegramPathsPersistent(chatKey);
            await client.sendMessage(update.peer, {
                message: recent.length > 0
                    ? ['🕘 **最近使用目录**', '', ...recent.map((item, index) => `${index + 1}. ${item}`), '', '要使用其中一个目录，请直接复制发送，或发送 `/p <目录>` / `/ps <目录>`。'].join('\n')
                    : '🕘 暂无最近使用目录。设置过 `/p`、`/ps`、订阅专属目录或下载任务专属目录后会自动记录。'
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已发送最近目录' }));
            return;
        } else if (data === 'pr_help_once' || data === 'pr_help_session') {
            const mode = data === 'pr_help_once' ? 'once' : 'session';
            setPendingTelegramPathInput(chatKey, userId, mode);
            await client.sendMessage(update.peer, { message: await buildPendingPathPromptPersistent(mode, chatKey) });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '请直接发送目录，或发送“取消”退出' }));
            return;
        }

        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: buildPathSettingsText(pathCenterState, chatKey),
            buttons: buildPathSettingsKeyboard(pathCenterState),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '保存位置已更新' }));
    } catch (error) {
        console.error('🤖 设置保存位置失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `设置失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleDuplicateMode(message: Api.Message): Promise<void> {
    const mode = await getDuplicateMode();
    await message.reply({
        message: buildDuplicateModeText(mode),
        buttons: buildDuplicateModeKeyboard(mode),
    });
}

export async function handleDuplicateModeCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const match = data.match(/^dm_set_(skip|copy)$/);
        if (!match) return;
        const mode = match[1] as DuplicateMode;
        await setSetting('duplicate_file_mode', mode);
        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: buildDuplicateModeText(mode),
            buttons: buildDuplicateModeKeyboard(mode),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已设置为${mode === 'skip' ? '跳过重复' : '生成副本'}` }));
    } catch (error) {
        console.error('🤖 设置重复文件处理失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `设置失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleCleanupSettings(message: Api.Message): Promise<void> {
    const enabled = await getCleanupEnabledSetting();
    await message.reply({
        message: buildCleanupSettingsText(enabled),
        buttons: buildCleanupSettingsKeyboard(enabled),
    });
}

export async function handleCleanupSettingsCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: MSG.AUTH_REQUIRED, alert: true }));
        return;
    }

    try {
        const enabled = data === 'cs_set_on';
        await setSetting('auto_cleanup_orphans', String(enabled));
        process.env.AUTO_CLEANUP_ORPHANS = String(enabled);
        if (enabled) {
            startPeriodicCleanup();
        } else {
            stopPeriodicCleanup();
        }
        await client.editMessage(update.peer, {
            message: Number(update.msgId),
            text: buildCleanupSettingsText(enabled),
            buttons: buildCleanupSettingsKeyboard(enabled),
        });
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: enabled ? '已开启自动清理' : '已关闭自动清理' }));
    } catch (error) {
        console.error('🤖 设置自动清理失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `设置失败: ${(error as Error).message}`, alert: true }));
    }
}

export async function handleDownloadWorkersCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: MSG.AUTH_REQUIRED,
            alert: true,
        }));
        return;
    }

    try {
        if (data === 'dw_cancel') {
            const current = await getCurrentDownloadWorkers();
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: buildDownloadWorkersText(current),
                buttons: buildDownloadWorkersKeyboard(current),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
            return;
        }

        const setMatch = data.match(/^dw_set_(4|8|12|16)$/);
        if (setMatch) {
            const workers = Number(setMatch[1]);
            if (workers >= 12) {
                await client.editMessage(update.peer, {
                    message: Number(update.msgId),
                    text: [
                        `⚠️ **确认使用 ${workers} workers？**`,
                        '',
                        '这是激进分片并发模式，可能出现：',
                        '- Telegram 风控或限流',
                        '- 下载断流 / 重试增多',
                        '- user session 账号风险，极端情况下可能影响账号',
                        '',
                        '如果只是日常下载，建议使用 4 或 8。',
                    ].join('\n'),
                    buttons: buildDownloadWorkersKeyboard(workers, workers),
                });
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '需要二次确认' }));
                return;
            }

            await setSetting('telegram_download_workers', String(workers));
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildDownloadWorkersText(workers)}\n\n✅ 已切换为 ${workers} workers，后续新下载任务立即生效。`,
                buttons: buildDownloadWorkersKeyboard(workers),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已设置为 ${workers}` }));
            return;
        }

        const confirmMatch = data.match(/^dw_confirm_(12|16)$/);
        if (confirmMatch) {
            const workers = Number(confirmMatch[1]);
            await setSetting('telegram_download_workers', String(workers));
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildDownloadWorkersText(workers)}\n\n⚠️ 已确认并切换为 ${workers} workers。若出现断流、限速、风控提示，请立即降回 4 或 8。`,
                buttons: buildDownloadWorkersKeyboard(workers),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已确认 ${workers} workers`, alert: true }));
        }
    } catch (error) {
        console.error('🤖 设置并发下载 worker 失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: `设置失败: ${(error as Error).message}`,
            alert: true,
        }));
    }
}

export async function handleFileConcurrencyCallback(client: TelegramClient, update: Api.UpdateBotCallbackQuery, data: string): Promise<void> {
    const userId = update.userId.toJSNumber();
    if (!(await isAuthenticatedAsync(userId))) {
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: MSG.AUTH_REQUIRED,
            alert: true,
        }));
        return;
    }

    try {
        if (data === 'fc_cancel') {
            const current = await getCurrentFileConcurrency();
            setFileDownloadConcurrency(current);
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: buildFileConcurrencyText(current),
                buttons: buildFileConcurrencyKeyboard(current),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已取消' }));
            return;
        }

        const setMatch = data.match(/^fc_set_(1|2|3|4)$/);
        if (setMatch) {
            const concurrency = Number(setMatch[1]);
            if (concurrency === 4) {
                await client.editMessage(update.peer, {
                    message: Number(update.msgId),
                    text: [
                        '⚠️ **确认同时下载 4 个文件？**',
                        '',
                        '这是文件级激进并发模式，可能出现：',
                        '- Telegram 风控或限流',
                        '- 云盘上传限速 / 失败重试增多',
                        '- 服务器磁盘和网络压力明显增加',
                        '',
                        '如果只是日常下载，建议使用 2 或 3。',
                    ].join('\n'),
                    buttons: buildFileConcurrencyKeyboard(concurrency, concurrency),
                });
                await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '需要二次确认' }));
                return;
            }

            await setSetting('telegram_file_download_concurrency', String(concurrency));
            const normalized = setFileDownloadConcurrency(concurrency);
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildFileConcurrencyText(normalized)}\n\n✅ 已切换为同时下载 ${normalized} 个文件。`,
                buttons: buildFileConcurrencyKeyboard(normalized),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: `已设置为 ${normalized}` }));
            return;
        }

        const confirmMatch = data.match(/^fc_confirm_4$/);
        if (confirmMatch) {
            await setSetting('telegram_file_download_concurrency', '4');
            const normalized = setFileDownloadConcurrency(4);
            await client.editMessage(update.peer, {
                message: Number(update.msgId),
                text: `${buildFileConcurrencyText(normalized)}\n\n⚠️ 已确认并切换为同时下载 4 个文件。若出现限流、断流或上传失败，请立即降回 2 或 3。`,
                buttons: buildFileConcurrencyKeyboard(normalized),
            });
            await client.invoke(new Api.messages.SetBotCallbackAnswer({ queryId: update.queryId, message: '已确认 4 个文件并发', alert: true }));
        }
    } catch (error) {
        console.error('🤖 设置文件级并发失败:', error);
        await client.invoke(new Api.messages.SetBotCallbackAnswer({
            queryId: update.queryId,
            message: `设置失败: ${(error as Error).message}`,
            alert: true,
        }));
    }
}
