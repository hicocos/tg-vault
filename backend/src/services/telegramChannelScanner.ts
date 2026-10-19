import type { Api } from 'telegram';
import type { TelegramDownloadMessageRef } from './telegramUpload.js';
import { extractFileInfo, getEstimatedFileSize } from '../utils/telegramMedia.js';

export interface TelegramChannelScanParams {
    mode?: string;
    tag?: string;
    startDateIso?: string;
    endDateIso?: string;
}

export interface TelegramChannelPageRequest {
    limit: number;
    offsetId: number;
    offsetDate?: number;
    search?: string;
}

export async function scanTelegramChannelPage(
    params: TelegramChannelScanParams,
    offsetId: number,
    limit: number,
    getMessages: (request: TelegramChannelPageRequest) => Promise<Api.Message[]>,
    matchesMessage: (message: Api.Message) => boolean,
) {
    const startDateTimestamp = Date.parse(params.startDateIso || '');
    const endDateTimestamp = Date.parse(params.endDateIso || '');
    const batch = await getMessages({
        limit,
        offsetId,
        // Date ranges already contain the inclusive UTC end from parseTelegramDateRange.
        // Telegram's second-resolution offsetDate is exclusive; resume by ID only.
        ...(params.mode === 'date' && offsetId === 0
            ? { offsetDate: Math.floor(endDateTimestamp / 1000) + 1 }
            : {}),
        ...(params.mode === 'tag' ? { search: params.tag } : {}),
    });
    let done = false;
    let nextOffsetId = offsetId;
    let messagesScanned = 0;
    let lastMessageTimestamp: number | undefined;
    const messages: Api.Message[] = [];
    for (const message of batch) {
        nextOffsetId = message.id;
        messagesScanned += 1;
        lastMessageTimestamp = (message.date || 0) * 1000;
        if (params.mode === 'date') {
            if (lastMessageTimestamp > endDateTimestamp) continue;
            if (lastMessageTimestamp < startDateTimestamp) { done = true; break; }
        }
        if (matchesMessage(message)) messages.push(message);
    }
    return {
        messages,
        // Retain this page only, so album siblings already fetched need no second RPC.
        pageMessages: batch,
        messagesScanned,
        lastMessageDate: lastMessageTimestamp === undefined ? undefined : new Date(lastMessageTimestamp).toISOString(),
        done: done || batch.length < limit,
        nextOffsetId,
    };
}

export async function scanTelegramDiscussionMediaRefs(
    source: string,
    postMessages: Api.Message[],
    getMessages: (request: { limit: number; offsetId: number; replyTo: number }) => Promise<Api.Message[]>,
    options: {
        includeComments?: boolean;
        commentsMaxPerPost: number;
        signal?: AbortSignal;
        onRefDiscovered?: (ref: TelegramDownloadMessageRef) => Promise<void> | void;
        onCommentScanProgress?: (scanned: number) => Promise<void> | void;
    },
): Promise<{ refs: TelegramDownloadMessageRef[]; scanned: number; mediaFound: number }> {
    const refs: TelegramDownloadMessageRef[] = [];
    if (!options.includeComments || postMessages.length === 0) {
        return { refs, scanned: 0, mediaFound: 0 };
    }

    const maxPerPost = Math.max(1, Math.floor(options.commentsMaxPerPost));
    const seen = new Set<string>();
    let scanned = 0;
    for (const post of postMessages) {
        if (Number(post.replies?.replies || 0) <= 0) continue;

        let offsetId = 0;
        let scannedForPost = 0;
        while (scannedForPost < maxPerPost) {
            options.signal?.throwIfAborted();
            const limit = Math.min(100, maxPerPost - scannedForPost);
            const batch = await getMessages({ limit, offsetId, replyTo: post.id });
            if (batch.length === 0) break;

            let nextOffsetId = offsetId;
            for (const comment of batch) {
                if (!comment || (offsetId > 0 && comment.id >= offsetId)) continue;
                nextOffsetId = nextOffsetId === 0 ? comment.id : Math.min(nextOffsetId, comment.id);
                scanned++;
                scannedForPost++;

                const fileInfo = extractFileInfo(comment);
                if (!fileInfo) continue;
                const sourceKey = `${comment.chatId?.toString() || source}:${comment.id}`;
                if (seen.has(sourceKey)) continue;
                seen.add(sourceKey);
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
            if (nextOffsetId === offsetId) {
                throw new Error(`TELEGRAM_COMMENT_CURSOR_STALLED: post=${post.id} offset=${offsetId}`);
            }
            offsetId = nextOffsetId;
            await options.onCommentScanProgress?.(scanned);
            if (batch.length < limit) break;
        }
    }
    return { refs, scanned, mediaFound: refs.length };
}

export function messageGroupId(message: Api.Message | undefined): string | undefined {
    const groupedId = message?.groupedId;
    return groupedId ? groupedId.toString() : undefined;
}

export interface TelegramAlbumScanProgress {
    batchesRead: number;
    idsRead: number;
    mediaFound: number;
    boundaryGroups?: number;
    uncertainGroups?: number;
    expandedGroups?: number;
}

export interface TelegramAlbumScanOptions {
    onMedia?: (messages: Api.Message[], progress: TelegramAlbumScanProgress) => Promise<void>;
}

export async function expandTelegramMediaGroups(
    messages: Api.Message[],
    pageMessages: Api.Message[],
    getMessages: (ids: number[]) => Promise<Array<Api.Message | undefined>>,
    hasMedia: (message: Api.Message) => boolean,
    options: TelegramAlbumScanOptions = {},
): Promise<Api.Message[]> {
    const byId = new Map<number, Api.Message>();
    const cache = new Map(pageMessages.map(message => [message.id, message]));
    let discovered: Api.Message[] = [];
    let batchesRead = 0;
    let idsRead = 0;
    const maximumId = 2_147_483_647;
    const groups = new Map<string, {
        members: Set<number>;
        minimum: number;
        maximum: number;
        lower: number;
        upper: number;
        lowerLimit: number;
        upperLimit: number;
        lowerClosed: boolean;
        upperClosed: boolean;
        expanded: boolean;
        uncertain: boolean;
    }>();
    for (const message of messages) {
        cache.set(message.id, message);
        if (hasMedia(message) && !byId.has(message.id)) { byId.set(message.id, message); discovered.push(message); }
        const groupId = messageGroupId(message);
        if (!groupId || groups.has(groupId)) continue;
        groups.set(groupId, {
            members: new Set(), minimum: message.id, maximum: message.id,
            lower: message.id, upper: message.id, lowerLimit: message.id, upperLimit: message.id,
            lowerClosed: false, upperClosed: false, expanded: false, uncertain: false,
        });
    }
    const addGroupMember = (message: Api.Message | undefined) => {
        if (!message) return;
        const groupId = messageGroupId(message);
        const group = groupId ? groups.get(groupId) : undefined;
        if (!group) return;
        if (message.id < group.minimum) group.lowerClosed = false;
        if (message.id > group.maximum) group.upperClosed = false;
        group.minimum = Math.min(group.minimum, message.id);
        group.maximum = Math.max(group.maximum, message.id);
        if (!hasMedia(message)) return;
        group.members.add(message.id);
        if (!byId.has(message.id)) discovered.push(message);
        byId.set(message.id, message);
    };
    for (const message of cache.values()) addGroupMember(message);
    for (const group of groups.values()) {
        // All caption seeds and cached siblings contribute to the fixed bounds.
        group.lowerLimit = Math.max(1, group.minimum - 20);
        group.upperLimit = Math.min(maximumId, group.maximum + 20);
        group.lower = Math.max(1, group.minimum - 2);
        group.upper = Math.min(maximumId, group.maximum + 2);
    }
    const visited = new Set(cache.keys());
    // Ten distinct media members prove completion. Foreign guards only provide
    // heuristic boundaries: unseen siblings beyond them can be skipped under
    // arbitrary interleaving; ambiguous groups get fixed, not exhaustive, bounds.
    const albumLimit = 10;
    const refreshGroups = () => {
        for (const [groupId, group] of groups) {
            if (group.members.size >= albumLimit) continue;
            const expand = () => {
                group.expanded = true;
                group.lower = group.lowerLimit;
                group.upper = group.upperLimit;
                group.lowerClosed = false;
                group.upperClosed = false;
            };
            if (!group.expanded) {
                // Reuse evidence from other groups' requests, including after a
                // heuristic stop. A known foreign message between siblings is
                // interleaving even when those siblings have no readable media.
                for (const message of cache.values()) {
                    if (message.id > group.minimum && message.id < group.maximum
                        && messageGroupId(message) !== groupId) { expand(); break; }
                }
                if (group.minimum < group.lower) {
                    group.lower = Math.max(group.lowerLimit, group.minimum - 2);
                    group.lowerClosed = false;
                }
                if (group.maximum > group.upper) {
                    group.upper = Math.min(group.upperLimit, group.maximum + 2);
                    group.upperClosed = false;
                }
            }
            while (true) {
                let ready = true;
                for (let id = group.lower; id <= group.upper; id++) {
                    if (!visited.has(id)) { ready = false; break; }
                }
                if (!ready) break;
                if (group.expanded) {
                    group.uncertain = true;
                    group.lowerClosed = true;
                    group.upperClosed = true;
                    break;
                }
                let missing = 0;
                for (let id = group.minimum; id <= group.maximum; id++) {
                    missing = cache.has(id) ? 0 : missing + 1;
                    if (missing > 2) { expand(); break; }
                }
                if (group.expanded) continue;
                const advance = (direction: -1 | 1) => {
                    if (direction === -1 ? group.lowerClosed : group.upperClosed) return;
                    const edge = direction === -1 ? group.lower : group.upper;
                    const member = direction === -1 ? group.minimum : group.maximum;
                    const limit = direction === -1 ? group.lowerLimit : group.upperLimit;
                    let foreign = false;
                    for (let id = member + direction; direction === -1 ? id >= edge : id <= edge; id += direction) {
                        if (cache.has(id)) { foreign = true; break; }
                    }
                    if (foreign || edge === (direction === -1 ? 1 : maximumId)) {
                        if (direction === -1) group.lowerClosed = true;
                        else group.upperClosed = true;
                    } else if (Math.abs(edge - member) > 2) {
                        expand();
                    } else if (edge === limit) {
                        // Same-group evidence at the fixed boundary cannot prove
                        // that no additional sibling exists beyond it.
                        expand();
                    } else if (direction === -1) {
                        group.lower--;
                    } else {
                        group.upper++;
                    }
                };
                const previousLower = group.lower;
                const previousUpper = group.upper;
                advance(-1);
                if (!group.expanded) advance(1);
                if (group.expanded) continue;
                if (previousLower === group.lower && previousUpper === group.upper) break;
            }
        }
    };
    const publish = async () => {
        let boundaryGroups = 0;
        let uncertainGroups = 0;
        let expandedGroups = 0;
        for (const group of groups.values()) {
            if (group.expanded) expandedGroups++;
            if (group.members.size >= albumLimit) continue;
            if (group.uncertain) uncertainGroups++;
            else if (group.lowerClosed && group.upperClosed) boundaryGroups++;
        }
        await options.onMedia?.(discovered, {
            batchesRead, idsRead, mediaFound: byId.size, boundaryGroups, uncertainGroups, expandedGroups,
        });
        discovered = [];
    };
    refreshGroups();
    await publish();
    while (true) {
        const pending = new Set<number>();
        for (const group of groups.values()) {
            if (group.members.size >= albumLimit || (group.lowerClosed && group.upperClosed)) continue;
            for (let id = group.lower; id <= group.upper; id++) {
                if (!visited.has(id)) pending.add(id);
            }
        }
        if (!pending.size) break;
        // Rebuild after every successful batch so new edges join the remaining
        // frontier instead of forcing a separate short request next round.
        const batch = Array.from(pending).slice(0, 100);
        const nearby = await getMessages(batch);
        // The caller owns retries. Commit IDs, including deleted ones, only on success.
        for (const id of batch) visited.add(id);
        for (const message of nearby) {
            if (!message) continue;
            cache.set(message.id, message);
            visited.add(message.id);
            addGroupMember(message);
        }
        batchesRead++;
        idsRead += batch.length;
        refreshGroups();
        await publish();
    }
    return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}
