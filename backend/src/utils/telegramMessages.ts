/**
 * telegramMessages.ts - 统一消息模板模块
 * 
 * 所有 Telegram Bot 文本输出的单一来源。
 * 职责：消息格式化、存储提供商显示名、进度条渲染等。
 */

import { formatBytes, getTypeEmoji } from './telegramUtils.js';

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

export function generateProgressBar(completed: number, total: number, barLength: number = 16): string {
    if (total <= 0) return '░'.repeat(barLength) + ' 0%';
    const ratio = Math.min(completed / total, 1);
    const percentage = Math.round(ratio * 100);
    const filledLength = Math.round(ratio * barLength);
    const emptyLength = barLength - filledLength;
    return '█'.repeat(filledLength) + '░'.repeat(emptyLength) + ` ${percentage}%`;
}

export function generateProgressBarWithSpeed(
    completed: number,
    total: number,
    startTime?: number,
    barLength: number = 16
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
        `📊 当前排队: ${taskCount} 个任务`,
        `Bot 将在后台处理所有文件`,
        ``,
        `💡 发送 /tasks 查看实时状态`,
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

// ─── 合并单文件状态 ──────────────────────────────────────────

export interface ConsolidatedUploadFile {
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

/**
 * 合并显示所有活跃的单文件上传任务到一条消息
 * 当有 2+ 个任务同时进行时使用，替代删除旧消息的行为
 */
export function buildConsolidatedStatus(files: ConsolidatedUploadFile[]): string {
    const total = files.length;
    const completed = files.filter(f => f.phase === 'success' || f.phase === 'failed').length;
    const successCount = files.filter(f => f.phase === 'success').length;
    const failedCount = files.filter(f => f.phase === 'failed').length;

    let statusIcon: string;
    let statusText: string;

    if (completed === total) {
        if (failedCount === 0) { statusIcon = '✅'; statusText = '所有文件上传完成！'; }
        else if (successCount === 0) { statusIcon = '❌'; statusText = '文件上传失败'; }
        else { statusIcon = '⚠️'; statusText = '部分文件上传完成'; }
    } else {
        statusIcon = '📦'; statusText = `正在处理 ${total} 个文件...`;
    }

    const lines: string[] = [
        `${statusIcon} **${statusText}**`,
        `📊 进度: ${completed}/${total}`,
        generateProgressBar(completed, total),
        '',
    ];

    files.forEach(file => {
        let icon: string;
        let detail: string;

        switch (file.phase) {
            case 'downloading':
                icon = '⬇️';
                if (file.downloaded !== undefined && file.total) {
                    const pct = Math.round((file.downloaded / file.total) * 100);
                    detail = `下载中 ${pct}% (${formatBytes(file.downloaded)}/${formatBytes(file.total)})`;
                } else {
                    detail = '下载中...';
                }
                break;
            case 'saving':
                icon = '💾'; detail = '保存中...'; break;
            case 'success':
                icon = '✅';
                const parts: string[] = [];
                if (file.size) parts.push(formatBytes(file.size));
                if (file.providerName) parts.push(getProviderDisplayName(file.providerName));
                detail = parts.join(' · ') || '完成';
                break;
            case 'failed':
                icon = '❌'; detail = file.error || '失败'; break;
            case 'retrying':
                icon = '🔄'; detail = '重试中...'; break;
            case 'queued':
            default:
                icon = '🕒'; detail = '排队中'; break;
        }

        lines.push(`${icon} ${file.typeEmoji} ${file.fileName}`);
        lines.push(`    └ ${detail}`);
    });

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
        else { statusIcon = '⚠️'; statusText = '多文件上传部分完成'; }
    } else {
        statusIcon = '⏳'; statusText = '正在处理多文件上传...';
    }

    const lines: string[] = [
        `${statusIcon} **${statusText}**`,
    ];

    // 排队提示
    if (completed < total && (data.queuePending > 0 || data.queueActive >= 2)) {
        lines.push(`📊 已加入下载队列 (排队: ${data.queuePending})`);
        lines.push('');
    }

    // 文件夹 + 进度
    if (data.folderName) {
        lines.push(`📁 文件夹: ${data.folderName}`);
    }
    lines.push(`📊 进度: ${completed}/${total}`);
    lines.push(generateProgressBar(completed, total));

    // 类型和存储
    if (successful > 0 || completed === total) {
        const successFiles = data.files.filter(f => f.status === 'success');
        const types = Array.from(new Set(successFiles.map(f => getTypeEmoji(f.mimeType)))).join(' ') || '❓';
        lines.push(`🏷️ 类型: ${types}`);
        if (data.providerName) {
            lines.push(`📍 存储: ${getProviderDisplayName(data.providerName)}`);
        }
    }

    lines.push('');

    // 文件列表详情
    data.files.forEach(file => {
        let fileIcon: string;
        let fileStatus: string;

        switch (file.status) {
            case 'uploading': fileIcon = '🔄'; fileStatus = '上传中...'; break;
            case 'success': fileIcon = '✅'; fileStatus = formatBytes(file.size || 0); break;
            case 'failed': fileIcon = '❌'; fileStatus = file.error || '失败'; break;
            case 'queued': fileIcon = '🕒'; fileStatus = '排队中...'; break;
            default: fileIcon = '⏳'; fileStatus = '等待中'; break;
        }

        const typeEmoji = getTypeEmoji(file.mimeType);
        lines.push(`${fileIcon} ${typeEmoji} ${file.fileName}`);
        lines.push(`    └ ${fileStatus}`);
    });

    return lines.join('\n');
}
