import { Api, TelegramClient } from 'telegram';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPeerId } from 'telegram/Utils.js';
import { pool, query } from '../db/index.js';
import { storageManager, isStorageQuotaCooldownError } from './storage.js';
import { formatStorageCooldownNotice } from './storageCooldownGuard.js';
import {
    clearExpiredStorageCooldowns,
    getStorageAccountCooldown,
    markStorageAccountCooldown,
    STORAGE_COOLDOWN_REASON_DAILY_UPLOAD_LIMIT,
    type StorageAccountCooldown,
} from './storageCooldown.js';
import { getTelegramUserClient, isTelegramUserClientReady } from './telegramUserClient.js';
import { recordTelegramUserClientFailure } from './telegramUserClientStatus.js';
import { abortChannelExecutionForLeaseLoss, downloadTelegramChannelRange, getTelegramDownloadPreview, getChannelTaskAbortSignal, releaseChannelTaskAbortSignal, type TelegramDownloadMessageRef } from './telegramUpload.js';
import { getSetting } from '../utils/settings.js';
import { extractFileInfo, getEstimatedFileSize, type TelegramFileInfo } from '../utils/telegramMedia.js';
import { annotateTelegramMediaGroup } from '../utils/telegramMediaGroup.js';
import { lockStorageAccountForUse } from './storageAccountLifecycle.js';
import { resolveTelegramWriteCommittedWithQuery, claimTelegramWriteReconciliations, resolveClaimedTelegramWrite } from './telegramWriteReconciliation.js';

const SUBSCRIPTION_INTERVAL_MS = Math.max(60_000, parseInt(process.env.TELEGRAM_SUBSCRIPTION_INTERVAL_MS || '300000', 10) || 300_000);
const SUBSCRIPTION_SCAN_LIMIT = Math.max(1, parseInt(process.env.TELEGRAM_SUBSCRIPTION_SCAN_LIMIT || '100', 10) || 100);
const TG_JOB_RECOVERY_DELAY_MS = Math.max(1000, parseInt(process.env.TG_JOB_RECOVERY_DELAY_MS || '10000', 10) || 10_000);
const TG_JOB_SCAN_SEGMENT_SIZE = Math.max(20, parseInt(process.env.TG_JOB_SCAN_SEGMENT_SIZE || '100', 10) || 100);
const TG_JOB_DOWNLOAD_BATCH_SIZE = Math.max(1, parseInt(process.env.TG_JOB_DOWNLOAD_BATCH_SIZE || '20', 10) || 20);
const TG_JOB_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.TG_JOB_MAX_ATTEMPTS || '3', 10) || 3);
export const TELEGRAM_COMMENTS_MAX_PER_POST = Math.max(1, parseInt(process.env.TELEGRAM_COMMENTS_MAX_PER_POST || '200', 10) || 200);
let subscriptionTimer: NodeJS.Timeout | null = null;
let subscriptionScanRunning = false;
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

async function assertTelegramSourceAllowed(source: string, extraSources: string[] = []): Promise<void> {
    const normalized = normalizeSource(source).toLowerCase();
    const normalizedExtras = extraSources.map(item => normalizeSource(item).toLowerCase());
    const allowlist = await getTelegramSourceAllowlist();
    if (allowlist.length === 0) {
        // Empty allowlist keeps compatibility for public @usernames/links. Private invite links are resolved
        // through CheckChatInvite first, so a numeric peer produced by that trusted flow is allowed.
        if (/^-?\d+$/.test(normalized) && extraSources.length === 0) {
            throw new Error('未配置 Telegram 来源白名单，禁止使用数字 ID/私聊/私密群组来源。请配置 TELEGRAM_ALLOWED_SOURCES。');
        }
        return;
    }
    if (!allowlist.includes(normalized) && !normalizedExtras.some(item => allowlist.includes(item))) {
        throw new Error(`来源 ${source} 不在 Telegram 下载白名单中`);
    }
}

export function contiguousProcessedMessageId(
    startId: number,
    successfulMessageIds: number[],
    skippedMessageIds: number[],
    failedMessageIds: number[],
): number {
    const processed = new Set([...successfulMessageIds, ...skippedMessageIds]);
    const failed = new Set(failedMessageIds);
    let cursor = startId;
    while (!failed.has(cursor + 1) && processed.has(cursor + 1)) cursor += 1;
    return cursor;
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

export function parseTelegramPrivateInviteHash(source: string): string | null {
    const trimmed = source.trim();
    // Supports t.me/+hash, https://t.me/+hash and legacy t.me/joinchat/hash private invite links ("t.me/+hash").
    const match = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i);
    return match?.[1] || null;
}

interface ResolvedTelegramSource {
    source: string;
    originalSource: string;
    sourceType: 'public' | 'private_invite';
    entity?: any;
    title?: string;
}

function telegramInviteErrorMessage(error: unknown): string {
    const anyErr = error as any;
    const text = `${anyErr?.errorMessage || ''} ${anyErr?.message || ''}`;
    if (/INVITE_HASH_EXPIRED/i.test(text)) {
        return '私密频道/群邀请链接已过期，无法解析。请获取新的邀请链接，或先用生成用户 Session 的同一个 Telegram 账号加入后再重试。';
    }
    if (/INVITE_HASH_INVALID/i.test(text)) {
        return '私密频道/群邀请链接无效，无法解析。请检查链接是否完整，或重新生成邀请链接。';
    }
    if (/USER_ALREADY_PARTICIPANT/i.test(text)) {
        return '当前账号已加入，但 Telegram 返回了异常状态，请重新尝试解析。';
    }
    return `私密频道/群邀请链接解析失败：${anyErr?.message || anyErr?.errorMessage || String(error)}`;
}

function assertJoinedPrivateInvite(invite: any): void {
    if (invite instanceof Api.ChatInviteAlready) return;
    if (invite instanceof Api.ChatInvite) {
        throw new Error('当前 Telegram 用户账号尚未加入这个私密频道/群，无法读取消息。请先使用生成用户 Session 的同一个 Telegram 账号打开邀请链接并加入，然后重新执行订阅或下载命令。');
    }
}

async function resolveTelegramSource(userClient: TelegramClient, sourceInput: string): Promise<ResolvedTelegramSource> {
    const originalSource = sourceInput.trim();
    const inviteHash = parseTelegramPrivateInviteHash(originalSource);
    if (!inviteHash) {
        const source = normalizeSource(originalSource);
        const entity: any = await userClient.getEntity(source as any);
        return { source, originalSource, sourceType: 'public', entity, title: getEntityTitle(entity, source) };
    }

    let invite: any;
    try {
        invite = await userClient.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));
    } catch (error) {
        throw new Error(telegramInviteErrorMessage(error));
    }

    assertJoinedPrivateInvite(invite);
    const entity = invite.chat;
    if (!entity) {
        throw new Error('私密频道/群邀请链接解析失败：Telegram 未返回可读取的频道实体。请检查账号是否仍在该频道/群内。');
    }
    const source = getPeerId(entity, true);
    return { source, originalSource, sourceType: 'private_invite', entity, title: getEntityTitle(entity, source) };
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
                file_name, mime_type, generated_name, total_size, folder_override, shared_caption, group_index, group_size,
                status, error, last_error, locked_at, completed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending', NULL, NULL, NULL, NULL)
             ON CONFLICT (job_id, source_peer, message_id)
             DO UPDATE SET
                file_name = COALESCE(EXCLUDED.file_name, telegram_download_items.file_name),
                mime_type = COALESCE(EXCLUDED.mime_type, telegram_download_items.mime_type),
                generated_name = COALESCE(EXCLUDED.generated_name, telegram_download_items.generated_name),
                total_size = COALESCE(EXCLUDED.total_size, telegram_download_items.total_size),
                grouped_id = COALESCE(EXCLUDED.grouped_id, telegram_download_items.grouped_id),
                shared_caption = COALESCE(EXCLUDED.shared_caption, telegram_download_items.shared_caption),
                group_index = COALESCE(EXCLUDED.group_index, telegram_download_items.group_index),
                group_size = COALESCE(EXCLUDED.group_size, telegram_download_items.group_size),
                folder_override = EXCLUDED.folder_override,
                updated_at = NOW()`,
            [
                jobId,
                source,
                sourcePeerKey(ref.source, source),
                ref.origin || 'channel',
                ref.id,
                ref.groupedId || null,
                ref.channelPostId || null,
                ref.fileInfo?.fileName || null,
                ref.fileInfo?.mimeType || null,
                ref.fileInfo?.generatedName || false,
                ref.totalSize || 0,
                folderOverride || null,
                ref.sharedCaption || null,
                ref.groupIndex || null,
                ref.groupSize || null,
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
    targetProvider?: string;
    targetAccountId?: string | null;
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
                    groupedId: messageGroupId(comment),
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
        message,
        groupedId: messageGroupId(message),
    };
}

export function propagateTelegramDownloadGroupContext(refs: TelegramDownloadMessageRef[]): TelegramDownloadMessageRef[] {
    const groups = new Map<string, TelegramDownloadMessageRef[]>();
    for (const ref of refs) {
        if (!ref.groupedId) continue;
        const group = groups.get(ref.groupedId) || [];
        group.push(ref);
        groups.set(ref.groupedId, group);
    }
    for (const group of groups.values()) {
        const withMessages = group.filter((ref): ref is TelegramDownloadMessageRef & { message: Api.Message } => Boolean(ref.message));
        if (withMessages.length === group.length) {
            annotateTelegramMediaGroup(withMessages);
            continue;
        }
        const ordered = [...group].sort((a, b) => a.id - b.id);
        const sharedCaption = ordered.find(ref => ref.sharedCaption)?.sharedCaption || null;
        ordered.forEach((ref, index) => {
            ref.sharedCaption = ref.sharedCaption || sharedCaption;
            ref.groupIndex = ref.groupIndex || index + 1;
            ref.groupSize = ref.groupSize || ordered.length;
        });
    }
    return refs;
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
    const commentScan = await getDiscussionMediaRefs(userClient, source, messages, options);
    refs.push(...commentScan.refs);
    propagateTelegramDownloadGroupContext(refs);
    for (const ref of refs) {
        await options.onRefDiscovered?.(ref);
    }
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

export type TelegramJobQuery = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
export type TelegramDownloadSettlementResult = 'settled' | 'already-terminal' | 'lease-lost';

export class TelegramDownloadLeaseLostError extends Error {
    constructor(jobId: string, ref: TelegramDownloadMessageRef) {
        super(`Telegram 下载 lease 已丢失: job=${jobId} message=${ref.id}`);
        this.name = 'TelegramDownloadLeaseLostError';
    }
}

interface TelegramTransactionClient {
    query: TelegramJobQuery;
    release(): void;
}

interface TelegramTransactionPool {
    connect(): Promise<TelegramTransactionClient>;
}

const telegramLeaseFinalizing = new Set<string>();

function telegramLeaseKey(jobId: string, ref: TelegramDownloadMessageRef): string {
    return `${jobId}:${sourcePeerKey(ref.source, ref.origin === 'comment' ? 'comment' : 'channel')}:${ref.id}:${ref.leaseToken || ''}`;
}

export async function withTelegramDownloadRefLease<T>(
    transactionPool: TelegramTransactionPool,
    jobId: string,
    ref: TelegramDownloadMessageRef,
    operation: () => Promise<T>,
): Promise<T> {
    if (!ref.leaseToken) throw new TelegramDownloadLeaseLostError(jobId, ref);
    const leaseKey = telegramLeaseKey(jobId, ref);
    const client = await transactionPool.connect();
    telegramLeaseFinalizing.add(leaseKey);
    try {
        await client.query('BEGIN');
        const owned = await client.query(
            `SELECT i.id
             FROM telegram_download_items i
             WHERE i.job_id = $1 AND i.source_peer = $2 AND i.message_id = $3
               AND i.status = 'downloading' AND i.lease_token = $4::uuid
             FOR UPDATE`,
            [jobId, sourcePeerKey(ref.source, ref.origin === 'comment' ? 'comment' : 'channel'), ref.id, ref.leaseToken],
        );
        if ((owned.rowCount || 0) !== 1) throw new TelegramDownloadLeaseLostError(jobId, ref);
        const result = await operation();
        const settlement = await settleTelegramDownloadRefWithQuery(client.query.bind(client), jobId, ref, 'success');
        if (settlement !== 'settled') throw new TelegramDownloadLeaseLostError(jobId, ref);
        if (ref.writeOperationId) {
            await resolveTelegramWriteCommittedWithQuery(client, ref.writeOperationId, ref.leaseToken);
        }
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        telegramLeaseFinalizing.delete(leaseKey);
        client.release();
    }
}

export async function settleTelegramDownloadRefWithQuery(
    runQuery: TelegramJobQuery,
    jobId: string,
    ref: TelegramDownloadMessageRef,
    status: 'success' | 'failed' | 'skipped',
    error?: string,
): Promise<TelegramDownloadSettlementResult> {
    const sourcePeer = sourcePeerKey(ref.source, ref.origin === 'comment' ? 'comment' : 'channel');
    const leaseToken = ref.leaseToken || null;
    const result = await runQuery(
        `UPDATE telegram_download_items i
         SET status = CASE WHEN i.status = 'downloading' THEN $3::varchar ELSE i.status END,
             error = CASE WHEN i.status = 'downloading' THEN $4 ELSE i.error END,
             last_error = CASE WHEN i.status = 'downloading' THEN $4 ELSE i.last_error END,
             attempts = CASE WHEN i.status = 'downloading' AND $3::text = 'failed' THEN i.attempts + 1 ELSE i.attempts END,
             completed_at = CASE WHEN i.status = 'downloading' AND $3::text IN ('success', 'skipped') THEN NOW() ELSE i.completed_at END,
             locked_at = CASE WHEN i.status = 'downloading' THEN NULL ELSE i.locked_at END,
             lease_token = CASE WHEN i.status = 'downloading' THEN NULL ELSE i.lease_token END,
             lease_expires_at = CASE WHEN i.status = 'downloading' THEN NULL ELSE i.lease_expires_at END,
             updated_at = CASE WHEN i.status = 'downloading' THEN NOW() ELSE i.updated_at END
         WHERE i.job_id = $1 AND i.source_peer = $2 AND i.message_id = $5
           AND ($6::uuid IS NULL OR i.lease_token = $6::uuid)
           AND i.status IN ('downloading', 'success', 'failed', 'skipped')
         RETURNING i.status`,
        [jobId, sourcePeer, status, error || null, ref.id, leaseToken],
    );
    if ((result.rowCount || 0) === 0) {
        if (leaseToken) return 'lease-lost';
        throw new Error(`Telegram 下载条目结算影响 0 行: job=${jobId} peer=${sourcePeer} message=${ref.id}`);
    }
    return result.rows[0]?.status === status ? 'settled' : 'already-terminal';
}

async function markDownloadRefStatus(jobId: string, ref: TelegramDownloadMessageRef, status: 'success' | 'failed' | 'skipped', error?: string) {
    return settleTelegramDownloadRefWithQuery(query, jobId, ref, status, error);
}

async function persistDownloadMessages(jobId: string, source: string, messages: Api.Message[], folderOverride?: string | null) {
    const refs = messages
        .map(message => toChannelDownloadRef(source, message))
        .filter((ref): ref is TelegramDownloadMessageRef => Boolean(ref));
    propagateTelegramDownloadGroupContext(refs);
    await persistDownloadRefs(jobId, source, refs, folderOverride);
}

async function updateDownloadItemsStatus(jobId: string, messageIds: number[] | undefined, status: 'success' | 'failed' | 'skipped', error?: string) {
    const ids = Array.from(new Set((messageIds || []).filter(id => id > 0)));
    if (ids.length === 0) return;
    await query(
        `UPDATE telegram_download_items
         SET status = $2::varchar, error = $3, last_error = $3, updated_at = NOW(),
             completed_at = CASE WHEN $2::text IN ('success', 'skipped') THEN NOW() ELSE completed_at END,
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
    const target = storageManager.getActiveTarget();
    const persistedParams = {
        ...params,
        storageProvider: target.provider.name,
        storageAccountId: target.accountId,
    };
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (target.accountId) await lockStorageAccountForUse(client, target.accountId);
        const result = await client.query(
            `INSERT INTO telegram_background_jobs (user_id, chat_id, kind, source, params, status, scan_status, download_status, scan_cursor)
             VALUES ($1, $2, $3, $4, $5, 'queued', 'pending', 'pending', '{}'::jsonb)
             RETURNING id`,
            [userId, chatId || null, kind, source, JSON.stringify(persistedParams)]
        );
        await client.query('COMMIT');
        return result.rows[0].id as string;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

async function getJob(jobId: string) {
    const result = await query(`SELECT * FROM telegram_background_jobs WHERE id = $1`, [jobId]);
    return result.rows[0] || null;
}

async function updateJob(jobId: string, updates: Record<string, unknown>): Promise<number> {
    const entries = Object.entries(updates);
    if (entries.length === 0) return 0;
    const setSql = entries.map(([key], index) => `${key} = $${index + 2}`).join(', ');
    const writesTerminalOrRunningState = entries.some(([key, value]) => (
        key === 'status' && ['running', 'completed', 'completed_with_errors', 'failed'].includes(String(value))
    ));
    const terminalGuard = writesTerminalOrRunningState
        ? ` AND cancelled_at IS NULL AND paused_at IS NULL AND status NOT IN ('cancelled', 'paused', 'cooling')`
        : '';
    const result = await query(`UPDATE telegram_background_jobs SET ${setSql}, updated_at = NOW() WHERE id = $1${terminalGuard}`, [jobId, ...entries.map(([, value]) => value)]);
    return result.rowCount || 0;
}

async function hydratePendingDownloadRefs(userClient: TelegramClient, jobId: string): Promise<number> {
    const result = await query(
        `SELECT id, source_peer, message_id
         FROM telegram_download_items
         WHERE job_id = $1
           AND status = 'pending'
           AND (file_name IS NULL OR mime_type IS NULL)
         ORDER BY created_at ASC
         LIMIT 100`,
        [jobId]
    );
    let hydrated = 0;
    for (const row of result.rows) {
        try {
            const messages = await userClient.getMessages(row.source_peer as any, { ids: [Number(row.message_id)] });
            const message = messages?.[0] as Api.Message | undefined;
            if (!message) {
                await query(
                    `UPDATE telegram_download_items
                     SET status = 'failed', error = $2, last_error = $2, attempts = attempts + 1, updated_at = NOW()
                     WHERE id = $1`,
                    [row.id, '消息不存在，无法补全文件元数据']
                );
                continue;
            }
            const fileInfo = extractFileInfo(message);
            if (!fileInfo) {
                await query(
                    `UPDATE telegram_download_items
                     SET status = 'skipped', error = $2, last_error = $2, completed_at = NOW(), updated_at = NOW()
                     WHERE id = $1`,
                    [row.id, '消息不包含可下载媒体，无法补全文件元数据']
                );
                continue;
            }
            await query(
                `UPDATE telegram_download_items
                 SET file_name = $2, mime_type = $3, total_size = $4,
                     generated_name = $5, grouped_id = $6, updated_at = NOW()
                 WHERE id = $1`,
                [
                    row.id,
                    fileInfo.fileName,
                    fileInfo.mimeType,
                    getEstimatedFileSize(message),
                    fileInfo.generatedName,
                    messageGroupId(message) || null,
                ]
            );
            hydrated += 1;
        } catch (error) {
            console.warn('♻️ 补全 Telegram 下载条目元数据失败:', error);
        }
    }
    return hydrated;
}

export async function subscribeTelegramChannel(userId: number, chatId: string | undefined, sourceInput: string, folderOverride?: string | null) {
    const userClient = requireUserClient();
    const resolved = await resolveTelegramSource(userClient, sourceInput);
    await assertTelegramSourceAllowed(resolved.source, [resolved.originalSource]);
    const latestMessageId = await getLatestMessageId(userClient, resolved.source);
    const title = resolved.title || getEntityTitle(resolved.entity, resolved.source);

    const result = await query(
        `INSERT INTO telegram_channel_subscriptions (user_id, chat_id, source, source_original, source_type, title, last_message_id, folder_override, enabled, disabled_reason, disabled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NULL, NULL)
         ON CONFLICT (user_id, source)
         DO UPDATE SET chat_id = EXCLUDED.chat_id, source_original = EXCLUDED.source_original, source_type = EXCLUDED.source_type, title = EXCLUDED.title, folder_override = EXCLUDED.folder_override, enabled = true, disabled_reason = NULL, disabled_at = NULL, updated_at = NOW()
         RETURNING id, source, source_original, source_type, title, last_message_id, folder_override, enabled, disabled_reason, disabled_at`,
        [userId, chatId || null, resolved.source, resolved.originalSource, resolved.sourceType, title, latestMessageId, folderOverride || null]
    );
    return result.rows[0];
}

export async function listTelegramSubscriptions(userId: number, includeDisabled = false) {
    const result = await query(
        `SELECT id, source, source_original, source_type, title, last_message_id, folder_override, enabled, disabled_reason, disabled_at,
                last_scan_at, last_success_at, last_error, last_result,
                CASE WHEN enabled THEN NOW() + ($3::int * INTERVAL '1 millisecond') ELSE NULL END AS next_scan_at,
                updated_at
         FROM telegram_channel_subscriptions
         WHERE user_id = $1
           AND ($2::boolean OR enabled = true)
         ORDER BY updated_at DESC`,
        [userId, includeDisabled, SUBSCRIPTION_INTERVAL_MS]
    );
    return result.rows;
}

async function resolveUniqueTelegramSubscriptionId(userId: number, selector: string): Promise<string | null> {
    const normalized = selector.trim().toLowerCase();
    if (!/^[0-9a-f-]{4,36}$/.test(normalized)) return null;
    const result = await query(
        `SELECT id FROM telegram_channel_subscriptions
         WHERE user_id = $1 AND id::text LIKE $2
         ORDER BY updated_at DESC
         LIMIT 2`,
        [userId, `${normalized}%`],
    );
    return result.rows.length === 1 ? String(result.rows[0].id) : null;
}

export async function updateTelegramSubscriptionFolder(userId: number, selector: string, folderOverride: string | null) {
    const subscriptionId = await resolveUniqueTelegramSubscriptionId(userId, selector);
    if (!subscriptionId) return null;
    const result = await query(
        `UPDATE telegram_channel_subscriptions
         SET folder_override = $3, updated_at = NOW()
         WHERE user_id = $1 AND id = $2::uuid
         RETURNING id, source, source_original, source_type, title, last_message_id, folder_override, enabled, disabled_reason, disabled_at`,
        [userId, subscriptionId, folderOverride || null]
    );
    return result.rows[0] || null;
}

export async function findTelegramSubscription(userId: number, selector: string) {
    const trimmed = selector.trim();
    if (/^[0-9a-f-]{4,36}$/i.test(trimmed)) {
        const subscriptionId = await resolveUniqueTelegramSubscriptionId(userId, trimmed);
        if (!subscriptionId) return null;
        const result = await query(
            `SELECT id, source, source_original, source_type, title, last_message_id, folder_override, enabled, disabled_reason, disabled_at, updated_at
             FROM telegram_channel_subscriptions
             WHERE user_id = $1 AND id = $2::uuid`,
            [userId, subscriptionId],
        );
        return result.rows[0] || null;
    }
    const normalizedSelector = /^@|^https?:\/\//i.test(trimmed) || /^-?\d+$/.test(trimmed)
        ? normalizeSource(trimmed)
        : trimmed;
    const result = await query(
        `SELECT id, source, source_original, source_type, title, last_message_id, folder_override, enabled, disabled_reason, disabled_at, updated_at
         FROM telegram_channel_subscriptions
         WHERE user_id = $1 AND (source = $2 OR source_original = $2)
         ORDER BY updated_at DESC
         LIMIT 2`,
        [userId, normalizedSelector]
    );
    return result.rows.length === 1 ? result.rows[0] : null;
}

export async function unsubscribeTelegramChannel(userId: number, selector: string) {
    const target = await findTelegramSubscription(userId, selector);
    if (!target) return null;
    const result = await query(
        `UPDATE telegram_channel_subscriptions
         SET enabled = false, disabled_reason = '用户手动取消订阅', disabled_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND id = $2::uuid
         RETURNING source, source_original, title`,
        [userId, target.id],
    );
    return result.rows[0] || null;
}

async function pauseTelegramSubscriptionForError(subscriptionId: string, reason: string) {
    await query(
        `UPDATE telegram_channel_subscriptions
         SET enabled = false, disabled_reason = $2, disabled_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [subscriptionId, reason]
    );
}

function isTelegramSourceInaccessibleError(error: unknown): boolean {
    const anyErr = error as any;
    const text = `${anyErr?.errorMessage || ''} ${anyErr?.message || ''}`;
    return /INVITE_HASH_EXPIRED|INVITE_HASH_INVALID|CHANNEL_PRIVATE|USER_NOT_PARTICIPANT|CHAT_ADMIN_REQUIRED|Could not find the input entity|Cannot find any entity|not part of|forbidden|privacy/i.test(text);
}

function subscriptionDisabledReason(error: unknown): string {
    const anyErr = error as any;
    const text = `${anyErr?.errorMessage || ''} ${anyErr?.message || ''}`;
    if (/INVITE_HASH_EXPIRED/i.test(text)) return '订阅已暂停：私密频道/群邀请链接已过期，无法继续解析或下载。请重新加入/更新链接后再订阅。';
    if (/INVITE_HASH_INVALID/i.test(text)) return '订阅已暂停：私密频道/群邀请链接无效，无法继续解析或下载。请检查链接后重新订阅。';
    if (/USER_NOT_PARTICIPANT|not part of/i.test(text)) return '订阅已暂停：当前 Telegram 用户账号已不在该私密频道/群内，无法继续下载。请先重新加入后再订阅。';
    if (/CHANNEL_PRIVATE|forbidden|privacy/i.test(text)) return '订阅已暂停：当前 Telegram 用户账号无法访问该频道/群，可能已退出、被移除或频道变为私密。请检查账号权限后重新订阅。';
    return `订阅已暂停：无法访问或下载该频道/群内容（${anyErr?.message || anyErr?.errorMessage || String(error)}）。请检查账号是否仍可访问后重新订阅。`;
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

type TelegramJobControlState = 'run' | 'paused' | 'cancelled' | 'cooldown';

async function putJobIntoStorageCooldown(jobId: string, cooldownUntil: Date, reasonText: string): Promise<void> {
    await query(
        `UPDATE telegram_background_jobs
         SET status = CASE WHEN paused_at IS NULL THEN 'cooling' ELSE 'paused' END,
             download_status = 'cooling', cooldown_until = $2, error = $3, updated_at = NOW()
         WHERE id = $1 AND cancelled_at IS NULL AND finished_at IS NULL`,
        [jobId, cooldownUntil, reasonText],
    );
    await query(
        `UPDATE telegram_download_items
         SET status = 'pending', locked_at = NULL, last_error = $2, updated_at = NOW()
         WHERE job_id = $1
           AND status IN ('downloading', 'failed')
           AND (status = 'downloading' OR last_error IS NULL OR last_error ILIKE '%upload%limit%' OR last_error ILIKE '%上传额度%')`,
        [jobId, reasonText],
    );
}

async function applyStorageCooldownIfNeeded(jobId: string): Promise<StorageAccountCooldown | null> {
    const provider = storageManager.getProvider();
    const activeAccountId = storageManager.getActiveAccountId();
    if (provider.name !== 'google_drive' || !activeAccountId) return null;
    const cooldown = await getStorageAccountCooldown(activeAccountId, provider.name, STORAGE_COOLDOWN_REASON_DAILY_UPLOAD_LIMIT);
    if (!cooldown) return null;
    await putJobIntoStorageCooldown(jobId, cooldown.cooldownUntil, `Google Drive 今日上传额度已达上限，自动暂停到 ${cooldown.cooldownUntil.toISOString()}`);
    return cooldown;
}

async function notifyStorageCooldownOnce(botClient: TelegramClient, job: any, cooldownUntil: Date): Promise<void> {
    const params = job.params || {};
    if (params.storageQuotaNoticeSentAt) return;
    const nextParams = { ...params, storageQuotaNoticeSentAt: new Date().toISOString(), storageQuotaCooldownUntil: cooldownUntil.toISOString() };
    await updateJob(job.id, { params: JSON.stringify(nextParams) });
    const targetChat = job.chat_id || job.user_id;
    await botClient.sendMessage(targetChat, {
        message: [
            formatStorageCooldownNotice(cooldownUntil),
            '',
            `任务：${String(job.id).slice(0, 12)}`,
        ].join('\n'),
    }).catch(() => undefined);
}

async function handleStorageQuotaCooldownError(botClient: TelegramClient, jobId: string, error: unknown): Promise<boolean> {
    if (!isStorageQuotaCooldownError(error)) return false;
    const cooldownUntil = error.cooldownUntil;
    await markStorageAccountCooldown(error.storageAccountId || storageManager.getActiveAccountId(), error.provider, error.reason, cooldownUntil, error.message);
    await putJobIntoStorageCooldown(jobId, cooldownUntil, error.message);
    const job = await getJob(jobId);
    if (job) await notifyStorageCooldownOnce(botClient, job, cooldownUntil);
    return true;
}

export async function ensureJobCanRunForTest(job: any, now = Date.now()): Promise<TelegramJobControlState> {
    if (!job) return 'cancelled';
    if (job.cancelled_at || job.status === 'cancelled') return 'cancelled';
    if (job.paused_at || job.status === 'paused') return 'paused';
    if (job.cooldown_until && new Date(job.cooldown_until).getTime() > now) return 'cooldown';
    return 'run';
}

async function ensureJobCanRun(jobId: string): Promise<TelegramJobControlState> {
    const job = await getJob(jobId);
    const persistedState = await ensureJobCanRunForTest(job);
    if (persistedState !== 'run') return persistedState;
    const storageCooldown = await applyStorageCooldownIfNeeded(jobId);
    if (storageCooldown) return 'cooldown';
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

function persistedTelegramFileInfo(row: any): TelegramFileInfo {
    return {
        fileName: row.file_name,
        mimeType: row.mime_type,
        generatedName: row.generated_name === true,
    };
}

async function claimPendingDownloadRefs(jobId: string, limit = TG_JOB_DOWNLOAD_BATCH_SIZE): Promise<TelegramDownloadMessageRef[]> {
    const result = await query(
        `WITH locked_job AS (
             SELECT j.id
             FROM telegram_background_jobs j
             WHERE j.id = $1
               AND j.cancelled_at IS NULL
               AND j.paused_at IS NULL
               AND j.finished_at IS NULL
               AND (j.cooldown_until IS NULL OR j.cooldown_until <= NOW())
               AND j.status NOT IN ('cancelled', 'paused', 'cooling')
             FOR UPDATE OF j
         ), candidates AS (
             SELECT i.id
             FROM telegram_download_items i
             JOIN locked_job j ON j.id = i.job_id
             WHERE i.job_id = $1
               AND i.status = 'pending'
               AND i.attempts < $2
               AND i.file_name IS NOT NULL
               AND i.mime_type IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM telegram_write_reconciliations r
                   WHERE r.item_id = i.id AND r.status = 'pending'
               )
             ORDER BY i.created_at ASC
             FOR UPDATE OF i SKIP LOCKED
             LIMIT $3
         )
         UPDATE telegram_download_items i
         SET status = 'downloading', locked_at = NOW(), lease_token = gen_random_uuid(),
             lease_expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW()
         FROM candidates c, telegram_background_jobs j
         WHERE i.id = c.id AND i.status = 'pending'
           AND j.id = i.job_id
           AND j.cancelled_at IS NULL
           AND j.paused_at IS NULL
           AND j.finished_at IS NULL
           AND (j.cooldown_until IS NULL OR j.cooldown_until <= NOW())
           AND j.status NOT IN ('cancelled', 'paused', 'cooling')
         RETURNING i.id, i.source, i.source_peer, i.origin, i.message_id, i.grouped_id, i.channel_post_id,
                   i.file_name, i.mime_type, i.generated_name, i.total_size, i.folder_override,
                   i.shared_caption, i.group_index, i.group_size, i.lease_token`,
        [jobId, TG_JOB_MAX_ATTEMPTS, limit]
    );
    return result.rows
        .filter(row => row.file_name && row.mime_type)
        .map(row => ({
            id: Number(row.message_id),
            itemId: String(row.id),
            source: row.source_peer || row.source,
            origin: row.origin === 'comment' ? 'comment' : 'channel',
            channelPostId: row.channel_post_id || undefined,
            fileInfo: persistedTelegramFileInfo(row),
            totalSize: Number(row.total_size || 0),
            groupedId: row.grouped_id || undefined,
            sharedCaption: row.shared_caption || null,
            groupIndex: row.group_index ? Number(row.group_index) : undefined,
            groupSize: row.group_size ? Number(row.group_size) : undefined,
            leaseToken: row.lease_token ? String(row.lease_token) : undefined,
        }));
}

export async function restoreTelegramDownloadRefsWithQuery(
    runQuery: TelegramJobQuery,
    jobId: string,
    refs: TelegramDownloadMessageRef[],
    status: 'pending' | 'skipped',
    reason?: string,
): Promise<boolean> {
    if (refs.length === 0) return true;
    const results = await Promise.all(refs.map(ref => runQuery(
        `UPDATE telegram_download_items
         SET status = $4::varchar,
             error = CASE WHEN $4::text = 'skipped' THEN COALESCE(error, $6) ELSE error END,
             last_error = CASE WHEN $6::text IS NOT NULL THEN $6 ELSE last_error END,
             locked_at = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             completed_at = CASE WHEN $4::text = 'skipped' THEN NOW() ELSE completed_at END,
             updated_at = NOW()
         WHERE job_id = $1 AND source_peer = $2 AND message_id = $3 AND status = 'downloading'
           AND lease_token = $5::uuid`,
        [jobId, sourcePeerKey(ref.source, ref.origin === 'comment' ? 'comment' : 'channel'), ref.id, status, ref.leaseToken || null, reason || (status === 'skipped' ? '任务已取消' : null)]
    )));
    return results.every(result => (result.rowCount || 0) === 1);
}

async function restoreClaimedRefs(jobId: string, refs: TelegramDownloadMessageRef[], status: 'pending' | 'skipped'): Promise<boolean> {
    return restoreTelegramDownloadRefsWithQuery(query, jobId, refs, status);
}

export function chooseUnfinishedClaimStatus(state: TelegramJobControlState): 'pending' | 'skipped' {
    return state === 'cancelled' ? 'skipped' : 'pending';
}

async function restoreUnfinishedClaimedRefs(
    jobId: string,
    refs: TelegramDownloadMessageRef[],
    reason: string,
    status: 'pending' | 'skipped' = 'pending',
): Promise<void> {
    await restoreTelegramDownloadRefsWithQuery(query, jobId, refs, status, reason);
}

export async function heartbeatTelegramDownloadRefsWithQuery(runQuery: TelegramJobQuery, jobId: string, refs: TelegramDownloadMessageRef[]): Promise<void> {
    const leased = refs.filter(ref => ref.leaseToken && !telegramLeaseFinalizing.has(telegramLeaseKey(jobId, ref)));
    if (leased.length === 0) return;
    const results = await Promise.all(leased.map(ref => runQuery(
        `UPDATE telegram_download_items
         SET locked_at = NOW(), lease_expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW()
         WHERE job_id = $1 AND source_peer = $2 AND message_id = $3
           AND status = 'downloading' AND lease_token = $4::uuid`,
        [jobId, sourcePeerKey(ref.source, ref.origin === 'comment' ? 'comment' : 'channel'), ref.id, ref.leaseToken],
    )));
    const lost: TelegramDownloadMessageRef[] = [];
    for (let index = 0; index < results.length; index += 1) {
        if ((results[index].rowCount || 0) === 1) continue;
        const ref = leased[index];
        const current = await runQuery(
            `SELECT status, lease_token
             FROM telegram_download_items
             WHERE job_id = $1 AND source_peer = $2 AND message_id = $3`,
            [jobId, sourcePeerKey(ref.source, ref.origin === 'comment' ? 'comment' : 'channel'), ref.id],
        );
        const row = current.rows[0];
        if (row && ['success', 'failed', 'skipped'].includes(String(row.status))) {
            ref.leaseToken = undefined;
            continue;
        }
        lost.push(ref);
    }
    if (lost[0]) throw new TelegramDownloadLeaseLostError(jobId, lost[0]);
}

async function heartbeatClaimedRefs(jobId: string, refs: TelegramDownloadMessageRef[]): Promise<void> {
    return heartbeatTelegramDownloadRefsWithQuery(query, jobId, refs);
}

function startClaimHeartbeat(jobId: string, refs: TelegramDownloadMessageRef[]): () => void {
    const handleFailure = (error: unknown) => {
        console.error('Telegram 下载 lease heartbeat 失败:', error);
        abortChannelExecutionForLeaseLoss(jobId);
    };
    void heartbeatClaimedRefs(jobId, refs).catch(handleFailure);
    const timer = setInterval(() => {
        void heartbeatClaimedRefs(jobId, refs).catch(handleFailure);
    }, 2 * 60 * 1000);
    timer.unref?.();
    return () => clearInterval(timer);
}

async function downloadClaimedRefs(botClient: TelegramClient, requestMessage: Api.Message, jobId: string, source: string, refs: TelegramDownloadMessageRef[], folderOverride: string | null | undefined, options: TelegramCommentScanOptions) {
    if (refs.length === 0) return {
        found: 0,
        skipped: 0,
        failed: 0,
        successful: 0,
        successfulMessageIds: [] as number[],
        failedMessageIds: [] as number[],
        skippedMessageIds: [] as number[],
    };
    const controlState = await ensureJobCanRun(jobId);
    if (controlState !== 'run') {
        await restoreClaimedRefs(jobId, refs, controlState === 'cancelled' ? 'skipped' : 'pending');
        return {
            found: 0,
            skipped: controlState === 'cancelled' ? refs.length : 0,
            failed: 0,
            successful: 0,
            successfulMessageIds: [] as number[],
            failedMessageIds: [] as number[],
            skippedMessageIds: controlState === 'cancelled' ? refs.map(ref => ref.id) : [] as number[],
        };
    }
    const started = await query(
        `UPDATE telegram_background_jobs
         SET status = 'running', download_status = 'active', error = NULL, updated_at = NOW()
         WHERE id = $1
           AND cancelled_at IS NULL
           AND paused_at IS NULL
           AND finished_at IS NULL
           AND status NOT IN ('cancelled', 'paused', 'cooling')
           AND (cooldown_until IS NULL OR cooldown_until <= NOW())
         RETURNING id`,
        [jobId],
    );
    if ((started.rowCount || 0) === 0) {
        const latestState = await ensureJobCanRun(jobId);
        await restoreClaimedRefs(jobId, refs, latestState === 'cancelled' ? 'skipped' : 'pending');
        return {
            found: 0,
            skipped: latestState === 'cancelled' ? refs.length : 0,
            failed: 0,
            successful: 0,
            successfulMessageIds: [] as number[],
            failedMessageIds: [] as number[],
            skippedMessageIds: latestState === 'cancelled' ? refs.map(ref => ref.id) : [] as number[],
        };
    }
    const taskSignal = getChannelTaskAbortSignal(jobId);
    const stopHeartbeat = startClaimHeartbeat(jobId, refs);
    const ownerJob = await getJob(jobId);
    const ownerUserId = Number(ownerJob?.user_id || 0) || undefined;
    try {
        const jobParams = typeof ownerJob?.params === 'string' ? JSON.parse(ownerJob.params) : (ownerJob?.params || {});
        const storageTarget = jobParams.storageProvider
            ? storageManager.getTarget(jobParams.storageProvider, jobParams.storageAccountId)
            : storageManager.getActiveTarget();
        const result = await downloadTelegramChannelRange(botClient, requestMessage, source, 0, refs.length, 'older', refs.map(ref => ref.id), folderOverride, refs, async (ref, status, error) => {
            const settlement = await markDownloadRefStatus(jobId, ref, status, error);
            if (settlement === 'lease-lost') throw new TelegramDownloadLeaseLostError(jobId, ref);
            await notifyProgress(jobId, options);
        }, jobId, () => ensureJobCanRun(jobId), taskSignal, ownerUserId, storageTarget,
        (ref, operation) => withTelegramDownloadRefLease(pool as unknown as TelegramTransactionPool, jobId, Object.assign(ref, { jobId }), async () => {
            const persisted = await operation();
            if (taskSignal.aborted) throw new Error('Telegram 下载 lease heartbeat 失败，已停止保存');
            return persisted;
        }));
        const latestState = await ensureJobCanRun(jobId);
        if (latestState !== 'run') {
            await restoreUnfinishedClaimedRefs(
                jobId,
                refs,
                latestState === 'cancelled' ? '任务已取消' : '任务已暂停',
                chooseUnfinishedClaimStatus(latestState),
            );
        }
        return result;
    } catch (error) {
        if (error instanceof TelegramDownloadLeaseLostError) {
            abortChannelExecutionForLeaseLoss(jobId);
            throw error;
        }
        const flood = isFloodWait(error);
        if (flood) {
            const cooldownUntil = new Date(Date.now() + flood.seconds * 1000);
            await updateJob(jobId, {
                status: 'cooling',
                download_status: 'cooling',
                cooldown_until: cooldownUntil,
                error: `Telegram FloodWait，冷却到 ${cooldownUntil.toISOString()}`,
            });
            await restoreUnfinishedClaimedRefs(jobId, refs, `FloodWait ${flood.seconds}s`);
            return { found: 0, skipped: 0, failed: 0, successful: 0, successfulMessageIds: [], failedMessageIds: [], skippedMessageIds: [] };
        }
        if (await handleStorageQuotaCooldownError(botClient, jobId, error)) {
            await restoreUnfinishedClaimedRefs(jobId, refs, error instanceof Error ? error.message : String(error));
            return { found: 0, skipped: 0, failed: 0, successful: 0, successfulMessageIds: [], failedMessageIds: [], skippedMessageIds: [] };
        }
        for (const ref of refs) await markDownloadRefStatus(jobId, ref, 'failed', error instanceof Error ? error.message : String(error));
        throw error;
    } finally {
        stopHeartbeat();
        releaseChannelTaskAbortSignal(jobId, taskSignal);
    }
}

async function downloadPendingForJob(botClient: TelegramClient, requestMessage: Api.Message, jobId: string, source: string, folderOverride: string | null | undefined, options: TelegramCommentScanOptions, drain = false) {
    let aggregate = {
        found: 0,
        skipped: 0,
        failed: 0,
        successful: 0,
        successfulMessageIds: [] as number[],
        failedMessageIds: [] as number[],
        skippedMessageIds: [] as number[],
    };
    const userClient = getTelegramUserClient();
    while (await waitUntilRunnable(jobId, options)) {
        if (userClient) await hydratePendingDownloadRefs(userClient, jobId);
        const refs = await claimPendingDownloadRefs(jobId);
        if (refs.length === 0) break;
        const result = await downloadClaimedRefs(botClient, requestMessage, jobId, source, refs, folderOverride, options);
        aggregate = {
            found: aggregate.found + (result.found || 0),
            skipped: aggregate.skipped + (result.skipped || 0),
            failed: aggregate.failed + (result.failed || 0),
            successful: aggregate.successful + (result.successful || 0),
            successfulMessageIds: [...aggregate.successfulMessageIds, ...(result.successfulMessageIds || [])],
            failedMessageIds: [...aggregate.failedMessageIds, ...(result.failedMessageIds || [])],
            skippedMessageIds: [...aggregate.skippedMessageIds, ...(result.skippedMessageIds || [])],
        };
        if (!drain) break;
    }
    return aggregate;
}

async function finalizeTelegramJob(jobId: string, options: TelegramCommentScanOptions) {
    const job = await getJob(jobId);
    if (!job || job.cancelled_at || job.status === 'cancelled') return;
    if (job.paused_at || job.status === 'paused') {
        await notifyProgress(jobId, options);
        return;
    }
    const stats = await getJobItemStats(jobId);
    const pending = Number(stats.pending || 0) + Number(stats.downloading || 0);
    const failed = Number(stats.failed || 0);
    const status = pending > 0 ? 'running' : failed > 0 ? 'completed_with_errors' : 'completed';
    const result = await query(
        `UPDATE telegram_background_jobs
         SET status = $2,
             download_status = $3,
             enqueued_count = $4,
             skipped_count = $5,
             error = $6,
             finished_at = $7,
             updated_at = NOW()
         WHERE id = $1
           AND cancelled_at IS NULL
           AND paused_at IS NULL
           AND status NOT IN ('cancelled', 'paused')
         RETURNING id`,
        [
            jobId,
            status,
            pending > 0 ? 'active' : 'done',
            Number(stats.success || 0),
            Number(stats.skipped || 0),
            failed > 0 ? `${failed} 个文件下载失败` : null,
            pending > 0 ? null : new Date(),
        ]
    );
    if ((result.rowCount || 0) > 0) await notifyProgress(jobId, options);
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
    const initialState = await ensureJobCanRun(jobId);
    if (initialState === 'cancelled') {
        return { jobId, cancelled: true, ...totals, requested: 0, commentMessagesScanned: 0, commentMediaFound: 0 };
    }
    if (initialState !== 'run') {
        const runnable = await waitUntilRunnable(jobId, options);
        if (!runnable) return { jobId, cancelled: true, ...totals, requested: 0, commentMessagesScanned: 0, commentMediaFound: 0 };
    }
    const started = await query(
        `UPDATE telegram_background_jobs
         SET status = 'running', scan_status = 'scanning', download_status = 'active',
             started_at = COALESCE(started_at, NOW()), error = NULL, updated_at = NOW()
         WHERE id = $1
           AND cancelled_at IS NULL
           AND paused_at IS NULL
           AND finished_at IS NULL
           AND status NOT IN ('cancelled', 'paused', 'cooling')
           AND (cooldown_until IS NULL OR cooldown_until <= NOW())
         RETURNING id`,
        [jobId],
    );
    if ((started.rowCount || 0) === 0) {
        const state = await ensureJobCanRun(jobId);
        if (state === 'cancelled') return { jobId, cancelled: true, ...totals, requested: 0, commentMessagesScanned: 0, commentMediaFound: 0 };
        if (state !== 'run') {
            const runnable = await waitUntilRunnable(jobId, options);
            if (!runnable) return { jobId, cancelled: true, ...totals, requested: 0, commentMessagesScanned: 0, commentMediaFound: 0 };
        }
        return { jobId, deferred: true, ...totals, requested: 0, commentMessagesScanned: 0, commentMediaFound: 0 };
    }

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
        return { jobId, cancelled: true, ...totals, requested: 0, commentMessagesScanned: Number(cursor.commentMessagesScanned || 0), commentMediaFound: Number(cursor.commentMediaFound || 0) };
    }
    await updateJob(jobId, { scan_status: 'done' });
    const drained = await downloadPendingForJob(botClient, requestMessage, jobId, source, folderOverride, options, true);
    totals = { found: totals.found + drained.found, skipped: totals.skipped + drained.skipped, failed: totals.failed + drained.failed, successful: totals.successful + drained.successful };
    await finalizeTelegramJob(jobId, options);
    return { jobId, ...totals, requested: totals.found + totals.skipped, commentMessagesScanned: Number(cursor.commentMessagesScanned || 0), commentMediaFound: Number(cursor.commentMediaFound || 0) };
}

export async function enqueueTelegramDateDownload(botClient: TelegramClient, requestMessage: Api.Message, userId: number, sourceInput: string, startDateText: string, endDateText: string, folderOverride?: string | null, options: TelegramCommentScanOptions = {}) {
    const userClient = requireUserClient();
    const resolved = await resolveTelegramSource(userClient, sourceInput);
    await assertTelegramSourceAllowed(resolved.source, [resolved.originalSource]);
    const source = resolved.source;
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
        storageProvider: options.targetProvider || null,
        storageAccountId: options.targetAccountId || null,
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
    const userClient = requireUserClient();
    const resolved = await resolveTelegramSource(userClient, sourceInput);
    await assertTelegramSourceAllowed(resolved.source, [resolved.originalSource]);
    const source = resolved.source;
    const tag = normalizeHashtag(tagInput);

    const jobId = await createJob(userId, requestMessage.chatId?.toString(), 'tag_download', source, {
        mode: 'tag',
        tag,
        folderOverride: folderOverride || null,
        includeComments: Boolean(options.includeComments),
        commentsMaxPerPost: options.commentsMaxPerPost || TELEGRAM_COMMENTS_MAX_PER_POST,
        storageProvider: options.targetProvider || null,
        storageAccountId: options.targetAccountId || null,
    });
    const result = await runSegmentedTelegramJob(botClient, requestMessage, jobId, source, folderOverride, options);
    return { ...result, tag };
}

export async function listTelegramActiveTaskQueues(userId: number, limit = 10) {
    const result = await query(
        `WITH item_stats AS (
             SELECT
                 job_id,
                 COUNT(*)::int AS item_count,
                 COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
                 COUNT(*) FILTER (WHERE status = 'downloading')::int AS downloading_count,
                 COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
                 COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
                 COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped_count_items,
                 COUNT(*) FILTER (WHERE status = 'pending' AND (file_name IS NULL OR mime_type IS NULL))::int AS missing_metadata_count,
                 MAX(updated_at) FILTER (WHERE status IN ('pending', 'downloading')) AS queue_updated_at
             FROM telegram_download_items
             GROUP BY job_id
         )
         SELECT
             j.id, j.user_id, j.chat_id, j.kind, j.source, j.status, j.scan_status, j.download_status,
             j.scan_cursor, j.cooldown_until, j.paused_at, j.cancelled_at, j.params,
             j.total_count, j.enqueued_count, j.skipped_count, j.duplicate_count,
             j.error, j.started_at, j.finished_at, j.created_at, j.updated_at,
             COALESCE(s.item_count, 0)::int AS item_count,
             COALESCE(s.pending_count, 0)::int AS pending_count,
             COALESCE(s.downloading_count, 0)::int AS downloading_count,
             COALESCE(s.success_count, 0)::int AS success_count,
             COALESCE(s.failed_count, 0)::int AS failed_count,
             COALESCE(s.skipped_count_items, 0)::int AS skipped_count_items,
             COALESCE(s.missing_metadata_count, 0)::int AS missing_metadata_count,
             s.queue_updated_at,
             (SELECT i.file_name
                FROM telegram_download_items i
               WHERE i.job_id = j.id AND i.status = 'downloading'
               ORDER BY i.locked_at DESC NULLS LAST, i.updated_at DESC
               LIMIT 1) AS current_file_name,
             (SELECT i.folder_override
                FROM telegram_download_items i
               WHERE i.job_id = j.id AND i.folder_override IS NOT NULL
               ORDER BY i.updated_at DESC
               LIMIT 1) AS folder_override,
             (
                 j.status = 'running'
                 AND (
                     COALESCE(s.downloading_count, 0) > 0
                     OR j.scan_status = 'scanning'
                     OR (j.cooldown_until IS NOT NULL AND j.cooldown_until > NOW())
                 )
             ) AS is_actively_running
         FROM telegram_background_jobs j
         LEFT JOIN item_stats s ON s.job_id = j.id
         WHERE j.user_id = $1
           AND j.cancelled_at IS NULL
           AND j.finished_at IS NULL
           AND (
               (
                   j.status IN ('queued', 'pending')
                   AND j.finished_at IS NULL
               )
               OR (
                   j.status = 'running'
                   AND (
                       COALESCE(s.downloading_count, 0) > 0
                       OR j.scan_status = 'scanning'
                       OR (j.cooldown_until IS NOT NULL AND j.cooldown_until > NOW())
                   )
               )
               OR (
                   j.status IN ('paused', 'cooling')
                   AND (COALESCE(s.pending_count, 0) > 0 OR COALESCE(s.downloading_count, 0) > 0 OR j.scan_status = 'scanning')
               )
           )
         ORDER BY
             CASE WHEN j.status = 'paused' THEN 1 ELSE 0 END,
             COALESCE(s.queue_updated_at, j.updated_at) DESC
         LIMIT $2`,
        [userId, limit]
    );
    return result.rows;
}

export const listTelegramBackgroundJobs = listTelegramActiveTaskQueues;


async function resolveUniqueTelegramBackgroundJobId(userId: number, selector: string, chatId?: string): Promise<string | null> {
    const normalized = selector.trim().toLowerCase();
    if (!/^[0-9a-f-]{4,36}$/.test(normalized)) return null;
    const result = await query(
        `SELECT id
         FROM telegram_background_jobs
         WHERE user_id = $1
           AND id::text LIKE $2
           AND ($3::bigint IS NULL OR chat_id = $3::bigint)
         ORDER BY created_at DESC
         LIMIT 2`,
        [userId, `${normalized}%`, chatId || null]
    );
    return result.rows.length === 1 ? String(result.rows[0].id) : null;
}

export async function pauseTelegramBackgroundJob(userId: number, selector: string, chatId?: string) {
    const jobId = await resolveUniqueTelegramBackgroundJobId(userId, selector, chatId);
    if (!jobId) return null;
    const result = await query(
        `UPDATE telegram_background_jobs
         SET status = 'paused', paused_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND id = $2::uuid
           AND ($3::bigint IS NULL OR chat_id = $3::bigint)
           AND finished_at IS NULL AND status NOT IN ('completed', 'completed_with_errors', 'cancelled')
         RETURNING id, source, status`,
        [userId, jobId, chatId || null]
    );
    return result.rows[0] || null;
}

export async function resumeTelegramBackgroundJob(userId: number, selector: string, chatId?: string) {
    const jobId = await resolveUniqueTelegramBackgroundJobId(userId, selector, chatId);
    if (!jobId) return null;
    const result = await query(
        `UPDATE telegram_background_jobs
         SET status = 'running', paused_at = NULL, finished_at = NULL, error = NULL,
             download_status = CASE WHEN cooldown_until IS NOT NULL AND cooldown_until > NOW() THEN 'cooling' ELSE 'active' END,
             updated_at = NOW()
         WHERE user_id = $1 AND id = $2::uuid
           AND ($3::bigint IS NULL OR chat_id = $3::bigint)
           AND cancelled_at IS NULL AND status = 'paused'
           AND (cooldown_until IS NULL OR cooldown_until <= NOW())
         RETURNING id, source, status`,
        [userId, jobId, chatId || null]
    );
    return result.rows[0] || null;
}

export async function cancelTelegramBackgroundJob(userId: number, selector: string, chatId?: string) {
    const jobId = await resolveUniqueTelegramBackgroundJobId(userId, selector, chatId);
    if (!jobId) return null;
    const result = await query(
        `UPDATE telegram_background_jobs
         SET status = 'cancelled', scan_status = 'cancelled', download_status = 'cancelled', cancelled_at = NOW(), finished_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND id = $2::uuid
           AND ($3::bigint IS NULL OR chat_id = $3::bigint)
           AND finished_at IS NULL AND status NOT IN ('completed', 'completed_with_errors', 'cancelled')
         RETURNING id, source, status`,
        [userId, jobId, chatId || null]
    );
    if (result.rows[0]) {
        await query(`UPDATE telegram_download_items SET status = 'skipped', locked_at = NULL, updated_at = NOW() WHERE job_id = $1 AND status = 'pending'`, [result.rows[0].id]);
    }
    return result.rows[0] || null;
}

export async function cancelAllTelegramBackgroundJobs(userId: number) {
    const result = await query(
        `UPDATE telegram_background_jobs
         SET status = 'cancelled', scan_status = 'cancelled', download_status = 'cancelled', cancelled_at = NOW(), finished_at = NOW(), updated_at = NOW()
         WHERE user_id = $1
           AND status NOT IN ('completed', 'completed_with_errors', 'cancelled')
         RETURNING id, source, status`,
        [userId]
    );
    const ids = result.rows.map(row => row.id);
    if (ids.length > 0) {
        await query(
            `UPDATE telegram_download_items
             SET status = 'skipped', locked_at = NULL, updated_at = NOW()
             WHERE job_id = ANY($1::uuid[])
               AND status = 'pending'`,
            [ids]
        );
    }
    return result.rows;
}

export async function retryTelegramBackgroundJobWithQuery(runQuery: TelegramJobQuery, userId: number, selector: string, chatId?: string) {
    const normalized = selector.trim().toLowerCase();
    if (!/^[0-9a-f-]{4,36}$/.test(normalized)) return null;
    const result = await runQuery(
        `WITH matched_job AS (
             SELECT id
             FROM telegram_background_jobs
             WHERE user_id = $1
               AND id::text LIKE $2
               AND ($3::bigint IS NULL OR chat_id = $3::bigint)
               AND cancelled_at IS NULL
               AND paused_at IS NULL
               AND status IN ('failed', 'completed_with_errors')
               AND (cooldown_until IS NULL OR cooldown_until <= NOW())
             GROUP BY id
             HAVING COUNT(*) = 1
             LIMIT 2
         ), unique_job AS (
             SELECT MIN(id::text)::uuid AS id FROM matched_job HAVING COUNT(*) = 1
         ), locked_job AS (
             SELECT j.id
             FROM telegram_background_jobs j
             JOIN unique_job u ON u.id = j.id
             WHERE j.cancelled_at IS NULL
               AND j.paused_at IS NULL
               AND j.status IN ('failed', 'completed_with_errors')
               AND (j.cooldown_until IS NULL OR j.cooldown_until <= NOW())
             FOR UPDATE OF j
         ), retried AS (
             UPDATE telegram_download_items i
             SET status = 'pending', attempts = 0, locked_at = NULL,
                 completed_at = NULL, last_error = NULL, error = NULL, updated_at = NOW()
             FROM locked_job u
             WHERE i.job_id = u.id AND i.status = 'failed'
 AND NOT EXISTS (
     SELECT 1 FROM telegram_write_reconciliations r
     WHERE r.item_id = i.id AND r.status = 'pending'
 )
             RETURNING i.job_id
         ), updated_job AS (
             UPDATE telegram_background_jobs j
             SET status = 'running', download_status = 'active', error = NULL,
                 finished_at = NULL, cooldown_until = NULL, updated_at = NOW()
             FROM locked_job u
             WHERE j.id = u.id
               AND j.cancelled_at IS NULL
               AND j.paused_at IS NULL
               AND j.status IN ('failed', 'completed_with_errors')
               AND (j.cooldown_until IS NULL OR j.cooldown_until <= NOW())
               AND EXISTS (SELECT 1 FROM retried)
             RETURNING j.id
         )
         SELECT updated_job.id, COUNT(retried.*)::int AS retried
         FROM updated_job JOIN retried ON retried.job_id = updated_job.id
         GROUP BY updated_job.id`,
        [userId, `${normalized}%`, chatId || null],
    );
    return result.rows[0] || null;
}

export async function retryTelegramBackgroundJob(userId: number, selector: string, chatId?: string) {
    return retryTelegramBackgroundJobWithQuery(query, userId, selector, chatId);
}

export interface FinalizeSubscriptionJobInput {
    jobId: string;
    subscriptionId: string;
    status: 'completed' | 'completed_with_errors';
    safeAdvanceId: number;
    enqueuedCount: number;
    skippedCount: number;
    error: string | null;
}

export async function finalizeSubscriptionJobWithQuery(
    runQuery: TelegramJobQuery,
    input: FinalizeSubscriptionJobInput,
): Promise<boolean> {
    const finalized = await runQuery(
        `UPDATE telegram_background_jobs
         SET status = $2, enqueued_count = $3, skipped_count = $4, error = $5,
             finished_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND cancelled_at IS NULL
           AND paused_at IS NULL
           AND finished_at IS NULL
           AND status NOT IN ('cancelled', 'paused', 'cooling')
         RETURNING id`,
        [input.jobId, input.status, input.enqueuedCount, input.skippedCount, input.error],
    );
    if ((finalized.rowCount || 0) !== 1) return false;
    const cursor = await runQuery(
        `UPDATE telegram_channel_subscriptions
         SET last_message_id = GREATEST(last_message_id, $1), updated_at = NOW()
         WHERE id = $2 AND enabled = true
         RETURNING id`,
        [input.safeAdvanceId, input.subscriptionId],
    );
    if ((cursor.rowCount || 0) !== 1) throw new Error(`Telegram 订阅 cursor 更新影响 0 行: subscription=${input.subscriptionId}`);
    return true;
}

export async function finalizeSubscriptionJobInTransaction(
    transactionPool: TelegramTransactionPool,
    input: FinalizeSubscriptionJobInput,
): Promise<boolean> {
    const client = await transactionPool.connect();
    try {
        await client.query('BEGIN');
        const finalized = await finalizeSubscriptionJobWithQuery(client.query.bind(client), input);
        if (!finalized) {
            await client.query('ROLLBACK');
            return false;
        }
        await client.query('COMMIT');
        return true;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

async function runSubscriptionScan(botClient: TelegramClient) {
    if (subscriptionScanRunning) return;
    subscriptionScanRunning = true;
    let lockClient: PoolClient | null = null;
    let lockHeld = false;
    try {
        lockClient = await pool.connect();
        const lockResult = await lockClient.query(`SELECT pg_try_advisory_lock(hashtext('tg-vault:telegram-subscription-scan')) AS locked`);
        lockHeld = Boolean(lockResult.rows[0]?.locked);
        if (!lockHeld) return;
        const userClient = getTelegramUserClient();
        if (!userClient || !isTelegramUserClientReady()) return;

        const result = await query(
        `SELECT id, user_id, chat_id, source, source_original, source_type, last_message_id, folder_override
         FROM telegram_channel_subscriptions
         WHERE enabled = true
         ORDER BY updated_at ASC`
    );

    for (const row of result.rows) {
        try {
            await assertTelegramSourceAllowed(row.source, row.source_original ? [row.source_original] : (row.source_type === 'private_invite' ? ['private_invite'] : []));
            const latestMessageId = await getLatestMessageId(userClient, row.source);
            const lastMessageId = Number(row.last_message_id || 0);
            await query(`UPDATE telegram_channel_subscriptions
                         SET last_scan_at = NOW(), last_error = NULL,
                             last_result = jsonb_build_object('status', CASE WHEN $2::int > $3::int THEN 'updates_found' ELSE 'no_updates' END,
                                                              'latestMessageId', $2::int, 'previousMessageId', $3::int)
                         WHERE id = $1`, [row.id, latestMessageId || 0, lastMessageId]);
            if (!latestMessageId || latestMessageId <= lastMessageId) continue;

            const count = Math.min(SUBSCRIPTION_SCAN_LIMIT, latestMessageId - lastMessageId);
            const ids = Array.from({ length: count }, (_, index) => lastMessageId + index + 1);
            const jobId = await createJob(Number(row.user_id), row.chat_id?.toString(), 'subscription_sync', row.source, { subscriptionId: String(row.id), fromId: lastMessageId + 1, toId: latestMessageId });
            const candidateMessages = await expandMessagesWithMediaGroups(userClient, row.source, (await userClient.getMessages(row.source as any, { ids })).filter(Boolean) as Api.Message[]);
            await persistDownloadMessages(jobId, row.source, candidateMessages, row.folder_override || null);
            await updateJob(jobId, { status: 'running', started_at: new Date(), total_count: ids.length });

            const targetChat = row.chat_id || row.user_id;
            const requestMessage = ({ chatId: targetChat, id: latestMessageId } as unknown) as Api.Message;
            const subscriptionRefs = candidateMessages
                .map(message => toChannelDownloadRef(row.source, message))
                .filter((ref): ref is TelegramDownloadMessageRef => Boolean(ref));
            propagateTelegramDownloadGroupContext(subscriptionRefs);
            const downloadableMessageIds = new Set(subscriptionRefs.map(ref => ref.id));
            const nonDownloadableMessageIds = ids.filter(id => !downloadableMessageIds.has(id));
            const downloadResult = await downloadPendingForJob(
                botClient,
                requestMessage,
                jobId,
                row.source,
                row.folder_override || null,
                {},
                true,
            );
            const cooledJob = await getJob(jobId);
            if (cooledJob?.status === 'cooling') {
                await notifyStorageCooldownOnce(botClient, cooledJob, new Date(cooledJob.cooldown_until));
                continue;
            }
            const latestJob = await getJob(jobId);
            if (latestJob?.cancelled_at || latestJob?.status === 'cancelled') continue;
            if (latestJob?.paused_at || latestJob?.status === 'paused') continue;
            const remainingStats = await getJobItemStats(jobId);
            if (Number(remainingStats.pending || 0) + Number(remainingStats.downloading || 0) > 0) continue;
            const scannedMaxId = ids.length > 0 ? ids[ids.length - 1] : lastMessageId;
            const safeAdvanceId = downloadResult.failed > 0
                ? contiguousProcessedMessageId(lastMessageId, downloadResult.successfulMessageIds, [...downloadResult.skippedMessageIds, ...nonDownloadableMessageIds], downloadResult.failedMessageIds)
                : scannedMaxId;
            const finalized = await finalizeSubscriptionJobInTransaction(pool as unknown as TelegramTransactionPool, {
                jobId,
                subscriptionId: String(row.id),
                status: downloadResult.failed > 0 ? 'completed_with_errors' : 'completed',
                safeAdvanceId,
                enqueuedCount: downloadResult.found,
                skippedCount: downloadResult.skipped,
                error: downloadResult.failed > 0 ? `${downloadResult.failed} 个文件下载失败` : null,
            });
            if (!finalized) continue;
            await query(`UPDATE telegram_channel_subscriptions
                         SET last_success_at = NOW(), last_error = $2,
                             last_result = jsonb_build_object('status', $3::text, 'found', $4::int, 'skipped', $5::int, 'failed', $6::int)
                         WHERE id = $1`, [row.id, downloadResult.failed > 0 ? `${downloadResult.failed} 个文件下载失败` : null, downloadResult.failed > 0 ? 'partial_failure' : 'success', downloadResult.found, downloadResult.skipped, downloadResult.failed]);
            if (downloadResult.found > 0) {
                await botClient.sendMessage(targetChat, { message: `✅ 订阅 ${row.source} 已同步 ${downloadResult.found} 个新文件，跳过 ${downloadResult.skipped} 条${downloadResult.failed ? `，失败 ${downloadResult.failed} 条` : ''}${safeAdvanceId < latestMessageId ? '。本轮达到扫描上限或存在失败项，剩余将在后续继续处理。' : '。'}` }).catch(() => undefined);
            }
        } catch (error) {
            console.error('🤖 Telegram 订阅同步失败:', error);
            const safeError = error instanceof Error ? error.message.slice(0, 500) : '订阅同步失败';
            await query(`UPDATE telegram_channel_subscriptions
                         SET last_scan_at = NOW(), last_error = $2,
                             last_result = jsonb_build_object('status', 'failed')
                         WHERE id = $1`, [row.id, safeError]).catch(() => undefined);
            if (isTelegramSourceInaccessibleError(error)) {
                recordTelegramUserClientFailure('permission_denied', '当前 Telegram 用户账号无法访问订阅来源');
                const reason = subscriptionDisabledReason(error);
                await pauseTelegramSubscriptionForError(row.id, reason).catch(updateError => console.error('🤖 暂停不可访问的 Telegram 订阅失败:', updateError));
                const targetChat = row.chat_id || row.user_id;
                await botClient.sendMessage(targetChat, {
                    message: `⚠️ 已暂停订阅 ${row.source_original || row.source}\n${reason}\n\n你可以在 /tg_subs 或 /tg_sub 订阅列表中查看提醒；确认账号可访问后重新添加订阅即可。`,
                }).catch(() => undefined);
            }
        }
        }
    } finally {
        if (lockHeld && lockClient) await lockClient.query(`SELECT pg_advisory_unlock(hashtext('tg-vault:telegram-subscription-scan'))`).catch(() => undefined);
        lockClient?.release();
        subscriptionScanRunning = false;
    }
}

async function recoverTelegramJob(botClient: TelegramClient, job: any): Promise<void> {
    const itemResult = await query(
        `SELECT file_name, mime_type, folder_override
         FROM telegram_download_items
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY created_at ASC`,
        [job.id]
    );
    if (itemResult.rows.length === 0) return;

    const missingMetadata = itemResult.rows.filter(row => !row.file_name || !row.mime_type).length;
    if (missingMetadata > 0) {
        const userClient = getTelegramUserClient();
        if (userClient) {
            await hydratePendingDownloadRefs(userClient, job.id);
            return recoverTelegramJob(botClient, job);
        }
        await updateJob(job.id, { status: 'failed', error: `${missingMetadata} 个待下载条目缺少文件元数据，无法恢复`, finished_at: new Date() });
        return;
    }

    const targetChat = job.chat_id || job.user_id;
    const requestMessage = ({ chatId: targetChat, id: 0 } as unknown) as Api.Message;
    try {
        const latest = await getJob(job.id);
        if (!latest || latest.cancelled_at || latest.status === 'cancelled') return;
        if (latest.paused_at || latest.status === 'paused') return;
        console.log(`♻️ 恢复 Telegram 下载任务 ${String(job.id).slice(0, 12)}，待处理 ${itemResult.rows.length} 个文件`);
        await updateJob(job.id, { status: 'running', started_at: job.started_at || new Date(), error: null });
        const result = await downloadPendingForJob(
            botClient,
            requestMessage,
            String(job.id),
            job.source,
            itemResult.rows[0]?.folder_override || null,
            {},
            true,
        );
        const cooledJob = await getJob(job.id);
        if (cooledJob?.status === 'cooling') {
            await notifyStorageCooldownOnce(botClient, cooledJob, new Date(cooledJob.cooldown_until));
            return;
        }
        const latestJob = await getJob(job.id);
        if (latestJob?.cancelled_at || latestJob?.status === 'cancelled') return;
        if (latestJob?.paused_at || latestJob?.status === 'paused') return;
        const remainingStats = await getJobItemStats(job.id);
        if (Number(remainingStats.pending || 0) + Number(remainingStats.downloading || 0) > 0) return;
        const persistedFailed = Number(remainingStats.failed || 0);
        let finalized: boolean;
        if (job.kind === 'subscription_sync') {
            const subscriptionId = String(job.params?.subscriptionId || '');
            const targetMessageId = Number(job.params?.toId || 0);
            if (!subscriptionId || targetMessageId <= 0) {
                throw new Error('恢复订阅任务缺少 subscriptionId/toId，禁止非原子推进 cursor');
            }
            const recoveryHasFailures = persistedFailed > 0 || result.failed > 0;
            const persistedFailureBoundary = recoveryHasFailures
                ? await query(
                    `SELECT MIN(message_id)::int AS first_failed_id
                     FROM telegram_download_items
                     WHERE job_id = $1 AND status = 'failed'`,
                    [job.id],
                )
                : null;
            const firstFailedId = Number(persistedFailureBoundary?.rows[0]?.first_failed_id || 0);
            finalized = await finalizeSubscriptionJobInTransaction(pool as unknown as TelegramTransactionPool, {
                jobId: String(job.id),
                subscriptionId,
                status: recoveryHasFailures ? 'completed_with_errors' : 'completed',
                safeAdvanceId: recoveryHasFailures
                    ? (firstFailedId > 0
                        ? Math.max(Number(job.params?.fromId || 1) - 1, firstFailedId - 1)
                        : contiguousProcessedMessageId(Number(job.params?.fromId || 1) - 1, result.successfulMessageIds, result.skippedMessageIds, result.failedMessageIds))
                    : targetMessageId,
                enqueuedCount: result.found,
                skippedCount: result.skipped,
                error: recoveryHasFailures ? `${persistedFailed || result.failed} 个文件下载失败` : null,
            });
        } else {
            finalized = (await updateJob(job.id, {
                status: result.failed > 0 ? 'completed_with_errors' : 'completed',
                download_status: result.failed > 0 ? 'completed_with_errors' : 'completed',
                cooldown_until: null,
                enqueued_count: result.found,
                skipped_count: result.skipped,
                error: result.failed > 0 ? `${result.failed} 个文件下载失败` : null,
                finished_at: new Date(),
            })) === 1;
        }
        if (!finalized) return;
        await botClient.sendMessage(targetChat, {
            message: `♻️ 已恢复并完成任务 ${String(job.id).slice(0, 12)}：成功 ${result.successful}，跳过 ${result.skipped}，失败 ${result.failed}`,
        }).catch(() => undefined);
    } catch (error) {
        await updateJob(job.id, { status: 'failed', error: error instanceof Error ? error.message : String(error), finished_at: new Date() });
        throw error;
    }
}

export async function repairTelegramJobInvariantsWithQuery(runQuery: TelegramJobQuery = query): Promise<number> {
    const result = await runQuery(
        `WITH inconsistent AS (
             SELECT j.id,
                    COUNT(*) FILTER (WHERE i.status IN ('pending', 'downloading'))::int AS unfinished_count
             FROM telegram_background_jobs j
             JOIN telegram_download_items i ON i.job_id = j.id
             WHERE j.cancelled_at IS NULL
               AND j.paused_at IS NULL
               AND j.status IN ('completed', 'completed_with_errors', 'failed', 'running')
             GROUP BY j.id, j.finished_at, j.status
             HAVING COUNT(*) FILTER (WHERE i.status = 'pending') > 0
                AND (j.finished_at IS NOT NULL OR j.status IN ('completed', 'completed_with_errors', 'failed'))
         ), reset_items AS (
             UPDATE telegram_download_items i
             SET status = 'pending', locked_at = NULL, completed_at = NULL, updated_at = NOW()
             FROM inconsistent x
             WHERE i.job_id = x.id
               AND i.status = 'downloading'
               AND (i.locked_at IS NULL OR i.locked_at < NOW() - INTERVAL '30 minutes')
               AND NOT EXISTS (
                   SELECT 1 FROM telegram_write_reconciliations r
                   WHERE r.item_id = i.id AND r.status = 'pending'
               )
             RETURNING i.job_id
         ), repaired AS (
             UPDATE telegram_background_jobs j
             SET status = 'running',
                 finished_at = NULL,
                 cancelled_at = NULL,
                 download_status = 'active',
                 scan_status = CASE
                     WHEN j.params ? 'mode' AND COALESCE(j.scan_status, 'pending') <> 'done' THEN j.scan_status
                     ELSE 'done'
                 END,
                 error = CASE WHEN j.error IS NULL THEN '检测到未完成下载条目，已自动恢复' ELSE j.error END,
                 updated_at = NOW()
             FROM inconsistent x
             WHERE j.id = x.id
             RETURNING j.id
         )
         SELECT COUNT(*)::int AS repaired_jobs FROM repaired`
    );
    return Number(result.rows[0]?.repaired_jobs || 0);
}

export async function recoverInterruptedTelegramJobs(botClient: TelegramClient): Promise<void> {
    if (recoveryRunning) return;
    recoveryRunning = true;
    let lockClient: PoolClient | null = null;
    let lockHeld = false;
    try {
        const client = await pool.connect();
        lockClient = client;
        const lockResult = await client.query(`SELECT pg_try_advisory_lock(hashtext('tg-vault:telegram-job-recovery')) AS locked`);
        lockHeld = Boolean(lockResult.rows[0]?.locked);
        if (!lockHeld) return;
        const reconciliationLease = crypto.randomUUID();
        const pendingWrites = await claimTelegramWriteReconciliations(pool, reconciliationLease, 100);
        for (const pendingWrite of pendingWrites) {
            const target = storageManager.getTarget(pendingWrite.provider, pendingWrite.accountId);
            await resolveClaimedTelegramWrite({
                db: pool,
                leaseToken: reconciliationLease,
                row: pendingWrite,
                deleteObject: storedPath => target.provider.deleteFile(storedPath),
            }).catch(error => console.error(`♻️ Telegram write journal resolve 失败: ${pendingWrite.operationId}`, error));
        }
        const repaired = await repairTelegramJobInvariantsWithQuery();
        if (repaired > 0) console.warn(`♻️ 已修复 ${repaired} 个 Telegram 父子任务状态不一致`);
        await clearExpiredStorageCooldowns();
        await query(
            `UPDATE telegram_background_jobs
             SET status = 'running', download_status = 'active', cooldown_until = NULL, error = NULL, updated_at = NOW()
             WHERE status = 'cooling'
               AND cooldown_until IS NOT NULL
               AND cooldown_until <= NOW()
               AND paused_at IS NULL
               AND cancelled_at IS NULL
               AND finished_at IS NULL`
        );
        await query(
            `UPDATE telegram_download_items
             SET status = 'pending', locked_at = NULL, updated_at = NOW()
             WHERE status = 'downloading'
               AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
               AND NOT EXISTS (
                   SELECT 1 FROM telegram_write_reconciliations r
                   WHERE r.item_id = telegram_download_items.id AND r.status = 'pending'
               )
               AND EXISTS (
                   SELECT 1 FROM telegram_background_jobs j
                   WHERE j.id = telegram_download_items.job_id
                     AND j.finished_at IS NULL
                     AND j.cancelled_at IS NULL
                     AND j.paused_at IS NULL
                     AND j.status NOT IN ('cancelled', 'paused')
               )`
        );
        const jobs = await query(
            `SELECT DISTINCT j.*
             FROM telegram_background_jobs j
             JOIN telegram_download_items i ON i.job_id = j.id
             WHERE j.kind IN ('date_range', 'tag_download', 'subscription_sync')
               AND j.finished_at IS NULL
               AND j.cancelled_at IS NULL
               AND j.status IN ('pending', 'running', 'failed', 'completed_with_errors', 'cooling')
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
        const client = lockClient;
        if (lockHeld && client) {
            await client.query(`SELECT pg_advisory_unlock(hashtext('tg-vault:telegram-job-recovery'))`).catch(() => undefined);
        }
        client?.release();
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
