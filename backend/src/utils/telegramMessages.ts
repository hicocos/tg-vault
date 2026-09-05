/**
 * telegramMessages.ts - 统一消息模板模块
 * 
 * 所有 Telegram Bot 文本输出的单一来源。
 * 职责：消息格式化、存储提供商显示名、进度条渲染等。
 */

import { Api } from 'telegram';
import { formatBytes, getTypeEmoji } from './telegramUtils.js';
export { getProviderDisplayName } from './providerMetadata.js';
import { getProviderDisplayName } from './providerMetadata.js';
import { DEFAULT_LOCALE, formatBytes as formatLocalizedBytes, formatDate, t, type TelegramLocale } from '../i18n/telegram.js';

interface TaskSystemPauseView {
    kind: 'disk_pressure' | 'storage_cooldown' | 'telegram_flood_wait';
    reason: string;
    autoResume: boolean;
    recheckMs?: number;
    retryAt?: string;
}

function buildTaskControlLines(taskId?: string, queuePaused = false, pauseReason?: string, systemPause?: TaskSystemPauseView): string[] {
    if (!taskId) return [];
    if (queuePaused) {
        const systemPaused = Boolean(systemPause);
        const pausing = !systemPause && /随后暂停|完成当前文件/.test(pauseReason || '');
        const recoveryLine = systemPause
            ? systemPause.autoResume
                ? systemPause.retryAt
                    ? `♻️ 预计在 ${systemPause.retryAt} 后自动恢复`
                    : systemPause.recheckMs
                        ? `♻️ 每 ${Math.max(1, Math.round(systemPause.recheckMs / 1_000))} 秒重新检查，条件满足后自动恢复`
                        : `♻️ 条件满足后自动恢复`
                : `⚠️ 处理原因后可重试`
            : pausing
                ? `点击“继续”可撤销暂停`
                : `点击“继续”恢复任务`;
        return [
            systemPaused
                ? `当前状态：系统保护暂停`
                : pausing
                    ? `⏸️ 正在暂停`
                    : `当前状态：用户暂停`,
            pauseReason ? `原因：${pauseReason}` : '',
            recoveryLine,
        ].filter(Boolean);
    }
    return ['👇 使用下方按钮管理此任务。'];
}

export function buildTaskControlButtons(taskId?: string, queuePaused = false, systemPause?: TaskSystemPauseView, queuePausing = false, userPaused = queuePaused && !systemPause, failedCount = 0, locale: TelegramLocale = DEFAULT_LOCALE): Api.ReplyInlineMarkup | undefined {
    if (!taskId) return undefined;
    const actionButtons: Api.TypeKeyboardButton[] = queuePaused || queuePausing
        ? systemPause && !userPaused
            ? []
            : [new Api.KeyboardButtonCallback({ text: t(locale, 'task.resume'), data: Buffer.from(`tq_resume_${taskId}`) })]
        : [new Api.KeyboardButtonCallback({ text: t(locale, 'task.pause'), data: Buffer.from(`tq_pause_${taskId}`) })];
    actionButtons.push(new Api.KeyboardButtonCallback({ text: t(locale, 'task.cancel'), data: Buffer.from(`tq_cancel_${taskId}`) }));
    const rows = [new Api.KeyboardButtonRow({ buttons: actionButtons })];
    if (failedCount > 0) {
        rows.push(new Api.KeyboardButtonRow({ buttons: [
            new Api.KeyboardButtonCallback({ text: t(locale, 'task.retryFailed', { count: failedCount }), data: Buffer.from(`receipt_retry_${taskId}`) }),
            new Api.KeyboardButtonCallback({ text: t(locale, 'task.failureDetails'), data: Buffer.from(`receipt_failures_${taskId}`) }),
        ] }));
    }
    return new Api.ReplyInlineMarkup({ rows });
}

function collectCompletedFolders(
    singleFiles: Array<{ phase: string; folder?: string | null }>,
    batches: Array<{ folderName?: string; folderPath?: string; completed: number; totalFiles: number }>,
): string[] {
    const folders = new Set<string>();
    singleFiles
        .filter(file => file.phase === 'success' && file.folder)
        .forEach(file => folders.add(file.folder!));
    batches
        .filter(batch => batch.completed === batch.totalFiles)
        .forEach(batch => {
            const folder = batch.folderPath || batch.folderName;
            if (folder) folders.add(folder);
        });
    return Array.from(folders);
}

function formatFolderSummary(folders: string[], maxItems = 4): string[] {
    if (folders.length === 0) return [];
    const visible = folders.slice(0, maxItems);
    const lines = [`📁 保存路径：${visible[0]}`];
    visible.slice(1).forEach(folder => lines.push(`   └ ${folder}`));
    if (folders.length > visible.length) {
        lines.push(`   └ 另有 ${folders.length - visible.length} 个路径，可用 /list 查看`);
    }
    return lines;
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
export function buildWelcomeBack(locale: TelegramLocale = DEFAULT_LOCALE): string {
    return t(locale, 'auth.welcomeBack');
}

/** 首次认证成功的欢迎消息 */
export function buildAuthSuccess(locale: TelegramLocale = DEFAULT_LOCALE): string {
    return t(locale, 'auth.successBody');
}

/** /start 未认证的欢迎 + 密码键盘提示 */
export function buildStartPrompt(locale: TelegramLocale = DEFAULT_LOCALE): string {
    return t(locale, 'auth.startPrompt');
}

/** /help 简洁入口 */
export function buildHelp(locale: TelegramLocale = DEFAULT_LOCALE): string {
    return t(locale, 'help.body');
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
    localFileCount: number;
    localTotalSize: number;
    queueActive: number;
    queuePending: number;
}

export function buildStorageReport(data: StorageReportData, locale: TelegramLocale = DEFAULT_LOCALE): string {
    // 磁盘用量可视化条
    const usageBar = generateProgressBar(data.diskUsedPercent, 100, 12);

    return [
        t(locale, 'messages.storage.title'),
        LINE,
        ``,
        t(locale, 'messages.storage.disk'),
        t(locale, 'messages.storage.total', { value: formatLocalizedBytes(data.diskTotal, locale) }),
        t(locale, 'messages.storage.used', { value: formatLocalizedBytes(data.diskTotal - data.diskFree, locale), percent: data.diskUsedPercent }),
        t(locale, 'messages.storage.free', { value: formatLocalizedBytes(data.diskFree, locale) }),
        `  ${usageBar}`,
        ``,
        t(locale, 'messages.storage.indexed'),
        t(locale, 'messages.storage.fileCount', { count: data.fileCount }),
        t(locale, 'messages.storage.size', { value: formatLocalizedBytes(data.totalFileSize, locale) }),
        ``,
        t(locale, 'messages.storage.local'),
        t(locale, 'messages.storage.fileCount', { count: data.localFileCount }),
        t(locale, 'messages.storage.size', { value: formatLocalizedBytes(data.localTotalSize, locale) }),
        t(locale, 'messages.storage.location'),
        ``,
        t(locale, 'messages.storage.queue'),
        t(locale, 'messages.storage.queueCounts', { active: data.queueActive, pending: data.queuePending }),
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

function compactTelegramText(value: unknown, maxLength: number): string {
    const text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/[*_`[\]\\]/g, '').trim();
    return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text;
}

export function buildFileList(files: FileListItem[], total: number, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const visibleFiles = files.slice(0, 12);
    const lines: string[] = [
        t(locale, 'messages.files.title', { count: visibleFiles.length }),
        LINE,
    ];

    visibleFiles.forEach((file, index) => {
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

        const displayName = compactTelegramText(file.name, 36);
        const folder = compactTelegramText(file.folder, 48);

        lines.push(`${index + 1}. ${typeEmoji} **${displayName || t(locale, 'messages.files.unnamed')}**`);
        lines.push(`    ${size} · ${date}${folder ? ` · 📁 ${folder}` : ''}`);
        lines.push(`    ID: \`${file.id.substring(0, 8)}\``);
    });

    lines.push('');
    lines.push(t(locale, 'messages.files.hint'));

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
    _history: TaskItem[] = []
): string {
    const lines: string[] = [
        `📋 **实时下载队列**`,
        `🔄 ${active.length} 正在下载　⏳ ${pending.length} 等待开始`,
        LINE,
    ];

    if (active.length > 0) {
        lines.push('');
        lines.push(`**🔄 正在下载**`);
        active.forEach(task => {
            lines.push(`  ▸ ${task.fileName}`);
            if (task.totalSize && task.downloadedSize) {
                const bar = generateProgressBar(task.downloadedSize, task.totalSize, 10);
                lines.push(`    ${bar}  (${formatBytes(task.downloadedSize)}/${formatBytes(task.totalSize)})`);
            } else {
                lines.push(`    传输中，请稍候...`);
            }
        });
    }

    if (pending.length > 0) {
        lines.push('');
        lines.push(`**⏳ 等待开始** (前 5 个)`);
        pending.slice(0, 5).forEach((task, i) => {
            lines.push(`  ${i + 1}. ${task.fileName}`);
        });
        if (pending.length > 5) {
            lines.push(`  ... 还有 ${pending.length - 5} 个等待任务`);
        }
    }

    return lines.join('\n');
}

// ─── 上传相关 ────────────────────────────────────────────────

/** 单文件上传成功 */
export function buildUploadSuccess(
    fileName: string,
    size: number,
    fileType: string,
    providerName: string,
    folder?: string | null,
    fileId?: string | null,
    duplicateOutcome?: 'copied' | 'skipped' | null,
    locale: TelegramLocale = DEFAULT_LOCALE,
): string {
    const typeEmoji = getTypeEmoji(
        fileType === 'image' ? 'image/' :
            fileType === 'video' ? 'video/' :
                fileType === 'audio' ? 'audio/' : 'other'
    );
    const bar = generateProgressBar(1, 1);
    return [
        t(locale, 'upload.success'),
        `${bar}`,
        ``,
        `${typeEmoji} ${fileName}`,
        `📦 ${formatLocalizedBytes(size, locale)}`,
        `📍 ${getProviderDisplayName(providerName)}`,
        ...(folder ? [`📁 ${folder}`] : []),
        ...(fileId ? [`🆔 ${fileId.slice(0, 13)}`] : []),
        ...(duplicateOutcome ? [t(locale, duplicateOutcome === 'copied' ? 'upload.duplicateCopiedOutcome' : 'upload.duplicateSkippedOutcome')] : []),
        ``,
        ...(fileId ? [t(locale, 'upload.manageHint')] : []),
    ].join('\n');
}

/** 单文件上传失败 */
export function buildUploadFail(fileName: string, error: string, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return [
        t(locale, 'upload.failed'),
        ``,
        `📄 ${fileName}`,
        t(locale, 'upload.reason', { error }),
        ``,
        t(locale, 'upload.failureRetryNote'),
        t(locale, 'upload.failureAdvice'),
    ].join('\n');
}

export function buildDuplicateSkipped(fileName: string, folder: string | null | undefined, existingId?: string, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return [
        t(locale, 'upload.duplicateSkipped'),
        ``,
        `📄 ${fileName}`,
        ...(folder ? [`📁 ${folder}`] : []),
        ...(existingId ? [t(locale, 'upload.existingId', { id: existingId.substring(0, 8) })] : []),
        ``,
        t(locale, 'upload.duplicateCopyAdvice'),
    ].join('\n');
}

/** 单文件下载进度 */
export function buildDownloadProgress(
    fileName: string,
    downloaded: number,
    total: number,
    typeEmoji: string,
    startTime?: number,
    locale: TelegramLocale = DEFAULT_LOCALE,
): string {
    const bar = startTime
        ? generateProgressBarWithSpeed(downloaded, total, startTime)
        : generateProgressBar(downloaded, total);
    return [
        t(locale, 'upload.downloading'),
        `${bar}`,
        ``,
        `${typeEmoji} ${fileName}`,
        `${formatLocalizedBytes(downloaded, locale)} / ${formatLocalizedBytes(total, locale)}`,
    ].join('\n');
}

/** 文件保存中 */
export function buildSavingFile(fileName: string, typeEmoji: string, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const bar = generateProgressBar(1, 1);
    return [
        t(locale, 'upload.saving'),
        `${bar}`,
        ``,
        `${typeEmoji} ${fileName}`,
    ].join('\n');
}

/** 排队等待中 */
export function buildQueuedMessage(fileName: string, pendingCount: number, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return [
        t(locale, 'upload.queued'),
        ``,
        `📄 ${fileName}`,
        t(locale, 'upload.currentQueue', { count: pendingCount }),
        t(locale, 'upload.wait'),
    ].join('\n');
}

/** 重试中 */
export function buildRetryMessage(fileName: string, typeEmoji: string, locale: TelegramLocale = DEFAULT_LOCALE): string {
    const bar = generateProgressBar(0, 1);
    return [
        t(locale, 'upload.retrying'),
        `${bar}`,
        ``,
        `${typeEmoji} ${fileName}`,
    ].join('\n');
}

/** 删除成功 */
export function buildDeleteSuccess(fileName: string, fileId: string, locale: TelegramLocale = DEFAULT_LOCALE): string {
    return [
        t(locale, 'messages.delete.success'),
        ``,
        `📄 ${fileName}`,
        `🗑️ ID: ${fileId}`,
    ].join('\n');
}

// ─── 多文件上传 ──────────────────────────────────────────────

/** 静默模式通知 */
export function buildSilentModeNotice(fileCount: number, taskId?: string, queuePaused = false, pauseReason?: string, systemPause?: TaskSystemPauseView): string {
    return [
        queuePaused ? (systemPause ? `⏸️ **已进入系统保护暂停**` : `⏸️ **后台下载已暂停**`) : `🤐 **已切换到静默模式**`,
        ...(taskId ? [`🆔 任务：\`${taskId}\``] : []),
        ``,
        queuePaused ? `等待任务已暂停，不会继续开始新的下载。` : `Bot 将在后台继续处理所有文件，请耐心等待。`,
        ``,
        ...buildTaskControlLines(taskId, queuePaused, pauseReason, systemPause),
    ].join('\n');
}

interface SilentProgressBatch {
    folderName: string;
    folderPath?: string;
    totalFiles: number;
    completed: number;
    successful: number;
    failed: number;
    providerName?: string;
    queuePending?: number;
    currentFileName?: string;
    currentFileActive?: boolean;
}

interface SilentProgressFile {
    fileName: string;
    phase: ConsolidatedUploadFile['phase'];
    downloaded?: number;
    total?: number;
    providerName?: string;
    folder?: string | null;
}

export function buildSilentProgress(
    sessionTotal: number,
    batches: SilentProgressBatch[],
    singleFiles: SilentProgressFile[] = [],
    sessionCompleted: number = 0,
    sessionFailed: number = 0,
    taskId?: string,
    queuePaused = false,
    pauseReason?: string,
    queuePausing = false,
    systemPause?: TaskSystemPauseView,
): string {
    const totalBatchFiles = batches.reduce((sum, batch) => sum + batch.totalFiles, 0);
    const completedBatchFiles = batches.reduce((sum, batch) => sum + batch.completed, 0);
    const successfulBatchFiles = batches.reduce((sum, batch) => sum + batch.successful, 0);
    const failedBatchFiles = batches.reduce((sum, batch) => sum + batch.failed, 0);
    const completedSingleFiles = singleFiles.filter(file => file.phase === 'success' || file.phase === 'failed').length;
    const failedSingleFiles = singleFiles.filter(file => file.phase === 'failed').length;
    const totalFiles = Math.max(sessionTotal, totalBatchFiles + singleFiles.length, completedBatchFiles + completedSingleFiles, sessionCompleted);
    const completedFiles = Math.max(sessionCompleted, completedBatchFiles + completedSingleFiles);
    const failedFiles = Math.max(sessionFailed, failedBatchFiles + failedSingleFiles);
    const successfulFiles = Math.max(0, completedFiles - failedFiles);
    const remainingFiles = Math.max(0, totalFiles - completedFiles);
    const isComplete = totalFiles > 0 && remainingFiles === 0;
    const activeBatch = batches.find(batch => batch.completed < batch.totalFiles);
    const activeSingle = singleFiles.find(file => !['success', 'failed'].includes(file.phase));
    const currentFile = queuePaused || queuePausing
        ? undefined
        : activeBatch?.currentFileActive
            ? activeBatch.currentFileName
            : activeSingle?.phase === 'downloading' || activeSingle?.phase === 'saving'
                ? activeSingle.fileName
                : undefined;
    const progress = generateProgressBar(completedFiles, Math.max(totalFiles, 1));
    if (isComplete) {
        return buildSilentAllTasksComplete(totalFiles, failedFiles, taskId, singleFiles, batches);
    }

    return [
        queuePaused
            ? (systemPause ? `⏸️ **系统保护暂停**` : `⏸️ **后台下载已暂停**`)
            : queuePausing
                ? `⏸️ **正在完成当前文件，随后暂停**`
                : `🤐 **后台批量处理中**`,
        `${progress} (${completedFiles}/${totalFiles})`,
        ``,
        `✅ 成功: ${successfulFiles}　❌ 失败: ${failedFiles}　⏳ 剩余: ${remainingFiles}`,
        ...(currentFile ? [`📄 当前: ${currentFile}`] : []),
        ...(activeBatch ? [`📁 批次: ${activeBatch.folderName}`] : []),
        ...(activeBatch?.queuePending ? [`🕒 队列等待: ${activeBatch.queuePending}`] : []),
        ``,
        ...buildTaskControlLines(taskId, queuePaused || queuePausing, pauseReason, systemPause),
        ...(taskId && failedFiles > 0 && remainingFiles === 0 ? [`🔄 检测到失败任务，可发送 /tg_retry ${taskId} 重试最近失败项`] : []),
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

export function buildSilentAllTasksComplete(
    totalCount: number,
    failedCount: number,
    taskId?: string,
    singleFiles: SilentProgressFile[] = [],
    batches: SilentProgressBatch[] = [],
): string {
    const successCount = Math.max(0, totalCount - failedCount);
    const providers = new Set<string>();
    singleFiles.filter(f => f.phase === 'success' && f.providerName).forEach(f => providers.add(f.providerName!));
    batches.filter(b => b.providerName).forEach(b => providers.add(b.providerName!));
    const folders = collectCompletedFolders(singleFiles, batches);
    const detailLines = [
        ...(providers.size > 0 ? [`📍 存储: ${Array.from(providers).map(p => getProviderDisplayName(p)).join(', ')}`] : []),
        ...formatFolderSummary(folders),
    ];

    if (failedCount > 0) {
        return [
            `⚠️ **后台任务部分完成**`,
            ``,
            ...(taskId ? [`🆔 任务：\`${taskId}\``] : []),
            `✅ 成功: ${successCount} 个文件`,
            `❌ 失败: ${failedCount} 个文件`,
            `📊 总计: ${totalCount} 个文件`,
            ...detailLines,
            ``,
            ...(taskId ? [`🔄 检测到失败任务，发送 /tg_retry ${taskId} 重试最近失败项`] : []),
        ].join('\n');
    }
    return [`✅ **后台任务全部完成**`, ``, ...(taskId ? [`🆔 任务：\`${taskId}\``] : []), `📊 总计: ${totalCount} 个文件`, ...detailLines].join('\n');
}

// ─── 合并状态（单文件 + 批量） ──────────────────────────────

export interface ConsolidatedUploadFile {
    id?: string;
    fileName: string;
    typeEmoji: string;
    phase: 'queued' | 'downloading' | 'saving' | 'success' | 'failed' | 'retrying' | 'cancelled';
    downloaded?: number;
    total?: number;
    size?: number;
    error?: string;
    providerName?: string;
    fileType?: string;
    folder?: string | null;
}

export interface ConsolidatedBatchEntry {
    id: string;
    folderName: string;
    folderPath?: string;
    totalFiles: number;
    completed: number;
    successful: number;
    failed: number;
    providerName?: string;
    isSilent?: boolean;
    queuePending?: number;
    currentFileName?: string;
    currentFileActive?: boolean;
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

        const folders = collectCompletedFolders(singleFiles, batches);
        lines.push(...formatFolderSummary(folders));

        lines.push('');
        lines.push(`⏰ 完成时间: ${new Date().toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        })}`);

        // 添加失败提醒（不自动清理，避免误删）
        if (totalFailed > 0) {
            lines.push('');
            lines.push('🧹 **自动清理已关闭**');
            lines.push('  失败产生的本地临时文件不会在这里自动删除。');
            lines.push('  如需清理，请先确认文件状态后手动处理。');
        }

        lines.push('');

        // 添加友好的结束消息
        if (totalFailed === 0) {
            lines.push('🎊 所有文件已安全上传到云端！');
            lines.push('💡 您可以随时使用 /list 查看上传记录');
        } else {
            lines.push('💡 部分文件上传失败，未自动清理服务器缓存');
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
                    if (file.folder) parts.push(`📁 ${file.folder}`);
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
                if (batch.currentFileActive && batch.currentFileName) {
                    lines.push(`    📄 当前: ${batch.currentFileName}`);
                }
            } else {
                lines.push(`    ✅ ${batch.successful}  ❌ ${batch.failed}`);
            }

            if (batch.queuePending && batch.queuePending > 0 && !isDone) {
                lines.push(`    ⏳ 队列: ${batch.queuePending}`);
            }
            if (batch.providerName && isDone) {
                lines.push(`    📍 ${getProviderDisplayName(batch.providerName)}`);
            }
            if (batch.folderPath && isDone) {
                lines.push(`    📁 ${batch.folderPath}`);
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
                    if (file.folder) parts.push(`📁 ${file.folder}`);
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
    folderPath?: string;
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
        if (data.folderPath) {
            lines.push(`📁 保存路径：${data.folderPath}`);
        }
    }

    return lines.join('\n');
}
