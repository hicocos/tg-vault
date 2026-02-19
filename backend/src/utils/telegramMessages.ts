/**
 * telegramMessages.ts - 统一消息模板模块
 * 
 * 所有 Telegram Bot 文本输出的单一来源。
 * 职责：消息格式化、存储提供商显示名、进度条渲染等。
 */

import { formatBytes, getTypeEmoji } from './telegramUtils.js';
import { cleanupOrphanFiles } from '../services/orphanCleanup.js';

// ─── 存储提供商显示名称 ───────────────────────────────────────

const PROVIDER_DISPLAY_MAP: Record<string, string> = {
    onedrive: '☁️ OneDrive',
    aliyun_oss: '☁️ 阿里云 OSS',
    s3: '📦 S3 存储',
    webdav: '🌐 WebDAV',
    google_drive: '☁️ Google Drive',
    local: '💾 本地存储',
};

export function getProviderDisplayName(providerName: string): string {
    return PROVIDER_DISPLAY_MAP[providerName] || `📦 ${providerName}`;
}

// ─── 进度条渲染 ─────────────────────────────────────────────

export function generateProgressBar(completed: number, total: number, barLength: number = 20): string {
    if (total <= 0) return '[' + '='.repeat(barLength - 1) + '-' + '] 0%';
    const ratio = Math.min(completed / total, 1);
    const percentage = Math.round(ratio * 100);
    const filledLength = Math.round(ratio * (barLength - 1));
    const emptyLength = (barLength - 1) - filledLength;
    return '[' + '='.repeat(filledLength) + '>' + '-'.repeat(emptyLength) + '] ' + percentage + '%';
}

export function generateProgressBarWithSpeed(
    completed: number,
    total: number,
    startTime?: number,
    barLength: number = 20
): string {
    const bar = generateProgressBar(completed, total, barLength);
    if (!startTime || completed <= 0) return bar;

    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed < 1) return bar;

    const speed = completed / elapsed;
    return `${bar} ⚡ ${formatBytes(speed)}/s`;
}

// ─── 分隔线 ─────────────────────────────────────────────────

const LINE = '━'.repeat(22);
const THIN_LINE = '─'.repeat(22);

// ─── 固定文本消息 ────────────────────────────────────────────

export const MSG = {
    // 认证相关
    AUTH_REQUIRED: '🔐 请先发送 /start 验证密码',
    AUTH_REQUIRED_UPLOAD: '🔐 请先发送 /start 验证密码后再上传文件',
    AUTH_INPUT_PROMPT: '🔐 请使用下方键盘输入密码：',
    AUTH_CANCELLED: '🚫 已取消密码输入\n\n发送 /start 重新开始',
    AUTH_WRONG: '❌ 密码错误，请重新输入：',
    AUTH_SUCCESS: '✅ 密码验证成功!',
    AUTH_2FA_PROMPT: '🔐 密码验证通过！\n\n请输入您的 **2FA 6 位验证码** 以完成登录：',
    AUTH_2FA_TOAST: '请输入 2FA 验证码',
    AUTH_2FA_WRONG: '❌ 验证码错误，请重新输入 6 位数字：',
    AUTH_2FA_ACTIVATED: '✅ **2FA 已成功激活！**\n\n🛡️ 您的账户现在受到双重保护。',
    AUTH_2FA_LOGIN_OK: '✅ **2FA 验证成功**\n\n欢迎回来！',
    AUTH_2FA_QR_FAIL: '❌ 生成二维码失败，请检查控制台日志。',

    // 未知消息
    UNKNOWN_TEXT: '❓ 未识别的指令\n\n发送 /start 开始使用，或 /help 查看帮助',
    UNSUPPORTED_MEDIA: '⚠️ 暂不支持此类媒体格式',

    // 空状态
    EMPTY_FILES: '📮 暂无上传记录',
    EMPTY_TASKS: '📮 当前没有进行中的任务',

    // 错误
    ERR_STORAGE: '❌ 获取存储统计失败',
    ERR_FILE_LIST: '❌ 获取文件列表失败',
    ERR_DELETE: '❌ 删除文件失败',
    ERR_TASKS: '❌ 获取任务列表失败',

    // 下载/上传
    DOWNLOAD_FAIL: '下载失败',
    SAVING_FILE: '💾 正在保存到存储...',
    RETRYING: '🔄 上传失败，正在重试...',
} as const;

// ─── 消息构建函数 ────────────────────────────────────────────

/** 已认证用户的欢迎消息 */
export function buildWelcomeBack(): string {
    return [
        `👋 **欢迎回来！**`,
        ``,
        `您已通过验证，可以直接使用：`,
        ``,
        `📤  发送/转发文件即可上传 (最大 2GB)`,
        `📊  /storage — 存储空间概览`,
        `📋  /list — 最近上传记录`,
        `🔧  /tasks — 实时任务队列`,
        `❓  /help — 完整帮助`,
    ].join('\n');
}

/** 首次认证成功的欢迎消息 */
export function buildAuthSuccess(): string {
    return [
        `✅ **密码验证成功！**`,
        ``,
        `现在您可以：`,
        `📤  发送/转发任意文件上传 (最大 2GB)`,
        `📊  /storage — 查看存储空间`,
    ].join('\n');
}

/** /start 未认证的欢迎 + 密码键盘提示 */
export function buildStartPrompt(): string {
    return `👋 **欢迎使用 FoomClous Bot！**\n\n🔐 请使用下方键盘输入密码：`;
}

/** /help 帮助文本 */
export function buildHelp(): string {
    return [
        `📖 **FoomClous Bot 帮助**`,
        LINE,
        ``,
        `**📤 文件上传**`,
        `  直接发送或转发文件即可自动上传`,
        `  支持所有类型，最大 2 GB`,
        `  多文件同时发送会自动归为一组`,
        ``,
        `**🛠 可用命令**`,
        `  /start — 身份认证 / 开始使用`,
        `  /storage — 服务器 & 存储统计`,
        `  /list [n] — 最近上传 (默认 10 条)`,
        `  /delete <ID> — 删除指定文件`,
        `  /tasks — 实时传输任务队列`,
        `  /setup\\_2fa — 配置双重验证 (TOTP)`,
        `  /help — 显示此帮助`,
        ``,
        LINE,
        `💡 **提示**：转发文件给 Bot 即可开始上传`,
    ].join('\n');
}

/** 2FA 设置 QR 码的 caption */
export function build2FASetupCaption(): string {
    return [
        `🔐 **双重验证 (2FA) 设置**`,
        ``,
        `1️⃣ 使用 Google Authenticator 或其他 2FA App 扫描此二维码`,
        `2️⃣ 扫描后直接发送 App 生成的 **6 位验证码**`,
        ``,
        `⏳ 激活成功后二维码将自动删除`,
    ].join('\n');
}

// ─── 存储统计报告 ────────────────────────────────────────────

interface StorageReportData {
    diskTotal: number;
    diskFree: number;
    diskUsedPercent: number;
    fileCount: number;
    totalFileSize: number;
    queueActive: number;
    queuePending: number;
}

export function buildStorageReport(data: StorageReportData): string {
    // 磁盘用量可视化条
    const usageBar = generateProgressBar(data.diskUsedPercent, 100, 12);

    return [
        `📊 **存储空间统计**`,
        LINE,
        ``,
        `**💿 服务器磁盘**`,
        `  总容量　${formatBytes(data.diskTotal)}`,
        `  已使用　${formatBytes(data.diskTotal - data.diskFree)} (${data.diskUsedPercent}%)`,
        `  可　用　${formatBytes(data.diskFree)}`,
        `  ${usageBar}`,
        ``,
        `**📁 FoomClous 文件**`,
        `  文件数　${data.fileCount} 个`,
        `  占　用　${formatBytes(data.totalFileSize)}`,
        ``,
        `**📡 下载队列**`,
        `  🔄 处理中 ${data.queueActive}　⏳ 等待中 ${data.queuePending}`,
    ].join('\n');
}

// ─── 文件列表 ────────────────────────────────────────────────

interface FileListItem {
    id: string;
    name: string;
    type: string;
    size: string | number;
    folder?: string;
    created_at: string;
}

export function buildFileList(files: FileListItem[], total: number): string {
    const lines: string[] = [
        `📋 **最近上传的文件** (${total} 条)`,
        LINE,
    ];

    files.forEach((file, index) => {
        const typeEmoji = getTypeEmoji(
            file.type === 'image' ? 'image/' :
                file.type === 'video' ? 'video/' :
                    file.type === 'audio' ? 'audio/' : 'other'
        );
        const size = formatBytes(typeof file.size === 'string' ? parseInt(file.size) : file.size);
        const date = new Date(file.created_at).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });

        let displayName = file.name;
        if (displayName.length > 25) {
            displayName = displayName.substring(0, 22) + '...';
        }

        lines.push(`${index + 1}. ${typeEmoji} **${displayName}**`);
        lines.push(`    ${size} · ${date}${file.folder ? ` · 📁 ${file.folder}` : ''}`);
        lines.push(`    ID: \`${file.id.substring(0, 8)}\``);
    });

    lines.push('');
    lines.push(`💡 删除文件: /delete <ID前8位>`);

    return lines.join('\n');
}

// ─── 任务队列状态 ────────────────────────────────────────────

interface TaskItem {
    fileName: string;
    status?: string;
    error?: string;
    totalSize?: number;
    downloadedSize?: number;
}

export function buildTasksReport(
    active: TaskItem[],
    pending: TaskItem[],
    history: TaskItem[]
): string {
    const lines: string[] = [
        `📋 **任务队列状态**`,
        `🔄 ${active.length} 进行中　⏳ ${pending.length} 等待中`,
        LINE,
    ];

    if (active.length > 0) {
        lines.push('');
        lines.push(`**🔄 正在处理**`);
        active.forEach(task => {
            lines.push(`  ▸ ${task.fileName}`);
            if (task.totalSize && task.downloadedSize) {
                const bar = generateProgressBar(task.downloadedSize, task.totalSize, 10);
                lines.push(`    ${bar}  (${formatBytes(task.downloadedSize)}/${formatBytes(task.totalSize)})`);
            } else {
                lines.push(`    ⏳ 下载中...`);
            }
        });
    }

    if (pending.length > 0) {
        lines.push('');
        lines.push(`**⏳ 等待队列** (前 5 个)`);
        pending.slice(0, 5).forEach((task, i) => {
            lines.push(`  ${i + 1}. ${task.fileName}`);
        });
        if (pending.length > 5) {
            lines.push(`  ... 还有 ${pending.length - 5} 个任务`);
        }
    }

    if (history.length > 0) {
        lines.push('');
        lines.push(`**🕒 最近完成** (前 5 个)`);
        history.slice(0, 5).forEach(task => {
            const icon = task.status === 'success' ? '✅' : '❌';
            lines.push(`  ${icon} ${task.fileName}`);
            if (task.status === 'failed' && task.error) {
                lines.push(`      原因: ${task.error}`);
            }
        });
    }

    return lines.join('\n');
}

// ─── 上传相关 ────────────────────────────────────────────────

/** 单文件上传成功 */
export function buildUploadSuccess(
    fileName: string,
    size: number,
    fileType: string,
    providerName: string
): string {
    const typeEmoji = getTypeEmoji(
        fileType === 'image' ? 'image/' :
            fileType === 'video' ? 'video/' :
                fileType === 'audio' ? 'audio/' : 'other'
    );
    const bar = generateProgressBar(1, 1);
    return [
        `✅ **上传成功！**`,
        `${bar}`,
        ``,
        `${typeEmoji} ${fileName}`,
        `📦 ${formatBytes(size)}`,
        `📍 ${getProviderDisplayName(providerName)}`,
    ].join('\n');
}

/** 单文件上传失败 */
export function buildUploadFail(fileName: string, error: string): string {
    return [
        `❌ **上传失败**`,
        ``,
        `📄 ${fileName}`,
        `原因: ${error}`,
    ].join('\n');
}

/** 单文件下载进度 */
export function buildDownloadProgress(
    fileName: string,
    downloaded: number,
    total: number,
    typeEmoji: string,
    startTime?: number
): string {
    const bar = startTime
        ? generateProgressBarWithSpeed(downloaded, total, startTime)
        : generateProgressBar(downloaded, total);
    return [
        `⏳ **正在下载**`,
        `${bar}`,
        ``,
        `${typeEmoji} ${fileName}`,
        `${formatBytes(downloaded)} / ${formatBytes(total)}`,
    ].join('\n');
}

/** 文件保存中 */
export function buildSavingFile(fileName: string, typeEmoji: string): string {
    const bar = generateProgressBar(1, 1);
    return [
        `💾 **正在保存...**`,
        `${bar}`,
        ``,
        `${typeEmoji} ${fileName}`,
    ].join('\n');
}

/** 排队等待中 */
export function buildQueuedMessage(fileName: string, pendingCount: number): string {
    return [
        `⏳ **已加入下载队列**`,
        ``,
        `📄 ${fileName}`,
        `📊 当前排队: ${pendingCount} 个任务`,
        `💡 Bot 将按顺序处理，请耐心等待`,
    ].join('\n');
}

/** 重试中 */
export function buildRetryMessage(fileName: string, typeEmoji: string): string {
    const bar = generateProgressBar(0, 1);
    return [
        `🔄 **上传失败，正在重试...**`,
        `${bar}`,
        ``,
        `${typeEmoji} ${fileName}`,
    ].join('\n');
}

/** 删除成功 */
export function buildDeleteSuccess(fileName: string, fileId: string): string {
    return [
        `✅ **文件已删除**`,
        ``,
        `📄 ${fileName}`,
        `🗑️ ID: ${fileId}`,
    ].join('\n');
}

// ─── 多文件上传 ──────────────────────────────────────────────

/** 静默模式通知 */
export function buildSilentModeNotice(taskCount: number): string {
    return [
        `🤐 **已切换到静默模式**`,
        ``,
        `当前任务数: ${taskCount} 个`,
        `Bot 将在后台继续处理所有文件，请耐心等待。`,
        ``,
        `💡 发送 /tasks 查看实时任务状态`,
    ].join('\n');
}

/** 静默模式完成 (单文件) */
export function buildSilentComplete(typeEmoji: string, providerName: string): string {
    return `✅ **上传完成！**\n🏷️ 类型: ${typeEmoji}\n📍 ${getProviderDisplayName(providerName)}`;
}

/** 静默模式完成 (多文件) */
export function buildSilentBatchComplete(types: string, providerName: string): string {
    return `✅ **多文件上传完成！**\n🏷️ 类型: ${types}\n📍 ${getProviderDisplayName(providerName)}`;
}

export function buildSilentAllTasksComplete(failedCount: number): string {
    if (failedCount > 0) {
        return `⚠️ **后台任务部分完成**\n\n❌ 失败文件: ${failedCount} 个`;
    }
    return `✅ **后台任务全部完成**`;
}

// ─── 合并状态（单文件 + 批量） ──────────────────────────────

export interface ConsolidatedUploadFile {
    id?: string;
    fileName: string;
    typeEmoji: string;
    phase: 'queued' | 'downloading' | 'saving' | 'success' | 'failed' | 'retrying';
    downloaded?: number;
    total?: number;
    size?: number;
    error?: string;
    providerName?: string;
    fileType?: string;
}

export interface ConsolidatedBatchEntry {
    id: string;
    folderName: string;
    totalFiles: number;
    completed: number;
    successful: number;
    failed: number;
    providerName?: string;
    isSilent?: boolean;
    queuePending?: number;
}

/**
 * 合并显示所有活跃任务（单文件 + 批量）到一条消息
 */
export async function buildConsolidatedStatus(
    singleFiles: ConsolidatedUploadFile[],
    batches: ConsolidatedBatchEntry[]
): Promise<string> {
    const totalSingle = singleFiles.length;
    const totalBatches = batches.length;
    const totalTasks = totalSingle + totalBatches;

    // 计算总体状态 for icon
    const singleCompleted = singleFiles.filter(f => f.phase === 'success' || f.phase === 'failed').length;
    const batchCompleted = batches.filter(b => b.completed === b.totalFiles).length;
    const allCompleted = (singleCompleted + batchCompleted) === totalTasks;

    let statusIcon = '📦';
    let statusText = `正在处理 ${totalTasks} 个任务...`;

    if (allCompleted && totalTasks > 0) {
        // 计算完成统计
        const successfulSingles = singleFiles.filter(f => f.phase === 'success').length;
        const failedSingles = singleFiles.filter(f => f.phase === 'failed').length;
        const successfulBatches = batches.reduce((sum, b) => sum + (b.successful || 0), 0);
        const failedBatches = batches.reduce((sum, b) => sum + (b.failed || 0), 0);
        
        const totalSuccessful = successfulSingles + successfulBatches;
        const totalFailed = failedSingles + failedBatches;
        const totalSize = [...singleFiles.filter(f => f.phase === 'success'), ...batches.flatMap(b => [])]
            .reduce((sum, f) => sum + (f.size || 0), 0);

        statusIcon = totalFailed === 0 ? '🎉' : '⚠️';
        statusText = totalFailed === 0 ? '任务全部完成！' : `任务完成 (${totalFailed} 个失败)`;
    }

    const lines: string[] = [
        `${statusIcon} **${statusText}**`,
        '',
    ];

    // 添加完成统计摘要
    if (allCompleted && totalTasks > 0) {
        const successfulSingles = singleFiles.filter(f => f.phase === 'success').length;
        const failedSingles = singleFiles.filter(f => f.phase === 'failed').length;
        const successfulBatches = batches.reduce((sum, b) => sum + (b.successful || 0), 0);
        const failedBatches = batches.reduce((sum, b) => sum + (b.failed || 0), 0);
        
        const totalSuccessful = successfulSingles + successfulBatches;
        const totalFailed = failedSingles + failedBatches;
        const totalSize = [...singleFiles.filter(f => f.phase === 'success'), ...batches.flatMap(b => [])]
            .reduce((sum, f) => sum + (f.size || 0), 0);

        // 如果有失败文件，执行清理
        let cleanupStats: { deletedCount: number; freedSpace: string } | null = null;
        if (totalFailed > 0) {
            try {
                const stats = await cleanupOrphanFiles();
                if (stats.deletedCount > 0) {
                    cleanupStats = {
                        deletedCount: stats.deletedCount,
                        freedSpace: stats.freedSpace
                    };
                }
            } catch (error) {
                console.error('🧹 自动清理失败:', error);
            }
        }

        lines.push('📊 **完成摘要**');
        lines.push(LINE);
        lines.push(`✅ 成功: ${totalSuccessful} 个文件`);
        if (totalFailed > 0) {
            lines.push(`❌ 失败: ${totalFailed} 个文件`);
        }
        if (totalSize > 0) {
            lines.push(`📦 总大小: ${formatBytes(totalSize)}`);
        }
        
        // 显示存储提供商
        const providers = new Set<string>();
        singleFiles.filter(f => f.phase === 'success' && f.providerName).forEach(f => providers.add(f.providerName!));
        batches.filter(b => b.providerName).forEach(b => providers.add(b.providerName!));
        if (providers.size > 0) {
            lines.push(`📍 存储: ${Array.from(providers).map(p => getProviderDisplayName(p)).join(', ')}`);
        }
        
        lines.push('');
        lines.push(`⏰ 完成时间: ${new Date().toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit', 
            hour: '2-digit',
            minute: '2-digit'
        })}`);
        
        // 添加清理通知（如果有失败文件）
        if (totalFailed > 0) {
            lines.push('');
            lines.push('🧹 **自动清理完成**');
            lines.push('  已清理服务器缓存垃圾文件');
            if (cleanupStats && cleanupStats.deletedCount > 0) {
                lines.push(`  🗑️ 删除 ${cleanupStats.deletedCount} 个孤儿文件`);
                lines.push(`  💾 释放空间 ${cleanupStats.freedSpace}`);
            } else {
                lines.push('  ✅ 没有发现需要清理的垃圾文件');
            }
        }
        
        lines.push('');
        
        // 添加友好的结束消息
        if (totalFailed === 0) {
            lines.push('🎊 所有文件已安全上传到云端！');
            lines.push('💡 您可以随时使用 /list 查看上传记录');
        } else {
            lines.push('💡 部分文件上传失败，已自动清理服务器缓存');
            lines.push('🔄 您可以重新发送失败的文件');
        }
        lines.push('');
    }

    const activeSingles = singleFiles.filter(f => f.phase === 'downloading' || f.phase === 'saving' || f.phase === 'retrying');
    const queuedSingles = singleFiles.filter(f => f.phase === 'queued');
    const doneSingles = singleFiles.filter(f => f.phase === 'success' || f.phase === 'failed');

    const activeBatches = batches.filter(b => b.completed < b.totalFiles);
    const doneBatches = batches.filter(b => b.completed === b.totalFiles);

    // 1. 渲染正在进行的单文件任务
    if (activeSingles.length > 0) {
        activeSingles.forEach(file => {
            let icon: string;
            let detail: string;

            switch (file.phase) {
                case 'downloading':
                    icon = '⬇️';
                    if (file.downloaded !== undefined && file.total) {
                        const pct = Math.round((file.downloaded / file.total) * 100);
                        const progressBar = generateProgressBar(file.downloaded, file.total);
                        detail = `${progressBar} ${pct}%`;
                    } else {
                        detail = '下载中...';
                    }
                    break;
                case 'saving':
                    icon = '💾'; detail = '保存...'; break;
                case 'success':
                    icon = '✅';
                    const parts: string[] = [];
                    if (file.size) parts.push(formatBytes(file.size));
                    detail = parts.join(' · ') || '完成';
                    break;
                case 'failed':
                    icon = '❌'; detail = file.error || '失败'; break;
                case 'retrying':
                    icon = '🔄'; detail = '重试...'; break;
                case 'queued':
                default:
                    icon = '🕒'; detail = '排队'; break;
            }

            lines.push(`${icon} ${file.typeEmoji} ${file.fileName}`);
            lines.push(`    └ ${detail}`);
        });
    }

    // 2. 渲染批量任务 (文件夹)
    if ((activeBatches.length > 0 || doneBatches.length > 0) && !allCompleted) {
        if (activeSingles.length > 0) lines.push('');

        [...activeBatches, ...doneBatches].forEach(batch => {
            const isDone = batch.completed === batch.totalFiles;
            const icon = isDone ? (batch.failed === 0 ? '✅' : '⚠️') : '📂';
            lines.push(`${icon} 📁 ${batch.folderName}`);
            if (!isDone) {
                const progress = generateProgressBar(batch.completed, batch.totalFiles);
                lines.push(`    ${progress} (${batch.completed}/${batch.totalFiles})`);
            } else {
                lines.push(`    ✅ ${batch.successful}  ❌ ${batch.failed}`);
            }

            if (batch.queuePending && batch.queuePending > 0 && !isDone) {
                lines.push(`    ⏳ 队列: ${batch.queuePending}`);
            }
            if (batch.providerName && isDone) {
                lines.push(`    📍 ${getProviderDisplayName(batch.providerName)}`);
            }
        });
    }

    // 3. 渲染排队中的单文件任务（必须在正在进行任务下面）
    if (queuedSingles.length > 0) {
        if (activeSingles.length > 0 || totalBatches > 0) lines.push('');
        queuedSingles.forEach(file => {
            lines.push(`🕒 ${file.typeEmoji} ${file.fileName}`);
            lines.push(`    └ 排队`);
        });
    }

    // 4. 渲染已完成的单文件任务 (仅在部分失败时显示详情)
    if (doneSingles.length > 0 && !allCompleted) {
        if (activeSingles.length > 0 || totalBatches > 0 || queuedSingles.length > 0) lines.push('');
        doneSingles.forEach(file => {
            let icon: string;
            let detail: string;

            switch (file.phase) {
                case 'success':
                    icon = '✅';
                    const parts: string[] = [];
                    if (file.size) parts.push(formatBytes(file.size));
                    detail = parts.join(' · ') || '完成';
                    break;
                case 'failed':
                default:
                    icon = '❌';
                    detail = file.error || '失败';
                    break;
            }

            lines.push(`${icon} ${file.typeEmoji} ${file.fileName}`);
            lines.push(`    └ ${detail}`);
        });
    }

    return lines.join('\n');
}

/** 系统启动清理通知 */
export function buildCleanupNotice(deletedCount: number, freedSpace: string): string {
    return [
        `🧹 **系统启动清理完成**`,
        ``,
        `📊 清理统计：`,
        `  删除孤儿文件: ${deletedCount} 个`,
        `  释放空间: ${freedSpace}`,
        ``,
        `💡 这些是之前上传失败残留的文件`,
    ].join('\n');
}

// ─── 多文件批量状态消息 ──────────────────────────────────────

export interface BatchFile {
    fileName: string;
    mimeType: string;
    status: 'pending' | 'queued' | 'uploading' | 'success' | 'failed';
    size?: number;
    error?: string;
}

interface BatchStatusData {
    files: BatchFile[];
    folderName?: string;
    providerName?: string;
    queuePending: number;
    queueActive: number;
}

export function buildBatchStatus(data: BatchStatusData): string {
    const total = data.files.length;
    const completed = data.files.filter(f => f.status === 'success' || f.status === 'failed').length;
    const successful = data.files.filter(f => f.status === 'success').length;
    const failed = data.files.filter(f => f.status === 'failed').length;

    // 标题和状态
    let statusIcon: string;
    let statusText: string;

    if (completed === total) {
        if (failed === 0) { statusIcon = '✅'; statusText = '多文件上传完成！'; }
        else if (successful === 0) { statusIcon = '❌'; statusText = '多文件上传失败'; }
        else { statusIcon = '⚠️'; statusText = `多文件上传部分完成 (${failed} 个失败)`; }
    } else {
        statusIcon = '⏳'; statusText = '正在处理多文件上传...';
    }

    const lines: string[] = [
        `${statusIcon} **${statusText}**`,
    ];

    // 文件夹名
    if (data.folderName) {
        lines.push(`📁 ${data.folderName}`);
    }

    // 进度
    lines.push(`📊 进度: ${completed}/${total}  ✅ ${successful}  ❌ ${failed}`);
    lines.push(generateProgressBar(completed, total));

    // 排队提示
    if (completed < total && (data.queuePending > 0 || data.queueActive >= 2)) {
        lines.push(`⏳ 队列排队: ${data.queuePending}`);
    }

    // 类型和存储
    if (successful > 0 || completed === total) {
        const successFiles = data.files.filter(f => f.status === 'success');
        const types = Array.from(new Set(successFiles.map(f => getTypeEmoji(f.mimeType)))).join(' ') || '❓';
        const totalSize = successFiles.reduce((sum, f) => sum + (f.size || 0), 0);
        lines.push(`🏷️ ${types}  📦 ${formatBytes(totalSize)}`);
        if (data.providerName) {
            lines.push(`📍 ${getProviderDisplayName(data.providerName)}`);
        }
    }

    return lines.join('\n');
}
