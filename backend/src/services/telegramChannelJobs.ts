import { Api, TelegramClient } from 'telegram';
import { query } from '../db/index.js';
import { storageManager } from './storage.js';
import { getTelegramUserClient, isTelegramUserClientReady } from './telegramUserClient.js';
import { downloadTelegramChannelRange, getTelegramDownloadPreview, type TelegramDownloadMessageRef } from './telegramUpload.js';
import { getSetting } from '../utils/settings.js';
import { extractFileInfo, getEstimatedFileSize } from '../utils/telegramMedia.js';

const SUBSCRIPTION_INTERVAL_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_SUBSCRIPTION_INTERVAL_MS || '300000', 10) || 300_000);
const SUBSCRIPTION_SCAN_LIMIT = Math.max(1, parseInt(process.env.TELEGRAM_SUBSCRIPTION_SCAN_LIMIT || '100', 10) || 100);
const TG_JOB_RECOVERY_DELAY_MS = Math.max(1000, parseInt(process.env.TG_JOB_RECOVERY_DELAY_MS || '10000', 10) || 10_000);
const TG_JOB_SCAN_SEGMENT_SIZE = Math.max(20, parseInt(process.env.TG_JOB_SCAN_SEGMENT_SIZE || '100', 10) || 100);
const TG_JOB_DOWNLOAD_BATCH_SIZE = Math.max(1, parseInt(process.env.TG_JOB_DOWNLOAD_BATCH_SIZE || '20', 10) || 20);
const TG_JOB_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.TG_JOB_MAX_ATTEMPTS || '3', 10) || 3);
export const TELEGRAM_COMMENTS_MAX_PER_POST = Math.max(1, parseInt(process.env.TELEGRAM_COMMENTS_MAX_PER_POST || '200', 10) || 200);
let subscriptionTimer: NodeJS.Timeout | null = null;
let recoveryStarted = false;
let recoveryRunning = false;

function parseTelegramSourceAllowlist(raw: string | undefined): string[] {
    return (raw || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => normalizeSource(item).toLowerCase());
}

async function getTelegramSourceAllowlist(): Promise<string[]> {
    const envList = parseTelegramSourceAllowlist(process.env.TELEGRAM_ALLOWED_SOURCES || process.env.TELEGRAM_SOURCE_ALLOWLIST || '');
    if (envList.length > 0) return envList;
    const stored = await getSetting<string>('telegram_allowed_sources', '');
    return parseTelegramSourceAllowlist(stored || '');
}

async function assertTelegramSourceAllowed(source: string): Promise<void> {
    const normalized = normalizeSource(source).toLowerCase();
    const allowlist = await getTelegramSourceAllowlist();
    if (allowlist.length === 0) {
        // Empty allowlist keeps compatibility for public @usernames/links, but refuses numeric/private peers.
        if (/^-?\d+$/.test(normalized)) {
            throw new Error('未配置 Telegram 来源白名单，禁止使用数字 ID/私聊/私密群组来源。请配置 TELEGRAM_ALLOWED_SOURCES。');
        }
        return;
    }
    if (!allowlist.includes(normalized)) {
        throw new Error(`来源 ${source} 不在 Telegram 下载白名单中`);
    }
}

function maxProcessedMessageId(result: { successfulMessageIds: number[]; skippedMessageIds: number[] }): number {
    return Math.max(0, ...result.successfulMessageIds, ...result.skippedMessageIds);
}


function requireUserClient(): TelegramClient {
    const userClient = getTelegramUserClient();
    if (!userClient || !isTelegramUserClientReady()) {
        throw new Error('Telegram 用户账号下载器未就绪');
    }
    return userClient;
}

function normalizeSource(source: string): string {
    const trimmed = source.trim();
    if (!trimmed) throw new Error('频道不能为空');
    if (trimmed.startsWith('@') || /^-?\d+$/.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed;
    return `@${trimmed}`;
}

function getEntityTitle(entity: any, fallback: string): string {
    return entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || entity?.username || fallback;
}

function messageHasMedia(message: Api.Message | undefined): boolean {
    if (!message) return false;
    return Boolean(message.media || message.document || message.photo || message.video || message.audio || message.voice || message.sticker);
}

function normalizeHashtag(tagInput: string): string {
    const trimmed = tagInput.trim();
    if (!trimmed) throw new Error('标签不能为空');
    const withoutHash = trimmed.replace(/^#+/, '');
    if (!withoutHash || /\s/.test(withoutHash)) throw new Error('标签格式应为 #xxx，不能包含空格');
    return `#${withoutHash}`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageTextForTag(message: Api.Message | undefined): string {
    if (!message) return '';
    return [message.message, (message as any).text, (message as any).caption].filter(Boolean).join('\n');
}

function messageMatchesHashtag(message: Api.Message | undefined, normalizedTag: string): boolean {
    const body = messageTextForTag(message);
    if (!body) return false;
    const tag = escapeRegExp(normalizedTag.slice(1));
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])#${tag}(?![\\p{L}\\p{N}_])`, 'iu');
    return pattern.test(body);
}

async function getLatestMessageId(userClient: TelegramClient, source: string): Promise<number> {
    const [latest] = await userClient.getMessages(source as any, { limit: 1 });
    return latest?.id || 0;
}

async function getMessagesByDateRange(userClient: TelegramClient, source: string, startDate: Date, endDate: Date, maxScan = 5000): Promise<Api.Message[]> {
    const result: Api.Message[] = [];
    let offsetId = 0;

    while (result.length < maxScan) {
        const batch = await userClient.getMessages(source as any, { limit: Math.min(100, maxScan - result.length), offsetId });
        if (!batch.length) break;

        let reachedOlder = false;
        for (const message of batch) {
            offsetId = message.id;
            const messageDate = new Date((message.date || 0) * 1000);
            if (messageDate > endDate) continue;
            if (messageDate < startDate) {
                reachedOlder = true;
                break;
            }
            if (messageHasMedia(message)) result.push(message);
        }
        if (reachedOlder) break;
    }

    return result.sort((a, b) => a.id - b.id);
}

function messageGroupId(message: Api.Message | undefined): string | undefined {
    const groupedId = (message as any)?.groupedId;
    return groupedId ? groupedId.toString() : undefined;
}

async function expandMessagesWithMediaGroups(userClient: TelegramClient, source: string, messages: Api.Message[]): Promise<Api.Message[]> {
    const byId = new Map<number, Api.Message>();
    const seenGroups = new Set<string>();
    for (const message of messages) {
        if (messageHasMedia(message)) byId.set(message.id, message);
        const groupId = messageGroupId(message);
        if (!groupId || seenGroups.has(groupId)) continue;
        seenGroups.add(groupId);
        const ids = Array.from({ length: 41 }, (_, index) => message.id - 20 + index).filter(id => id > 0);
        const nearby = await userClient.getMessages(source as any, { ids });
        for (const candidate of nearby) {
            if (candidate && messageHasMedia(candidate) && messageGroupId(candidate) === groupId) {
                byId.set(candidate.id, candidate);
            }
        }
    }
    return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

function sourcePeerKey(value: unknown, fallback: string): string {
    if (value === undefined || value === null) return fallback;
    return String(value);
}

async function persistDownloadRefs(jobId: string, source: string, refs: TelegramDownloadMessageRef[], folderOverride?: string | null) {
    for (const ref of refs) {
        await query(
            `INSERT INTO telegram_download_items (
                job_id, source, source_peer, origin, message_id, grouped_id, channel_post_id,
                file_name, mime_type, total_size, folder_override, status, error, last_error, locked_at, completed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', NULL, NULL, NULL, NULL)
             ON CONFLICT (job_id, source_peer, message_id)
             DO UPDATE SET
                file_name = COALESCE(EXCLUDED.file_name, telegram_download_items.file_name),
                mime_type = COALESCE(EXCLUDED.mime_type, telegram_download_items.mime_type),
                total_size = COALESCE(EXCLUDED.total_size, telegram_download_items.total_size),
                folder_override = EXCLUDED.folder_override,
                updated_at = NOW()`,
            [
                jobId,
                source,
                sourcePeerKey(ref.source, source),
                ref.origin || 'channel',
                ref.id,
                null,
                ref.channelPostId || null,
                ref.fileInfo?.fileName || null,
                ref.fileInfo?.mimeType || null,
                ref.totalSize || 0,
                folderOverride || null,
            ]
        );
    }
}

interface TelegramDownloadScanSummary {
    source: string;
    mode: 'date' | 'tag';
    channelMessagesScanned: number;
    channelMediaFound: number;
    commentMessagesScanned: number;
    commentMediaFound: number;
    totalMediaFound: number;
    commentsEnabled: boolean;
    commentsMaxPerPost: number;
}

interface TelegramCommentScanOptions {
    includeComments?: boolean;
    commentsMaxPerPost?: number;
    onScanComplete?: (summary: TelegramDownloadScanSummary) => Promise<void> | void;
    onProgress?: (summary: TelegramJobProgressSummary) => Promise<void> | void;
    onRefDiscovered?: (ref: TelegramDownloadMessageRef) => Promise<void> | void;
}

export interface TelegramJobProgressSummary {
    jobId: string;
    source: string;
    mode: 'date' | 'tag';
    status: string;
    scanStatus: string;
    downloadStatus: string;
    channelMessagesScanned: number;
    channelMediaFound: number;
    commentMessagesScanned: number;
    commentMediaFound: number;
    totalMediaFound: number;
    completed: number;
    pending: number;
    downloading: number;
    failed: number;
    skipped: number;
    currentFileName?: string;
    cooldownUntil?: string | null;
}

interface TelegramDownloadScanResult {
    messages: Api.Message[];
    refs: TelegramDownloadMessageRef[];
    channelMediaFound: number;
    commentMessagesScanned: number;
    commentMediaFound: number;
}

async function getDiscussionMediaRefs(
    userClient: TelegramClient,
    source: string,
    postMessages: Api.Message[],
    options: TelegramCommentScanOptions & { tag?: string; startDate?: Date; endDate?: Date } = {},
): Promise<{ refs: TelegramDownloadMessageRef[]; scanned: number; mediaFound: number }> {
    if (!options.includeComments || postMessages.length === 0) {
        return { refs: [], scanned: 0, mediaFound: 0 };
    }

    const maxPerPost = Math.max(1, Math.floor(options.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST));
    const refs: TelegramDownloadMessageRef[] = [];
    let scanned = 0;
    let mediaFound = 0;
    const seen = new Set<string>();

    for (const post of postMessages) {
        const declaredReplies = Number((post as any).replies?.replies || 0);
        if (declaredReplies <= 0) continue;

        let offsetId = 0;
        let scannedForPost = 0;
        while (scannedForPost < maxPerPost) {
            const batch = await userClient.getMessages(source as any, {
                limit: Math.min(100, maxPerPost - scannedForPost),
                offsetId,
                replyTo: post.id,
            });
            if (!batch.length) break;

            for (const comment of batch) {
                if (!comment) continue;
                scanned += 1;
                scannedForPost += 1;
                offsetId = comment.id;

                if (options.startDate || options.endDate) {
                    const commentDate = new Date((comment.date || 0) * 1000);
                    if (options.startDate && commentDate < options.startDate) continue;
                    if (options.endDate && commentDate > options.endDate) continue;
                }
                if (options.tag && !messageMatchesHashtag(comment, options.tag)) continue;

                const fileInfo = extractFileInfo(comment);
                if (!fileInfo) continue;

                const sourceKey = `${comment.chatId?.toString() || source}:${comment.id}`;
                if (seen.has(sourceKey)) continue;
                seen.add(sourceKey);
                mediaFound += 1;
                const ref: TelegramDownloadMessageRef = {
                    id: comment.id,
                    source: comment.chatId || source,
                    origin: 'comment',
                    channelPostId: post.id,
                    fileInfo,
                    totalSize: getEstimatedFileSize(comment),
                    message: comment,
                };
                refs.push(ref);
                await options.onRefDiscovered?.(ref);
            }

            if (batch.length === 0 || scannedForPost >= maxPerPost) break;
        }
    }

    return { refs, scanned, mediaFound };
}

function toChannelDownloadRef(source: string, message: Api.Message): TelegramDownloadMessageRef | null {
    const fileInfo = extractFileInfo(message);
    if (!fileInfo) return null;
    return {
        id: message.id,
        source,
        origin: 'channel',
        fileInfo,
        totalSize: getEstimatedFileSize(message),
    };
}

async function buildDownloadScanResult(
    userClient: TelegramClient,
    source: string,
    messages: Api.Message[],
    options: TelegramCommentScanOptions & { tag?: string; startDate?: Date; endDate?: Date } = {},
): Promise<TelegramDownloadScanResult> {
    const refs = messages
        .map(message => toChannelDownloadRef(source, message))
        .filter((ref): ref is TelegramDownloadMessageRef => Boolean(ref));
    for (const ref of refs) {
        await options.onRefDiscovered?.(ref);
    }
    const commentScan = await getDiscussionMediaRefs(userClient, source, messages, options);
    refs.push(...commentScan.refs);
    return {
        messages,
        refs,
        channelMediaFound: refs.length,
        commentMessagesScanned: commentScan.scanned,
        commentMediaFound: commentScan.mediaFound,
    };
}

async function markDownloadRefsDownloading(jobId: string, refs: TelegramDownloadMessageRef[]) {
    for (const ref of refs) {
        const sourcePeer = sourcePeerKey(ref.source, ref.origin === 'comment' ? 'comment' : 'channel');
        await query(
            `UPDATE telegram_download_items
             SET status = 'downloading', locked_at = NOW(), updated_at = NOW()
             WHERE job_id = $1 AND source_peer = $2 AND message_id = $3
               AND status IN ('pending', 'failed')`,
            [jobId, sourcePeer, ref.id]
        );
    }
}

async function markDownloadRefStatus(jobId: string, ref: TelegramDownloadMessageRef, status: 'success' | 'failed' | 'skipped', error?: string) {
    const sourcePeer = sourcePeerKey(ref.source, ref.origin === 'comment' ? 'comment' : 'channel');
    await query(
        `UPDATE telegram_download_items
         SET status = $3,
             error = $4,
             last_error = $4,
             attempts = CASE WHEN $3 = 'failed' THEN attempts + 1 ELSE attempts END,
             completed_at = CASE WHEN $3 IN ('success', 'skipped') THEN NOW() ELSE completed_at END,
             locked_at = NULL,
             updated_at = NOW()
         WHERE job_id = $1 AND source_peer = $2 AND message_id = $5`,
        [jobId, sourcePeer, status, error || null, ref.id]
    );
}

async function persistDownloadMessages(jobId: string, source: string, messages: Api.Message[], folderOverride?: string | null) {
    const refs = messages
        .map(message => toChannelDownloadRef(source, message))
        .filter((ref): ref is TelegramDownloadMessageRef => Boolean(ref));
    await persistDownloadRefs(jobId, source, refs, folderOverride);
}

async function updateDownloadItemsStatus(jobId: string, messageIds: number[] | undefined, status: 'success' | 'failed' | 'skipped', error?: string) {
    const ids = Array.from(new Set((messageIds || []).filter(id => id > 0)));
    if (ids.length === 0) return;
    await query(
        `UPDATE telegram_download_items
         SET status = $2, error = $3, last_error = $3, updated_at = NOW(),
             completed_at = CASE WHEN $2 IN ('success', 'skipped') THEN NOW() ELSE completed_at END,
             locked_at = NULL
         WHERE job_id = $1 AND message_id = ANY($4::int[])`,
        [jobId, status, error || null, ids]
    );
}

export function parseDateOnly(value: string, endOfDay = false): Date {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new Error('日期格式必须是 YYYY-MM-DD');
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);

    return new Date(Date.UTC(
        year,
        month - 1,
        day,
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0,
    ));
}

async function createJob(userId: number, chatId: string | undefined, kind: string, source: string, params: Record<string, unknown>) {
    const result = await query(
        `INSERT INTO telegram_background_jobs (user_id, chat_id, kind, source, params, status, scan_status, download_status, scan_cursor)
         VALUES ($1, $2, $3, $4, $5, 'queued', 'pending', 'pending', '{}'::jsonb)
         RETURNING id`,
        [userId, chatId || null, kind, source, JSON.stringify(params)]
    );
    return result.rows[0].id as string;
}

async function getJob(jobId: string) {
    const result = await query(`SELECT * FROM telegram_background_jobs WHERE id = $1`, [jobId]);
    return result.rows[0] || null;
}

async function updateJob(jobId: string, updates: Record<string, unknown>) {
    const entries = Object.entries(updates);
    if (entries.length === 0) return;
    const setSql = entries.map(([key], index) => `${key} = $${index + 2}`).join(', ');
    await query(`UPDATE telegram_background_jobs SET ${setSql}, updated_at = NOW() WHERE id = $1`, [jobId, ...entries.map(([, value]) => value)]);
}

export async function subscribeTelegramChannel(userId: number, chatId: string | undefined, sourceInput: string, folderOverride?: string | null) {
    const userClient = requireUserClient();
    const source = normalizeSource(sourceInput);
    await assertTelegramSourceAllowed(source);
    const entity: any = await userClient.getEntity(source as any);
    const latestMessageId = await getLatestMessageId(userClient, source);
    const title = getEntityTitle(entity, source);

    const result = await query(
        `INSERT INTO telegram_channel_subscriptions (user_id, chat_id, source, title, last_message_id, folder_override, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (user_id, source)
         DO UPDATE SET chat_id = EXCLUDED.chat_id, title = EXCLUDED.title, folder_override = EXCLUDED.folder_override, enabled = true, updated_at = NOW()
         RETURNING id, source, title, last_message_id, folder_override, enabled`,
        [userId, chatId || null, source, title, latestMessageId, folderOverride || null]
    );
    return result.rows[0];
}

export async function listTelegramSubscriptions(userId: number, includeDisabled = false) {
    const result = await query(
        `SELECT id, source, title, last_message_id, folder_override, enabled, updated_at
         FROM telegram_channel_subscriptions
         WHERE user_id = $1
           AND ($2::boolean OR enabled = true)
         ORDER BY updated_at DESC`,
        [userId, includeDisabled]
    );
    return result.rows;
}

export async function updateTelegramSubscriptionFolder(userId: number, selector: string, folderOverride: string | null) {
    const trimmed = selector.trim();
    const result = await query(
        `UPDATE telegram_channel_subscriptions
         SET folder_override = $2, updated_at = NOW()
         WHERE user_id = $1 AND id::text LIKE $3 AND enabled = true
         RETURNING id, source, title, last_message_id, folder_override, enabled`,
        [userId, folderOverride || null, `${trimmed}%`]
    );
    return result.rows[0] || null;
}

export async function unsubscribeTelegramChannel(userId: number, selector: string) {
    const trimmed = selector.trim();
    const normalizedSelector = /^@|^https?:\/\//i.test(trimmed) || /^-?\d+$/.test(trimmed)
        ? normalizeSource(trimmed)
        : trimmed;
    const result = await query(
        `UPDATE telegram_channel_subscriptions
         SET enabled = false, updated_at = NOW()
         WHERE user_id = $1 AND (source = $2 OR id::text LIKE $3)
         RETURNING source, title`,
        [userId, normalizedSelector, `${trimmed}%`]
    );
    return result.rows[0] || null;
}


async function getJobItemStats(jobId: string) {
    const result = await query(
        `SELECT status, COUNT(*)::int AS count
         FROM telegram_download_items
         WHERE job_id = $1
         GROUP BY status`,
        [jobId]
    );
    const stats: Record<string, number> = { pending: 0, downloading: 0, success: 0, failed: 0, skipped: 0 };
    for (const row of result.rows) stats[row.status] = Number(row.count || 0);
    return stats;
}

async function getJobProgress(jobId: string): Promise<TelegramJobProgressSummary | null> {
    const job = await getJob(jobId);
    if (!job) return null;
    const params = job.params || {};
    const cursor = job.scan_cursor || params.scan || {};
    const stats = await getJobItemStats(jobId);
    return {
        jobId,
        source: job.source,
        mode: job.kind === 'tag_download' ? 'tag' : 'date',
        status: job.status,
        scanStatus: job.scan_status || 'pending',
        downloadStatus: job.download_status || 'pending',
        channelMessagesScanned: Number(cursor.channelMessagesScanned || 0),
        channelMediaFound: Number(cursor.channelMediaFound || 0),
        commentMessagesScanned: Number(cursor.commentMessagesScanned || 0),
        commentMediaFound: Number(cursor.commentMediaFound || 0),
        totalMediaFound: Number(job.total_count || 0),
        completed: Number(stats.success || 0),
        pending: Number(stats.pending || 0),
        downloading: Number(stats.downloading || 0),
        failed: Number(stats.failed || 0),
        skipped: Number(stats.skipped || 0),
        cooldownUntil: job.cooldown_until ? new Date(job.cooldown_until).toISOString() : null,
    };
}

async function notifyProgress(jobId: string, options: TelegramCommentScanOptions) {
    const progress = await getJobProgress(jobId);
    if (progress) await options.onProgress?.(progress);
}

function isFloodWait(error: unknown): { seconds: number } | null {
    const anyErr = error as any;
    const text = `${anyErr?.message || ''} ${anyErr?.errorMessage || ''}`;
    const seconds = Number(anyErr?.seconds || anyErr?.value || text.match(/FLOOD_WAIT_?(\d+)/i)?.[1] || 0);
    if (seconds > 0 || /FLOOD|Too many requests/i.test(text)) return { seconds: Math.max(30, seconds || 60) };
    return null;
}

async function ensureJobCanRun(jobId: string): Promise<'run' | 'paused' | 'cancelled' | 'cooldown'> {
    const job = await getJob(jobId);
    if (!job) return 'cancelled';
    if (job.cancelled_at || job.status === 'cancelled') return 'cancelled';
    if (job.paused_at || job.status === 'paused') return 'paused';
    if (job.cooldown_until && new Date(job.cooldown_until).getTime() > Date.now()) return 'cooldown';
    return 'run';
}

async function waitUntilRunnable(jobId: string, options: TelegramCommentScanOptions): Promise<boolean> {
    while (true) {
        const state = await ensureJobCanRun(jobId);
        if (state === 'run') return true;
        if (state === 'cancelled') return false;
        await notifyProgress(jobId, options);
        await new Promise(resolve => setTimeout(resolve, state === 'cooldown' ? 5000 : 2000));
    }
}

async function claimPendingDownloadRefs(jobId: string, limit = TG_JOB_DOWNLOAD_BATCH_SIZE): Promise<TelegramDownloadMessageRef[]> {
    const result = await query(
        `UPDATE telegram_download_items i
         SET status = 'downloading', locked_at = NOW(), updated_at = NOW()
         WHERE i.id IN (
             SELECT id FROM telegram_download_items
             WHERE job_id = $1 AND status = 'pending' AND attempts < $2
             ORDER BY created_at ASC
             LIMIT $3
         )
         RETURNING source, source_peer, origin, message_id, channel_post_id, file_name, mime_type, total_size, folder_override`,
        [jobId, TG_JOB_MAX_ATTEMPTS, limit]
    );
    return result.rows
        .filter(row => row.file_name && row.mime_type)
        .map(row => ({
            id: Number(row.message_id),
            source: row.source_peer || row.source,
            origin: row.origin === 'comment' ? 'comment' : 'channel',
            channelPostId: row.channel_post_id || undefined,
            fileInfo: { fileName: row.file_name, mimeType: row.mime_type },
            totalSize: Number(row.total_size || 0),
        }));
}

async function downloadClaimedRefs(botClient: TelegramClient, requestMessage: Api.Message, jobId: string, source: string, refs: TelegramDownloadMessageRef[], folderOverride: string | null | undefined, options: TelegramCommentScanOptions) {
    if (refs.length === 0) return { found: 0, skipped: 0, failed: 0, successful: 0 };
    await updateJob(jobId, { status: 'running', download_status: 'active', error: null });
    try {
        const result = await downloadTelegramChannelRange(botClient, requestMessage, source, 0, refs.length, 'older', refs.map(ref => ref.id), folderOverride, refs, async (ref, status, error) => {
            await markDownloadRefStatus(jobId, ref, status, error);
            await notifyProgress(jobId, options);
        });
        return result;
    } catch (error) {
        const flood = isFloodWait(error);
        if (flood) {
            const cooldownUntil = new Date(Date.now() + flood.seconds * 1000);
            await updateJob(jobId, { status: 'running', cooldown_until: cooldownUntil, error: `Telegram FloodWait，冷却到 ${cooldownUntil.toISOString()}` });
            for (const ref of refs) await markDownloadRefStatus(jobId, ref, 'failed', `FloodWait ${flood.seconds}s`);
            return { found: 0, skipped: 0, failed: refs.length, successful: 0 };
        }
        for (const ref of refs) await markDownloadRefStatus(jobId, ref, 'failed', error instanceof Error ? error.message : String(error));
        throw error;
    }
}

async function downloadPendingForJob(botClient: TelegramClient, requestMessage: Api.Message, jobId: string, source: string, folderOverride: string | null | undefined, options: TelegramCommentScanOptions, drain = false) {
    let aggregate = { found: 0, skipped: 0, failed: 0, successful: 0 };
    while (await waitUntilRunnable(jobId, options)) {
        const refs = await claimPendingDownloadRefs(jobId);
        if (refs.length === 0) break;
        const result = await downloadClaimedRefs(botClient, requestMessage, jobId, source, refs, folderOverride, options);
        aggregate = {
            found: aggregate.found + (result.found || 0),
            skipped: aggregate.skipped + (result.skipped || 0),
            failed: aggregate.failed + (result.failed || 0),
            successful: aggregate.successful + (result.successful || 0),
        };
        if (!drain) break;
    }
    return aggregate;
}

async function finalizeTelegramJob(jobId: string, options: TelegramCommentScanOptions) {
    const stats = await getJobItemStats(jobId);
    const pending = Number(stats.pending || 0) + Number(stats.downloading || 0);
    const failed = Number(stats.failed || 0);
    const status = pending > 0 ? 'running' : failed > 0 ? 'completed_with_errors' : 'completed';
    await updateJob(jobId, {
        status,
        download_status: pending > 0 ? 'active' : 'done',
        enqueued_count: Number(stats.success || 0),
        skipped_count: Number(stats.skipped || 0),
        error: failed > 0 ? `${failed} 个文件下载失败` : null,
        finished_at: pending > 0 ? null : new Date(),
    });
    await notifyProgress(jobId, options);
}

async function scanChannelSegment(userClient: TelegramClient, jobId: string, source: string, params: any, cursor: any, options: TelegramCommentScanOptions): Promise<{ messages: Api.Message[]; done: boolean; nextOffsetId: number }> {
    const mode = params.mode as 'date' | 'tag';
    const offsetId = Number(cursor.offsetId || 0);
    const batch = await userClient.getMessages(source as any, {
        limit: TG_JOB_SCAN_SEGMENT_SIZE,
        offsetId,
        ...(mode === 'tag' ? { search: params.tag } : {}),
    });
    if (!batch.length) return { messages: [], done: true, nextOffsetId: offsetId };
    let done = false;
    let nextOffsetId = offsetId;
    const matched: Api.Message[] = [];
    for (const message of batch) {
        nextOffsetId = message.id;
        if (mode === 'date') {
            const messageDate = new Date((message.date || 0) * 1000);
            const startDate = new Date(params.startDateIso);
            const endDate = new Date(params.endDateIso);
            if (messageDate > endDate) continue;
            if (messageDate < startDate) { done = true; break; }
            if (messageHasMedia(message)) matched.push(message);
        } else if (messageHasMedia(message) && messageMatchesHashtag(message, params.tag)) {
            matched.push(message);
        }
    }
    const expanded = await expandMessagesWithMediaGroups(userClient, source, matched);
    return { messages: expanded, done: done || batch.length < TG_JOB_SCAN_SEGMENT_SIZE, nextOffsetId };
}

async function runSegmentedTelegramJob(botClient: TelegramClient, requestMessage: Api.Message, jobId: string, source: string, folderOverride: string | null | undefined, options: TelegramCommentScanOptions) {
    const userClient = requireUserClient();
    const job = await getJob(jobId);
    const params = job?.params || {};
    let cursor = job?.scan_cursor || {};
    const discoveredRefKeys = new Set<string>();
    let totals = { found: 0, skipped: 0, failed: 0, successful: 0 };
    await updateJob(jobId, { status: 'running', scan_status: 'scanning', download_status: 'active', started_at: job?.started_at || new Date(), error: null });

    while (await waitUntilRunnable(jobId, options)) {
        const current = await getJob(jobId);
        cursor = current?.scan_cursor || cursor || {};
        if (current?.scan_status === 'done') break;
        try {
            const segment = await scanChannelSegment(userClient, jobId, source, params, cursor, options);
            const onRefDiscovered = async (ref: TelegramDownloadMessageRef) => {
                const key = `${sourcePeerKey(ref.source, source)}:${ref.id}`;
                if (discoveredRefKeys.has(key)) return;
                discoveredRefKeys.add(key);
                await persistDownloadRefs(jobId, source, [ref], folderOverride);
            };
            const scan = await buildDownloadScanResult(userClient, source, segment.messages, {
                ...options,
                tag: params.tag,
                startDate: params.startDateIso ? new Date(params.startDateIso) : undefined,
                endDate: params.endDateIso ? new Date(params.endDateIso) : undefined,
                onRefDiscovered,
            });
            cursor = {
                ...cursor,
                phase: segment.done ? 'done' : 'channel',
                offsetId: segment.nextOffsetId,
                channelMessagesScanned: Number(cursor.channelMessagesScanned || 0) + segment.messages.length,
                channelMediaFound: Number(cursor.channelMediaFound || 0) + scan.channelMediaFound,
                commentMessagesScanned: Number(cursor.commentMessagesScanned || 0) + scan.commentMessagesScanned,
                commentMediaFound: Number(cursor.commentMediaFound || 0) + scan.commentMediaFound,
            };
            const stats = await getJobItemStats(jobId);
            await updateJob(jobId, { scan_cursor: JSON.stringify(cursor), total_count: Number(stats.pending || 0) + Number(stats.downloading || 0) + Number(stats.success || 0) + Number(stats.failed || 0) + Number(stats.skipped || 0), scan_status: segment.done ? 'done' : 'scanning' });
            await notifyProgress(jobId, options);
            const partial = await downloadPendingForJob(botClient, requestMessage, jobId, source, folderOverride, options, false);
            totals = { found: totals.found + partial.found, skipped: totals.skipped + partial.skipped, failed: totals.failed + partial.failed, successful: totals.successful + partial.successful };
            if (segment.done) break;
        } catch (error) {
            const flood = isFloodWait(error);
            if (!flood) throw error;
            const cooldownUntil = new Date(Date.now() + flood.seconds * 1000);
            await updateJob(jobId, { cooldown_until: cooldownUntil, error: `Telegram FloodWait，冷却到 ${cooldownUntil.toISOString()}` });
        }
    }

    const runnable = await waitUntilRunnable(jobId, options);
    if (!runnable) {
        await updateJob(jobId, { status: 'cancelled', scan_status: 'cancelled', download_status: 'cancelled', finished_at: new Date() });
        return { jobId, ...totals, requested: 0, commentMessagesScanned: Number(cursor.commentMessagesScanned || 0), commentMediaFound: Number(cursor.commentMediaFound || 0) };
    }
    await updateJob(jobId, { scan_status: 'done' });
    const drained = await downloadPendingForJob(botClient, requestMessage, jobId, source, folderOverride, options, true);
    totals = { found: totals.found + drained.found, skipped: totals.skipped + drained.skipped, failed: totals.failed + drained.failed, successful: totals.successful + drained.successful };
    await finalizeTelegramJob(jobId, options);
    return { jobId, ...totals, requested: totals.found + totals.skipped, commentMessagesScanned: Number(cursor.commentMessagesScanned || 0), commentMediaFound: Number(cursor.commentMediaFound || 0) };
}

export async function enqueueTelegramDateDownload(botClient: TelegramClient, requestMessage: Api.Message, userId: number, sourceInput: string, startDateText: string, endDateText: string, folderOverride?: string | null, options: TelegramCommentScanOptions = {}) {
    const source = normalizeSource(sourceInput);
    await assertTelegramSourceAllowed(source);
    const startDate = parseDateOnly(startDateText);
    const endDate = parseDateOnly(endDateText, true);
    if (startDate > endDate) throw new Error('开始日期不能晚于结束日期');

    const jobId = await createJob(userId, requestMessage.chatId?.toString(), 'date_range', source, {
        mode: 'date',
        startDate: startDateText,
        endDate: endDateText,
        startDateIso: startDate.toISOString(),
        endDateIso: endDate.toISOString(),
        folderOverride: folderOverride || null,
        includeComments: Boolean(options.includeComments),
        commentsMaxPerPost: options.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
    });
    return runSegmentedTelegramJob(botClient, requestMessage, jobId, source, folderOverride, options);
}

async function getMessagesByHashtag(userClient: TelegramClient, source: string, tag: string, maxScan = 10000): Promise<Api.Message[]> {
    const normalizedTag = normalizeHashtag(tag);
    const result: Api.Message[] = [];
    let offsetId = 0;

    while (result.length < maxScan) {
        const batch = await userClient.getMessages(source as any, {
            limit: Math.min(100, maxScan - result.length),
            offsetId,
            search: normalizedTag,
        });
        if (!batch.length) break;

        for (const message of batch) {
            offsetId = message.id;
            if (messageHasMedia(message) && messageMatchesHashtag(message, normalizedTag)) {
                result.push(message);
            }
        }
    }

    return result.sort((a, b) => a.id - b.id);
}

export async function enqueueTelegramTagDownload(botClient: TelegramClient, requestMessage: Api.Message, userId: number, sourceInput: string, tagInput: string, folderOverride?: string | null, options: TelegramCommentScanOptions = {}) {
    const source = normalizeSource(sourceInput);
    await assertTelegramSourceAllowed(source);
    const tag = normalizeHashtag(tagInput);

    const jobId = await createJob(userId, requestMessage.chatId?.toString(), 'tag_download', source, {
        mode: 'tag',
        tag,
        folderOverride: folderOverride || null,
        includeComments: Boolean(options.includeComments),
        commentsMaxPerPost: options.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
    });
    const result = await runSegmentedTelegramJob(botClient, requestMessage, jobId, source, folderOverride, options);
    return { ...result, tag };
}

export async function listTelegramBackgroundJobs(userId: number, limit = 10) {
    const result = await query(
        `SELECT id, kind, source, status, scan_status, download_status, scan_cursor, cooldown_until, paused_at, cancelled_at, total_count, enqueued_count, skipped_count, duplicate_count, error, created_at, updated_at
         FROM telegram_background_jobs
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
    );
    return result.rows;
}


export async function pauseTelegramBackgroundJob(userId: number, selector: string) {
    const result = await query(
        `UPDATE telegram_background_jobs
         SET status = 'paused', paused_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND id::text LIKE $2 AND status NOT IN ('completed', 'cancelled')
         RETURNING id, source, status`,
        [userId, `${selector}%`]
    );
    return result.rows[0] || null;
}

export async function resumeTelegramBackgroundJob(userId: number, selector: string) {
    const result = await query(
        `UPDATE telegram_background_jobs
         SET status = 'running', paused_at = NULL, updated_at = NOW()
         WHERE user_id = $1 AND id::text LIKE $2 AND status = 'paused'
         RETURNING id, source, status`,
        [userId, `${selector}%`]
    );
    return result.rows[0] || null;
}

export async function cancelTelegramBackgroundJob(userId: number, selector: string) {
    const result = await query(
        `UPDATE telegram_background_jobs
         SET status = 'cancelled', scan_status = 'cancelled', download_status = 'cancelled', cancelled_at = NOW(), finished_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND id::text LIKE $2 AND status NOT IN ('completed', 'cancelled')
         RETURNING id, source, status`,
        [userId, `${selector}%`]
    );
    if (result.rows[0]) {
        await query(`UPDATE telegram_download_items SET status = 'skipped', locked_at = NULL, updated_at = NOW() WHERE job_id = $1 AND status IN ('pending', 'downloading')`, [result.rows[0].id]);
    }
    return result.rows[0] || null;
}

export async function retryTelegramBackgroundJob(userId: number, selector: string) {
    const result = await query(
        `SELECT id FROM telegram_background_jobs WHERE user_id = $1 AND id::text LIKE $2 LIMIT 1`,
        [userId, `${selector}%`]
    );
    const row = result.rows[0];
    if (!row) return null;
    const retry = await query(
        `UPDATE telegram_download_items
         SET status = 'pending', locked_at = NULL, last_error = NULL, error = NULL, updated_at = NOW()
         WHERE job_id = $1 AND status = 'failed'
         RETURNING id`,
        [row.id]
    );
    await updateJob(row.id, { status: 'running', download_status: 'active', error: null, finished_at: null });
    return { id: row.id, retried: retry.rowCount || 0 };
}

async function runSubscriptionScan(botClient: TelegramClient) {
    const userClient = getTelegramUserClient();
    if (!userClient || !isTelegramUserClientReady()) return;

    const result = await query(
        `SELECT id, user_id, chat_id, source, last_message_id, folder_override
         FROM telegram_channel_subscriptions
         WHERE enabled = true
         ORDER BY updated_at ASC`
    );

    for (const row of result.rows) {
        try {
            await assertTelegramSourceAllowed(row.source);
            const latestMessageId = await getLatestMessageId(userClient, row.source);
            const lastMessageId = Number(row.last_message_id || 0);
            if (!latestMessageId || latestMessageId <= lastMessageId) continue;

            const count = Math.min(SUBSCRIPTION_SCAN_LIMIT, latestMessageId - lastMessageId);
            const ids = Array.from({ length: count }, (_, index) => lastMessageId + index + 1);
            const jobId = await createJob(Number(row.user_id), row.chat_id?.toString(), 'subscription_sync', row.source, { fromId: lastMessageId + 1, toId: latestMessageId });
            const candidateMessages = await expandMessagesWithMediaGroups(userClient, row.source, (await userClient.getMessages(row.source as any, { ids })).filter(Boolean) as Api.Message[]);
            await persistDownloadMessages(jobId, row.source, candidateMessages, row.folder_override || null);
            await updateJob(jobId, { status: 'running', started_at: new Date(), total_count: ids.length });

            const targetChat = row.chat_id || row.user_id;
            const requestMessage = ({ chatId: targetChat, id: latestMessageId } as unknown) as Api.Message;
            const subscriptionRefs = candidateMessages
                .map(message => toChannelDownloadRef(row.source, message))
                .filter((ref): ref is TelegramDownloadMessageRef => Boolean(ref));
            await markDownloadRefsDownloading(jobId, subscriptionRefs);
            const downloadResult = await downloadTelegramChannelRange(botClient, requestMessage, row.source, 0, ids.length, 'newer', ids, row.folder_override || null, subscriptionRefs, (ref, status, error) => markDownloadRefStatus(jobId, ref, status, error));
            await updateJob(jobId, {
                status: downloadResult.failed > 0 ? 'completed_with_errors' : 'completed',
                enqueued_count: downloadResult.found,
                skipped_count: downloadResult.skipped,
                error: downloadResult.failed > 0 ? `${downloadResult.failed} 个文件下载失败` : null,
                finished_at: new Date(),
            });
            const scannedMaxId = ids.length > 0 ? ids[ids.length - 1] : lastMessageId;
            const safeAdvanceId = downloadResult.failed > 0 ? Math.max(lastMessageId, maxProcessedMessageId(downloadResult)) : scannedMaxId;
            await query('UPDATE telegram_channel_subscriptions SET last_message_id = $1, updated_at = NOW() WHERE id = $2', [safeAdvanceId, row.id]);
            if (downloadResult.found > 0) {
                await botClient.sendMessage(targetChat, { message: `✅ 订阅 ${row.source} 已同步 ${downloadResult.found} 个新文件，跳过 ${downloadResult.skipped} 条${downloadResult.failed ? `，失败 ${downloadResult.failed} 条` : ''}${safeAdvanceId < latestMessageId ? '。本轮达到扫描上限或存在失败项，剩余将在后续继续处理。' : '。'}` }).catch(() => undefined);
            }
        } catch (error) {
            console.error('🤖 Telegram 订阅同步失败:', error);
        }
    }
}

async function recoverTelegramJob(botClient: TelegramClient, job: any): Promise<void> {
    const itemResult = await query(
        `SELECT id, source, source_peer, origin, message_id, channel_post_id, file_name, mime_type, total_size, folder_override
         FROM telegram_download_items
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY created_at ASC`,
        [job.id]
    );
    if (itemResult.rows.length === 0) return;

    const refs: TelegramDownloadMessageRef[] = itemResult.rows
        .filter(row => row.file_name && row.mime_type)
        .map(row => ({
            id: Number(row.message_id),
            source: row.source_peer || row.source,
            origin: row.origin === 'comment' ? 'comment' : 'channel',
            channelPostId: row.channel_post_id || undefined,
            fileInfo: { fileName: row.file_name, mimeType: row.mime_type },
            totalSize: Number(row.total_size || 0),
        }));

    if (refs.length === 0) return;

    const targetChat = job.chat_id || job.user_id;
    const requestMessage = ({ chatId: targetChat, id: 0 } as unknown) as Api.Message;
    console.log(`♻️ 恢复 Telegram 下载任务 ${String(job.id).slice(0, 8)}，待处理 ${refs.length} 个文件`);
    await updateJob(job.id, { status: 'running', started_at: job.started_at || new Date(), error: null });

    try {
        const result = await downloadTelegramChannelRange(
            botClient,
            requestMessage,
            job.source,
            0,
            refs.length,
            'older',
            refs.map(ref => ref.id),
            itemResult.rows[0]?.folder_override || null,
            refs,
            (ref, status, error) => markDownloadRefStatus(job.id, ref, status, error),
        );
        await updateJob(job.id, {
            status: result.failed > 0 ? 'completed_with_errors' : 'completed',
            enqueued_count: result.found,
            skipped_count: result.skipped,
            error: result.failed > 0 ? `${result.failed} 个文件下载失败` : null,
            finished_at: new Date(),
        });
        await botClient.sendMessage(targetChat, {
            message: `♻️ 已恢复并完成任务 ${String(job.id).slice(0, 8)}：成功 ${result.successful}，跳过 ${result.skipped}，失败 ${result.failed}`,
        }).catch(() => undefined);
    } catch (error) {
        await updateJob(job.id, { status: 'failed', error: error instanceof Error ? error.message : String(error), finished_at: new Date() });
        throw error;
    }
}

export async function recoverInterruptedTelegramJobs(botClient: TelegramClient): Promise<void> {
    if (recoveryRunning) return;
    recoveryRunning = true;
    try {
        await query(
            `UPDATE telegram_download_items
             SET status = 'pending', locked_at = NULL, updated_at = NOW()
             WHERE status = 'downloading'
               AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '30 minutes')`
        );
        const jobs = await query(
            `SELECT DISTINCT j.*
             FROM telegram_background_jobs j
             JOIN telegram_download_items i ON i.job_id = j.id
             WHERE j.kind IN ('date_range', 'tag_download')
               AND j.status IN ('pending', 'running', 'failed', 'completed_with_errors')
               AND i.status = 'pending'
             ORDER BY j.created_at ASC
             LIMIT 5`
        );
        for (const job of jobs.rows) {
            if (job.scan_status !== 'done' && (job.kind === 'date_range' || job.kind === 'tag_download') && job.params?.mode) {
                const targetChat = job.chat_id || job.user_id;
                const requestMessage = ({ chatId: targetChat, id: 0 } as unknown) as Api.Message;
                await runSegmentedTelegramJob(botClient, requestMessage, job.id, job.source, job.params?.folderOverride || null, {}).catch(error => console.error('♻️ Telegram 分段任务恢复失败:', error));
            } else {
                await recoverTelegramJob(botClient, job).catch(error => console.error('♻️ Telegram 任务恢复失败:', error));
            }
        }
    } finally {
        recoveryRunning = false;
    }
}

export function startTelegramJobRecoveryWorker(botClient: TelegramClient) {
    if (recoveryStarted) return;
    recoveryStarted = true;
    setTimeout(() => recoverInterruptedTelegramJobs(botClient).catch(error => console.error('♻️ Telegram 任务恢复扫描失败:', error)), TG_JOB_RECOVERY_DELAY_MS);
    setInterval(() => recoverInterruptedTelegramJobs(botClient).catch(error => console.error('♻️ Telegram 任务恢复扫描失败:', error)), SUBSCRIPTION_INTERVAL_MS);
}

export function startTelegramSubscriptionWorker(botClient: TelegramClient) {
    if (subscriptionTimer) return;
    subscriptionTimer = setInterval(() => {
        runSubscriptionScan(botClient).catch(error => console.error('🤖 Telegram 订阅扫描异常:', error));
    }, SUBSCRIPTION_INTERVAL_MS);
    runSubscriptionScan(botClient).catch(error => console.error('🤖 Telegram 订阅扫描异常:', error));
    console.log(`🤖 Telegram 频道订阅扫描已启动，间隔 ${Math.round(SUBSCRIPTION_INTERVAL_MS / 1000)} 秒`);
}
