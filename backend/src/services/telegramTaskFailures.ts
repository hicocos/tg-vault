export interface TaskFailurePage {
    offset: number;
    limit: number;
}

export interface TelegramTaskFailure {
    id: string;
    fileName: string | null;
    error: string | null;
    messageId: number | null;
    messageUrl: string | null;
    attempts: number;
    updatedAt: string | null;
}

interface FailureRow {
    id: string;
    file_name: string | null;
    error: string | null;
    source: string;
    source_peer: string | null;
    origin: string | null;
    message_id: number | null;
    attempts: number | null;
    updated_at: string | null;
}

type FailureQuery = (sql: string, values: unknown[]) => Promise<{
    rows: Array<{ total: string | number; items: FailureRow[] }>;
}>;

export function parseTaskFailurePage(offset: unknown, limit: unknown): TaskFailurePage | null {
    function integer(value: unknown, fallback: number): number | null {
        if (value === undefined) return fallback;
        if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }
    const parsedOffset = integer(offset, 0);
    const parsedLimit = integer(limit, 10);
    if (parsedOffset === null || parsedLimit === null) return null;
    return { offset: parsedOffset, limit: Math.min(parsedLimit, 20) };
}

function messagePeerPath(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const source = String(value).trim();
    const signedChannel = /^-100([1-9]\d*)$/.exec(source);
    if (signedChannel) return `c/${signedChannel[1]}`;
    if (/^@?[a-z][a-z0-9_]{0,31}$/i.test(source)) {
        const username = source.replace(/^@/, '');
        return /^(?:joinchat|c|s|share|addstickers|addemoji|proxy|socks|login|iv)$/i.test(username) ? null : username;
    }
    // Match the original path, not a URL-normalized path that could hide traversal.
    const link = /^(?:https:\/\/)?t\.me\/([^?#]*)(?:[?#][^\s]*)?$/i.exec(source);
    if (!link) return null;
    const privateChannel = /^c\/([1-9]\d*)(?:\/[1-9]\d*)?\/?$/.exec(link[1]);
    if (privateChannel) return `c/${privateChannel[1]}`;
    const publicChannel = /^(?:s\/)?([a-z][a-z0-9_]{0,31})(?:\/[1-9]\d*)?\/?$/i.exec(link[1]);
    return publicChannel ? messagePeerPath(publicChannel[1]) : null;
}

export function buildTelegramTaskMessageUrl(item: {
    source: unknown;
    sourcePeer?: unknown;
    origin?: unknown;
    messageId: unknown;
}): string | null {
    if (typeof item.messageId !== 'number' || !Number.isSafeInteger(item.messageId) || item.messageId <= 0) return null;
    const hasPeer = item.sourcePeer != null && String(item.sourcePeer).trim() !== '';
    const peer = messagePeerPath(hasPeer ? item.sourcePeer : item.source);
    if (!peer) return null;
    if (item.origin === 'comment') {
        // A comment ID belongs to the discussion group, never to the channel.
        // Older rows may have copied the channel source into source_peer.
        const channel = messagePeerPath(item.source);
        if (!hasPeer || peer.toLowerCase() === channel?.toLowerCase()) return null;
    }
    return `https://t.me/${peer}/${item.messageId}`;
}

export async function getTelegramTaskFailures(jobId: string, page: TaskFailurePage, execute: FailureQuery): Promise<{
    items: TelegramTaskFailure[];
    total: number;
    offset: number;
    limit: number;
} | null> {
    // One statement keeps existence, the current failed count and the page on one snapshot.
    const result = await execute(
        `SELECT (SELECT COUNT(*) FROM telegram_download_items WHERE job_id = j.id AND status = 'failed') AS total,
                COALESCE((SELECT json_agg(failure_page) FROM (
                    SELECT id, LEFT(NULLIF(file_name, ''), 512) AS file_name,
                           LEFT(COALESCE(NULLIF(last_error, ''), NULLIF(error, '')), 4096) AS error,
                           source, source_peer, origin, message_id, attempts, updated_at
                    FROM telegram_download_items
                    WHERE job_id = j.id AND status = 'failed'
                    ORDER BY updated_at DESC, id DESC
                    LIMIT $2 OFFSET $3
                ) failure_page), '[]'::json) AS items
         FROM telegram_background_jobs j WHERE j.id = $1::uuid`,
        [jobId, page.limit, page.offset],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
        items: row.items.map(item => ({
            id: String(item.id),
            fileName: item.file_name,
            error: item.error,
            messageId: item.message_id,
            messageUrl: buildTelegramTaskMessageUrl({
                source: item.source, sourcePeer: item.source_peer, origin: item.origin, messageId: item.message_id,
            }),
            attempts: item.attempts ?? 0,
            updatedAt: item.updated_at,
        })),
        total: Number(row.total),
        offset: page.offset,
        limit: page.limit,
    };
}
