import { Api, TelegramClient } from 'telegram';
import { query } from '../db/index.js';
import { storageManager } from './storage.js';
import { getTelegramUserClient, isTelegramUserClientReady } from './telegramUserClient.js';
import { downloadTelegramChannelRange, getTelegramDownloadPreview } from './telegramUpload.js';

const SUBSCRIPTION_INTERVAL_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_SUBSCRIPTION_INTERVAL_MS || '300000', 10) || 300_000);
const SUBSCRIPTION_SCAN_LIMIT = Math.max(1, parseInt(process.env.TELEGRAM_SUBSCRIPTION_SCAN_LIMIT || '100', 10) || 100);
let subscriptionTimer: NodeJS.Timeout | null = null;

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

async function persistDownloadItems(jobId: string, source: string, messages: Api.Message[]) {
    for (const message of messages) {
        await query(
            `INSERT INTO telegram_download_items (job_id, source, message_id, grouped_id, status)
             VALUES ($1, $2, $3, $4, 'pending')
             ON CONFLICT (job_id, message_id) DO NOTHING`,
            [jobId, source, message.id, messageGroupId(message) || null]
        );
    }
}

async function updateDownloadItemsStatus(jobId: string, messageIds: number[] | undefined, status: 'success' | 'failed' | 'skipped', error?: string) {
    const ids = Array.from(new Set((messageIds || []).filter(id => id > 0)));
    if (ids.length === 0) return;
    await query(
        `UPDATE telegram_download_items
         SET status = $2, error = $3, updated_at = NOW()
         WHERE job_id = $1 AND message_id = ANY($4::int[])`,
        [jobId, status, error || null, ids]
    );
}

function parseDateOnly(value: string, endOfDay = false): Date {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new Error('日期格式必须是 YYYY-MM-DD');
    const [, year, month, day] = match;
    return new Date(`${year}-${month}-${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
}

async function createJob(userId: number, chatId: string | undefined, kind: string, source: string, params: Record<string, unknown>) {
    const result = await query(
        `INSERT INTO telegram_background_jobs (user_id, chat_id, kind, source, params)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [userId, chatId || null, kind, source, JSON.stringify(params)]
    );
    return result.rows[0].id as string;
}

async function updateJob(jobId: string, updates: Record<string, unknown>) {
    const entries = Object.entries(updates);
    if (entries.length === 0) return;
    const setSql = entries.map(([key], index) => `${key} = $${index + 2}`).join(', ');
    await query(`UPDATE telegram_background_jobs SET ${setSql}, updated_at = NOW() WHERE id = $1`, [jobId, ...entries.map(([, value]) => value)]);
}

export async function subscribeTelegramChannel(userId: number, chatId: string | undefined, sourceInput: string) {
    const userClient = requireUserClient();
    const source = normalizeSource(sourceInput);
    const entity: any = await userClient.getEntity(source as any);
    const latestMessageId = await getLatestMessageId(userClient, source);
    const title = getEntityTitle(entity, source);

    const result = await query(
        `INSERT INTO telegram_channel_subscriptions (user_id, chat_id, source, title, last_message_id, enabled)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (user_id, source)
         DO UPDATE SET chat_id = EXCLUDED.chat_id, title = EXCLUDED.title, enabled = true, updated_at = NOW()
         RETURNING id, source, title, last_message_id, enabled`,
        [userId, chatId || null, source, title, latestMessageId]
    );
    return result.rows[0];
}

export async function listTelegramSubscriptions(userId: number, includeDisabled = false) {
    const result = await query(
        `SELECT id, source, title, last_message_id, enabled, updated_at
         FROM telegram_channel_subscriptions
         WHERE user_id = $1
           AND ($2::boolean OR enabled = true)
         ORDER BY updated_at DESC`,
        [userId, includeDisabled]
    );
    return result.rows;
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

export async function enqueueTelegramDateDownload(botClient: TelegramClient, requestMessage: Api.Message, userId: number, sourceInput: string, startDateText: string, endDateText: string) {
    const userClient = requireUserClient();
    const source = normalizeSource(sourceInput);
    const startDate = parseDateOnly(startDateText);
    const endDate = parseDateOnly(endDateText, true);
    if (startDate > endDate) throw new Error('开始日期不能晚于结束日期');

    const baseMessages = await getMessagesByDateRange(userClient, source, startDate, endDate);
    const messages = await expandMessagesWithMediaGroups(userClient, source, baseMessages);
    const messageIds = messages.map(message => message.id);
    const jobId = await createJob(userId, requestMessage.chatId?.toString(), 'date_range', source, { startDate: startDateText, endDate: endDateText, messageIds });
    await persistDownloadItems(jobId, source, messages);
    await updateJob(jobId, { status: 'running', started_at: new Date(), total_count: messages.length });

    try {
        const result = await downloadTelegramChannelRange(botClient, requestMessage, source, 0, messages.length, 'older', messages.map(message => message.id));
        await updateDownloadItemsStatus(jobId, result.successfulMessageIds, 'success');
        await updateDownloadItemsStatus(jobId, result.failedMessageIds, 'failed', '下载失败');
        await updateDownloadItemsStatus(jobId, result.skippedMessageIds, 'skipped');
        await updateJob(jobId, {
            status: result.failed > 0 ? 'completed_with_errors' : 'completed',
            enqueued_count: result.found,
            skipped_count: result.skipped,
            error: result.failed > 0 ? `${result.failed} 个文件下载失败` : null,
            finished_at: new Date(),
        });
        return { jobId, ...result };
    } catch (error) {
        await updateJob(jobId, { status: 'failed', error: error instanceof Error ? error.message : String(error), finished_at: new Date() });
        throw error;
    }
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

export async function enqueueTelegramTagDownload(botClient: TelegramClient, requestMessage: Api.Message, userId: number, sourceInput: string, tagInput: string) {
    const userClient = requireUserClient();
    const source = normalizeSource(sourceInput);
    const tag = normalizeHashtag(tagInput);

    const baseMessages = await getMessagesByHashtag(userClient, source, tag);
    const messages = await expandMessagesWithMediaGroups(userClient, source, baseMessages);
    const messageIds = messages.map(message => message.id);
    const jobId = await createJob(userId, requestMessage.chatId?.toString(), 'tag_download', source, { tag, messageIds });
    await persistDownloadItems(jobId, source, messages);
    await updateJob(jobId, { status: 'running', started_at: new Date(), total_count: messages.length });

    try {
        const result = await downloadTelegramChannelRange(botClient, requestMessage, source, 0, messages.length, 'older', messages.map(message => message.id));
        await updateDownloadItemsStatus(jobId, result.successfulMessageIds, 'success');
        await updateDownloadItemsStatus(jobId, result.failedMessageIds, 'failed', '下载失败');
        await updateDownloadItemsStatus(jobId, result.skippedMessageIds, 'skipped');
        await updateJob(jobId, {
            status: result.failed > 0 ? 'completed_with_errors' : 'completed',
            enqueued_count: result.found,
            skipped_count: result.skipped,
            error: result.failed > 0 ? `${result.failed} 个文件下载失败` : null,
            finished_at: new Date(),
        });
        return { jobId, tag, ...result };
    } catch (error) {
        await updateJob(jobId, { status: 'failed', error: error instanceof Error ? error.message : String(error), finished_at: new Date() });
        throw error;
    }
}

export async function listTelegramBackgroundJobs(userId: number, limit = 10) {
    const result = await query(
        `SELECT id, kind, source, status, total_count, enqueued_count, skipped_count, duplicate_count, error, created_at, updated_at
         FROM telegram_background_jobs
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
    );
    return result.rows;
}

async function runSubscriptionScan(botClient: TelegramClient) {
    const userClient = getTelegramUserClient();
    if (!userClient || !isTelegramUserClientReady()) return;

    const result = await query(
        `SELECT id, user_id, chat_id, source, last_message_id
         FROM telegram_channel_subscriptions
         WHERE enabled = true
         ORDER BY updated_at ASC`
    );

    for (const row of result.rows) {
        try {
            const latestMessageId = await getLatestMessageId(userClient, row.source);
            const lastMessageId = Number(row.last_message_id || 0);
            if (!latestMessageId || latestMessageId <= lastMessageId) continue;

            const count = Math.min(SUBSCRIPTION_SCAN_LIMIT, latestMessageId - lastMessageId);
            const ids = Array.from({ length: count }, (_, index) => lastMessageId + index + 1);
            const jobId = await createJob(Number(row.user_id), row.chat_id?.toString(), 'subscription_sync', row.source, { fromId: lastMessageId + 1, toId: latestMessageId });
            const candidateMessages = await expandMessagesWithMediaGroups(userClient, row.source, (await userClient.getMessages(row.source as any, { ids })).filter(Boolean) as Api.Message[]);
            await persistDownloadItems(jobId, row.source, candidateMessages);
            await updateJob(jobId, { status: 'running', started_at: new Date(), total_count: ids.length });

            const targetChat = row.chat_id || row.user_id;
            const requestMessage = ({ chatId: targetChat, id: latestMessageId } as unknown) as Api.Message;
            const downloadResult = await downloadTelegramChannelRange(botClient, requestMessage, row.source, 0, ids.length, 'newer', ids);
            await updateDownloadItemsStatus(jobId, downloadResult.successfulMessageIds, 'success');
            await updateDownloadItemsStatus(jobId, downloadResult.failedMessageIds, 'failed', '下载失败');
            await updateDownloadItemsStatus(jobId, downloadResult.skippedMessageIds, 'skipped');
            await updateJob(jobId, {
                status: downloadResult.failed > 0 ? 'completed_with_errors' : 'completed',
                enqueued_count: downloadResult.found,
                skipped_count: downloadResult.skipped,
                error: downloadResult.failed > 0 ? `${downloadResult.failed} 个文件下载失败` : null,
                finished_at: new Date(),
            });
            await query('UPDATE telegram_channel_subscriptions SET last_message_id = $1, updated_at = NOW() WHERE id = $2', [latestMessageId, row.id]);
            if (downloadResult.found > 0) {
                await botClient.sendMessage(targetChat, { message: `✅ 订阅 ${row.source} 已同步 ${downloadResult.found} 个新文件，跳过 ${downloadResult.skipped} 条。` }).catch(() => undefined);
            }
        } catch (error) {
            console.error('🤖 Telegram 订阅同步失败:', error);
        }
    }
}

export function startTelegramSubscriptionWorker(botClient: TelegramClient) {
    if (subscriptionTimer) return;
    subscriptionTimer = setInterval(() => {
        runSubscriptionScan(botClient).catch(error => console.error('🤖 Telegram 订阅扫描异常:', error));
    }, SUBSCRIPTION_INTERVAL_MS);
    runSubscriptionScan(botClient).catch(error => console.error('🤖 Telegram 订阅扫描异常:', error));
    console.log(`🤖 Telegram 频道订阅扫描已启动，间隔 ${Math.round(SUBSCRIPTION_INTERVAL_MS / 1000)} 秒`);
}
