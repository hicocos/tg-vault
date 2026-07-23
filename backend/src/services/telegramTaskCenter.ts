import type { DownloadTaskGroupSnapshot } from './downloadTaskQueue.js';
import type { TransferTaskRecord } from './transferTasks.js';

export type TaskCenterSourceType = 'memory' | 'channel' | 'ytdlp';
export type TaskCenterKind = 'single' | 'album' | 'channel' | 'ytdlp';
export type TaskCenterState = 'running' | 'waiting' | 'pausing' | 'paused' | 'cooling' | 'failed';

export type TaskCenterProtection = {
    kind: 'disk_pressure' | 'storage_cooldown' | 'telegram_flood_wait';
    reason: string;
    autoResume: boolean;
    retryAt?: string;
    recheckMs?: number;
};

export interface TaskCenterItem {
    sourceType: TaskCenterSourceType;
    id: string;
    kind: TaskCenterKind;
    title: string;
    state: TaskCenterState;
    total: number;
    active: number;
    pending: number;
    completed: number;
    failed: number;
    skipped: number;
    progressPercent?: number;
    currentFileName?: string;
    chatId?: string;
    userId?: number;
    source?: string;
    targetFolder?: string | null;
    reason?: string;
    protection?: TaskCenterProtection;
    createdAt: number;
    updatedAt: number;
}

export interface TaskCenterButton {
    text: string;
    data: string;
}

export interface TaskCenterView {
    text: string;
    rows: TaskCenterButton[][];
}

export interface TaskCenterPage extends TaskCenterView {
    page: number;
    totalPages: number;
    visibleItems: TaskCenterItem[];
}

export type TaskCenterAction = 'start' | 'pause' | 'resume' | 'retry' | 'cancel_prompt' | 'cancel_confirm';

export type ParsedTaskCenterCallback =
    | { view: 'list'; page: number }
    | { view: 'detail'; sourceType: TaskCenterSourceType; id: string; page: number }
    | { view: 'action'; action: TaskCenterAction; sourceType: TaskCenterSourceType; id: string; page: number };

const PAGE_SIZE = 6;
const VALID_ID = /^[A-Za-z0-9-]{1,24}$/;
const ACTION_CODES: Record<TaskCenterAction, string> = {
    start: 's',
    pause: 'p',
    resume: 'r',
    retry: 't',
    cancel_prompt: 'x',
    cancel_confirm: 'k',
};
const CODE_ACTIONS = Object.fromEntries(Object.entries(ACTION_CODES).map(([action, code]) => [code, action])) as Record<string, TaskCenterAction>;
const SOURCE_CODES: Record<TaskCenterSourceType, string> = { memory: 'm', channel: 'c', ytdlp: 'y' };
const CODE_SOURCES: Record<string, TaskCenterSourceType> = { m: 'memory', c: 'channel', y: 'ytdlp' };

function safeNumber(value: unknown): number {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function safeTime(value: unknown, fallback = Date.now()): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = value ? new Date(value as string).getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
}

function markdownText(value: unknown): string {
    return String(value ?? '').replace(/([\\`*_{}\[\]()#+!|>~])/g, '\\$1');
}

function shortText(value: string, max = 32): string {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

function kindLabel(kind: TaskCenterKind): string {
    return ({ single: '单文件', album: '相册', channel: '频道任务', ytdlp: 'yt-dlp' } as const)[kind];
}

function stateMeta(state: TaskCenterState): { icon: string; label: string; bucket: 'running' | 'waiting' | 'paused' | 'cooling' } {
    switch (state) {
        case 'running': return { icon: '🟢', label: '正在运行', bucket: 'running' };
        case 'waiting': return { icon: '⏳', label: '等待开始', bucket: 'waiting' };
        case 'pausing': return { icon: '⏸', label: '正在完成当前文件', bucket: 'paused' };
        case 'paused': return { icon: '⏸', label: '已暂停', bucket: 'paused' };
        case 'cooling': return { icon: '🧊', label: '系统等待', bucket: 'cooling' };
        case 'failed': return { icon: '🔴', label: '处理失败', bucket: 'waiting' };
    }
}

function stateOrder(state: TaskCenterState): number {
    return ({ running: 0, waiting: 1, pausing: 2, paused: 3, cooling: 4, failed: 5 } as const)[state];
}

function sourceCode(sourceType: TaskCenterSourceType): string {
    return SOURCE_CODES[sourceType];
}

function callbackList(page: number): string {
    return `tc_l_${Math.max(0, Math.floor(page))}`;
}

function callbackDetail(item: TaskCenterItem, page: number): string {
    return `tc_d_${sourceCode(item.sourceType)}_${item.id}_${Math.max(0, Math.floor(page))}`;
}

function callbackAction(action: TaskCenterAction, item: TaskCenterItem, page: number): string {
    return `tc_a_${ACTION_CODES[action]}_${sourceCode(item.sourceType)}_${item.id}_${Math.max(0, Math.floor(page))}`;
}

function formatAge(timestamp: number, now: number): string {
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (seconds < 60) return '刚刚';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
}

function progressLine(item: TaskCenterItem): string {
    if (item.progressPercent !== undefined) {
        return `${Math.round(Math.max(0, Math.min(100, item.progressPercent)))}%${item.currentFileName ? ` · ${item.currentFileName}` : ''}`;
    }
    const finished = Math.min(item.total, item.completed + item.failed + item.skipped);
    const parts = [`${finished}/${item.total}`];
    if (item.active > 0) parts.push(`下载中 ${item.active}`);
    if (item.pending > 0) parts.push(`待处理 ${item.pending}`);
    if (item.failed > 0) parts.push(`失败 ${item.failed}`);
    if (item.skipped > 0) parts.push(`跳过 ${item.skipped}`);
    return parts.join(' · ');
}

export function sortTaskCenterItems(items: TaskCenterItem[]): TaskCenterItem[] {
    return items
        .filter(item => ['running', 'waiting', 'pausing', 'paused', 'cooling', 'failed'].includes(item.state))
        .sort((a, b) => stateOrder(a.state) - stateOrder(b.state) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function buildTaskCenterPage(
    sourceItems: TaskCenterItem[],
    requestedPage = 0,
    options: { now?: number; pageSize?: number } = {},
): TaskCenterPage {
    const now = options.now || Date.now();
    const pageSize = Math.max(1, Math.floor(options.pageSize || PAGE_SIZE));
    const items = sortTaskCenterItems(sourceItems);
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const page = Math.min(Math.max(0, Math.floor(requestedPage || 0)), totalPages - 1);
    const visibleItems = items.slice(page * pageSize, page * pageSize + pageSize);
    const counts = { running: 0, waiting: 0, paused: 0, cooling: 0 };
    for (const item of items) counts[stateMeta(item.state).bucket] += 1;

    const lines = [
        '📥 **下载任务**',
        '',
        `🟢 运行中 ${counts.running}　⏳ 等待 ${counts.waiting}　⏸ 已暂停 ${counts.paused}`,
        ...(counts.cooling > 0 ? [`🧊 系统等待 ${counts.cooling}`] : []),
        `共 ${items.length} 个进行中的任务${totalPages > 1 ? ` · 第 ${page + 1}/${totalPages} 页` : ''}`,
    ];
    if (visibleItems.length === 0) {
        lines.push('', '📮 当前没有进行中的任务');
    }
    visibleItems.forEach((item, index) => {
        const meta = stateMeta(item.state);
        const secondary = item.currentFileName
            ? `${kindLabel(item.kind)} · ${progressLine(item)} · 当前：${shortText(item.currentFileName, 24)}`
            : `${kindLabel(item.kind)} · ${progressLine(item)} · ${meta.label}`;
        lines.push('', `${page * pageSize + index + 1}. ${meta.icon} **${markdownText(shortText(item.title, 42))}**`, `   ${markdownText(secondary)}`);
    });
    if (items.length > 0) lines.push('', '点击编号查看详情并控制选中的任务。');

    const rows: TaskCenterButton[][] = visibleItems.map((item, index) => [{
        text: `${page * pageSize + index + 1}. ${stateMeta(item.state).icon} ${shortText(item.title, 22)}`,
        data: callbackDetail(item, page),
    }]);
    const navigation: TaskCenterButton[] = [];
    if (page > 0) navigation.push({ text: '◀️ 上一页', data: callbackList(page - 1) });
    navigation.push({ text: '🔄 刷新', data: callbackList(page) });
    if (page + 1 < totalPages) navigation.push({ text: '下一页 ▶️', data: callbackList(page + 1) });
    if (navigation.length > 0) rows.push(navigation);

    return { text: lines.join('\n'), rows, page, totalPages, visibleItems };
}

export function buildTaskCenterDetail(
    item: TaskCenterItem,
    page = 0,
    options: { now?: number } = {},
): TaskCenterView {
    const now = options.now || Date.now();
    const meta = stateMeta(item.state);
    const title = item.title.replace(/[\u0000-\u001F\u007F]/g, ' ').trim() || '未命名任务';
    const source = item.source?.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    const currentFileName = item.currentFileName?.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    const targetFolder = item.targetFolder?.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    const reason = item.reason?.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    const lines = [
        `${meta.icon} **${meta.label}**`,
        '',
        `📌 ${markdownText(title)}`,
        `类型：${kindLabel(item.kind)}`,
        ...(source ? [`来源：${markdownText(source)}`] : []),
        `进度：${markdownText(progressLine(item))}`,
        ...(currentFileName ? [`当前文件：${markdownText(currentFileName)}`] : []),
        ...(targetFolder ? [`保存位置：${markdownText(targetFolder)}`] : []),
        ...(reason ? [`原因：${markdownText(reason)}`] : []),
        `创建：${formatAge(item.createdAt, now)}`,
        `最近活动：${formatAge(item.updatedAt, now)}`,
        `任务 ID：${item.id}`,
    ];
    const systemBlocked = Boolean(item.protection);
    if (systemBlocked) {
        const protection = item.protection!;
        const recovery = protection.autoResume
            ? protection.retryAt
                ? `系统会在 ${protection.retryAt} 后重新检查并自动恢复。`
                : protection.recheckMs
                    ? `系统每 ${Math.max(1, Math.round(protection.recheckMs / 1000))} 秒重新检查，条件满足后自动恢复。`
                    : '系统会持续检查，条件满足后自动恢复。'
            : '此状态不会自动恢复，请按原因处理后重试。';
        lines.push('', `该任务由系统保护暂停；${recovery}`);
    }
    if (item.state === 'pausing') lines.push('', '当前文件完成后会自动进入已暂停状态。');
    if (item.state === 'failed') lines.push('', '该任务没有继续运行；确认外部写结果已对账后，可以重新提交下载。');
    if (item.state === 'waiting' && item.sourceType !== 'ytdlp') lines.push('', '“优先开始”会把该任务移到等待队列前面，不会中断正在下载的文件。');
    if (item.state === 'running' && item.sourceType !== 'ytdlp') lines.push('', '暂停会先完成当前文件，再停止这个任务的后续文件。');

    const actionRow: TaskCenterButton[] = [];
    if (item.sourceType !== 'ytdlp' && item.state === 'waiting' && (item.sourceType === 'memory' || item.active + item.pending > 0)) actionRow.push({ text: '▶️ 优先开始', data: callbackAction('start', item, page) });
    if (item.sourceType !== 'ytdlp' && item.state === 'running') actionRow.push({ text: '⏸ 暂停任务', data: callbackAction('pause', item, page) });
    if (item.sourceType !== 'ytdlp' && item.state === 'paused' && !systemBlocked) actionRow.push({ text: '▶️ 继续', data: callbackAction('resume', item, page) });
    if (item.sourceType !== 'ytdlp' && item.state === 'pausing') actionRow.push({ text: '▶️ 撤销暂停', data: callbackAction('resume', item, page) });
    if (item.sourceType === 'ytdlp' && item.state === 'failed') actionRow.push({ text: '🔄 重试', data: callbackAction('retry', item, page) });
    actionRow.push({ text: '🛑 取消', data: callbackAction('cancel_prompt', item, page) });

    return {
        text: lines.join('\n'),
        rows: [
            actionRow,
            [
                { text: '↩️ 返回任务列表', data: callbackList(page) },
                { text: '🔄 刷新', data: callbackDetail(item, page) },
            ],
        ],
    };
}

export function buildTaskCancelConfirm(item: TaskCenterItem, page = 0): TaskCenterView {
    const title = item.title.replace(/[\u0000-\u001F\u007F]/g, ' ').trim() || '未命名任务';
    return {
        text: [
            '⚠️ **确认取消这个任务？**',
            '',
            `📌 ${markdownText(title)}`,
            `类型：${kindLabel(item.kind)}`,
            `进度：${markdownText(progressLine(item))}`,
            '',
            item.active > 0
                ? '正在下载的文件会被中止并清理临时文件，等待中的文件会立即移出队列。'
                : '等待中的文件会立即移出队列。',
            '其它任务不会受到影响。',
        ].join('\n'),
        rows: [
            [
                { text: '⚠️ 确认取消', data: callbackAction('cancel_confirm', item, page) },
                { text: '返回详情', data: callbackDetail(item, page) },
            ],
        ],
    };
}

export function parseTaskCenterCallback(data: string): ParsedTaskCenterCallback | null {
    let match = data.match(/^tc_l_(\d{1,6})$/);
    if (match) return { view: 'list', page: Number(match[1]) };

    match = data.match(/^tc_d_([mcy])_([A-Za-z0-9-]{1,24})_(\d{1,6})$/);
    if (match) {
        const sourceType = CODE_SOURCES[match[1]];
        if (!sourceType || !VALID_ID.test(match[2])) return null;
        return { view: 'detail', sourceType, id: match[2], page: Number(match[3]) };
    }

    match = data.match(/^tc_a_([sprtxk])_([mcy])_([A-Za-z0-9-]{1,24})_(\d{1,6})$/);
    if (!match) return null;
    const action = CODE_ACTIONS[match[1]];
    const sourceType = CODE_SOURCES[match[2]];
    if (!action || !sourceType || !VALID_ID.test(match[3])) return null;
    return { view: 'action', action, sourceType, id: match[3], page: Number(match[4]) };
}

export function ordinaryTaskCenterItem(group: DownloadTaskGroupSnapshot): TaskCenterItem | null {
    if (group.hidden || group.kind === 'channel' || group.state === 'completed' || group.state === 'cancelled' || group.state === 'cancelling') return null;
    const state: TaskCenterState = group.systemPause
        ? 'cooling'
        : group.state as TaskCenterState;
    if (!['running', 'waiting', 'pausing', 'paused', 'cooling'].includes(state)) return null;
    return {
        sourceType: 'memory',
        id: group.id,
        kind: group.kind,
        title: group.title,
        state,
        total: group.total,
        active: group.active,
        pending: group.pending,
        completed: group.completed,
        failed: group.failed,
        skipped: group.cancelled,
        currentFileName: group.currentFileName,
        chatId: group.chatId,
        userId: group.userId,
        source: group.source,
        targetFolder: group.targetFolder,
        reason: group.reason,
        protection: group.systemPause,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
    };
}

export function ytdlpTaskCenterItem(task: TransferTaskRecord): TaskCenterItem | null {
    if (task.sourceType !== 'ytdlp' || !['pending', 'running', 'paused', 'failed', 'interrupted', 'retry_required'].includes(task.status)) return null;
    const id = task.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 24);
    if (!id) return null;
    const state: TaskCenterState = ['failed', 'interrupted', 'retry_required'].includes(task.status)
        ? 'failed'
        : task.status === 'running' ? 'running' : task.status === 'paused' ? 'paused' : 'waiting';
    const stageLabels: Record<string, string> = {
        waiting: '等待开始',
        recovering: '服务重启后恢复',
        downloading: '下载源文件',
        uploading: '上传到存储',
        processing: '服务器处理中',
    };
    const accountName = typeof task.payload.targetAccountName === 'string' ? task.payload.targetAccountName : task.targetProvider;
    return {
        sourceType: 'ytdlp',
        id,
        kind: 'ytdlp',
        title: task.title,
        state,
        total: 1,
        active: state === 'running' ? 1 : 0,
        pending: state === 'waiting' ? 1 : 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        progressPercent: task.progress,
        currentFileName: stageLabels[task.stage] || task.stage,
        chatId: task.chatId || undefined,
        userId: task.ownerUserId || undefined,
        source: task.source || undefined,
        targetFolder: `${accountName || '默认账户'} / ${task.targetFolder || 'ytdlp'}`,
        reason: task.error || undefined,
        createdAt: task.createdAt.getTime(),
        updatedAt: task.updatedAt.getTime(),
    };
}

function isChannelSystemPause(row: any, inCooldown: boolean): boolean {
    return inCooldown || row?.status === 'cooling';
}

function channelSystemPauseReason(row: any): string | undefined {
    if (!isChannelSystemPause(row, Boolean(row?.cooldown_until && safeTime(row.cooldown_until, 0) > Date.now()))) return undefined;
    const until = row?.cooldown_until ? new Date(row.cooldown_until) : undefined;
    const providerLimit = /Google Drive|上传额度|daily_upload_limit/i.test(String(row?.error || ''));
    const cause = providerLimit ? 'Google Drive 今日上传额度已达上限' : 'Telegram 请求频率受限（FloodWait）';
    if (!until || Number.isNaN(until.getTime())) return `${cause}；系统会持续检查并自动恢复`;
    return `${cause}；预计 ${until.toLocaleString('zh-CN', { hour12: false })} 后自动恢复`;
}

export function channelTaskCenterItem(row: any): TaskCenterItem | null {
    const rawId = String(row?.id || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!rawId) return null;
    const id = rawId.slice(0, 12);
    const total = Math.max(safeNumber(row.total_count), safeNumber(row.item_count));
    const active = safeNumber(row.downloading_count);
    const pending = safeNumber(row.pending_count);
    const completed = safeNumber(row.success_count);
    const failed = safeNumber(row.failed_count);
    const skipped = safeNumber(row.skipped_count_items ?? row.skipped_count);
    const cooldownUntil = row.cooldown_until ? new Date(row.cooldown_until) : undefined;
    const inCooldown = Boolean(row.cooldown_until && safeTime(row.cooldown_until, 0) > Date.now())
        || (row.status === 'cooling' && (!row.cooldown_until || safeTime(row.cooldown_until, 0) > Date.now()));
    const protection: TaskCenterProtection | undefined = inCooldown
        ? {
            kind: /Google Drive|上传额度|daily_upload_limit/i.test(String(row.error || '')) ? 'storage_cooldown' : 'telegram_flood_wait',
            reason: channelSystemPauseReason(row) || '系统冷却中',
            autoResume: true,
            retryAt: cooldownUntil && !Number.isNaN(cooldownUntil.getTime())
                ? cooldownUntil.toLocaleString('zh-CN', { hour12: false })
                : undefined,
        }
        : undefined;
    const state: TaskCenterState = inCooldown
        ? 'cooling'
        : row.status === 'paused'
            ? (active > 0 ? 'pausing' : 'paused')
            : row.status === 'queued' || row.status === 'pending'
                ? 'waiting'
                : active > 0 || row.scan_status === 'scanning' || row.is_actively_running
                    ? 'running'
                    : 'waiting';
    const optionsSource = row.options ?? row.params ?? {};
    let options: Record<string, any>;
    if (typeof optionsSource === 'string') {
        try {
            const parsed = JSON.parse(optionsSource);
            options = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            options = {};
        }
    } else {
        options = optionsSource && typeof optionsSource === 'object' && !Array.isArray(optionsSource)
            ? optionsSource
            : {};
    }
    const qualifier = options.tag || (options.startDate && options.endDate ? `${options.startDate} → ${options.endDate}` : '');
    const source = String(row.source || '频道任务');
    const chatId = row.chat_id !== undefined && row.chat_id !== null ? String(row.chat_id) : undefined;
    const userId = row.user_id !== undefined && row.user_id !== null ? safeNumber(row.user_id) : undefined;
    return {
        sourceType: 'channel',
        id,
        kind: 'channel',
        title: qualifier ? `${source} · ${qualifier}` : source,
        state,
        total,
        active,
        pending,
        completed,
        failed,
        skipped,
        currentFileName: row.current_file_name || undefined,
        chatId,
        userId,
        source,
        targetFolder: row.folder_override || options.folderOverride || null,
        reason: protection?.reason ?? (row.status === 'paused' ? '用户请求暂停' : row.error || undefined),
        protection,
        createdAt: safeTime(row.created_at),
        updatedAt: safeTime(row.queue_updated_at || row.updated_at),
    };
}
