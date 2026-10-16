import { Api, type TelegramClient } from 'telegram';

export class TelegramHistoryUnverifiedError extends Error {
    constructor(readonly reason = 'EMPTY_HISTORY') {
        super(`TELEGRAM_HISTORY_UNVERIFIED: ${reason}`);
        this.name = 'TelegramHistoryUnverifiedError';
    }
}

function isChannelReadDenied(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error);
    return /CHANNEL_PRIVATE|USER_NOT_PARTICIPANT/.test(text);
}
// Callers must retain this only for the same account and source.
export interface TelegramScanVisibility {
    latestMessageId: number;
    joined: boolean;
    checkedAt: number;
}

const VISIBILITY_MAX_AGE_MS = 30_000;

// Proxy views of one account share its session; separate accounts never share joins.
const publicChannelJoins = new WeakMap<object, Map<string, { flight: Promise<void>; expiresAt: number }>>();
/** Each account reads first; joining only repairs an unreadable, unjoined public source. */
export async function verifyTelegramScanVisibility(
    client: Pick<TelegramClient, 'getMessages' | 'getEntity' | 'invoke' | 'session'>,
    source: Api.TypeEntityLike,
    checkpointId = 0,
): Promise<TelegramScanVisibility> {
    let latest: Api.Message | undefined;
    try { [latest] = await client.getMessages(source, { limit: 1 }); }
    catch (error) { if (!isChannelReadDenied(error)) throw error; }
    let joined = false;
    if (!latest?.id) {
        const publicSource = typeof source === 'string' && (/^@?[a-z][a-z\d_]*$/i.test(source)
            || /^(?:https?:\/\/)?(?:www\.)?t\.me\/(?:s\/)?(?!joinchat(?:\/|$))[a-z][a-z\d_]*(?:\/\d+)?\/?(?:[?#].*)?$/i.test(source));
        if (publicSource) {
            const entity = await client.getEntity(source);
            const restrictions = entity instanceof Api.Channel
                ? entity.restrictionReason?.map(reason => `${reason.platform}:${reason.reason}`).join(',') : undefined;
            // Platform-specific labels (e.g. ios) do not restrict this server client.
            // A server-wide content block cannot be repaired by joining.
            if (entity instanceof Api.Channel && entity.restrictionReason?.some(reason => reason.platform.split('-').includes('all'))) {
                throw new TelegramHistoryUnverifiedError(`RESTRICTED ${restrictions}`);
            }
            if (entity instanceof Api.Channel && entity.username && entity.left) {
                if (entity.joinRequest) throw new TelegramHistoryUnverifiedError('JOIN_APPROVAL_REQUIRED');
                if (entity.bannedRights?.viewMessages) throw new TelegramHistoryUnverifiedError('CHANNEL_READ_BANNED');
                let joins = publicChannelJoins.get(client.session);
                if (!joins) { joins = new Map(); publicChannelJoins.set(client.session, joins); }
                const now = Date.now();
                for (const [key, entry] of joins) if (entry.expiresAt <= now) joins.delete(key);
                const channelId = entity.id.toString();
                let entry = joins.get(channelId);
                if (!entry) {
                    const flight = (async () => {
                        try {
                            await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
                        } catch (error) {
                            const code = error && typeof error === 'object' && 'errorMessage' in error
                                ? String(error.errorMessage) : error instanceof Error ? error.message : String(error);
                            if (/USER_ALREADY_PARTICIPANT/.test(code)) return;
                            if (/FLOOD|AUTH_KEY|SESSION_|USER_DEACTIVATED/.test(code)) throw error;
                            throw new TelegramHistoryUnverifiedError(code);
                        }
                    })();
                    entry = { flight, expiresAt: Infinity };
                    joins.set(channelId, entry);
                }
                try {
                    await entry.flight;
                    entry.expiresAt = Date.now() + VISIBILITY_MAX_AGE_MS;
                    joined = true;
                } catch (error) {
                    // Do not repeat approval/limit/permission failures for every file.
                    // Flood/session/cancellation errors stay owned by the account pool.
                    if (error instanceof TelegramHistoryUnverifiedError) entry.expiresAt = Date.now() + 15 * 60_000;
                    else if (joins.get(channelId) === entry) joins.delete(channelId);
                    throw error;
                }
                [latest] = await client.getMessages(source, { limit: 1 });
                console.info(JSON.stringify({ event: 'telegram_public_channel_join', source, joined,
                    readable: Boolean(latest?.id), restrictions }));
            }
            if (!latest?.id && restrictions) throw new TelegramHistoryUnverifiedError(`RESTRICTED ${restrictions}`);
        }
    }
    if (!latest?.id) throw new TelegramHistoryUnverifiedError();
    if (checkpointId > 0) {
        const checkpoint = await client.getMessages(source, { ids: [checkpointId] });
        if (!checkpoint.some(message => message?.id === checkpointId)) {
            throw new TelegramHistoryUnverifiedError('CHECKPOINT_NOT_VISIBLE');
        }
    }
    return { latestMessageId: latest.id, joined, checkedAt: Date.now() };
}

/** A missing search/file response is not evidence that the source is readable. */
export async function getTelegramMessagesWithAccess(
    client: Pick<TelegramClient, 'getMessages' | 'getEntity' | 'invoke' | 'session'>,
    source: Api.TypeEntityLike,
    request: Parameters<TelegramClient['getMessages']>[1],
    visibility?: TelegramScanVisibility,
) {
    let emptyResult: Api.Message[] | undefined;
    try {
        const messages = await client.getMessages(source, request);
        if (messages.some(message => message?.id)) return messages;
        emptyResult = messages;
        if (visibility && Date.now() - visibility.checkedAt < VISIBILITY_MAX_AGE_MS) return messages;
    } catch (error) {
        if (!isChannelReadDenied(error)) throw error;
    }
    const verified = await verifyTelegramScanVisibility(client, source);
    if (visibility) Object.assign(visibility, verified);
    return emptyResult && !verified.joined ? emptyResult : client.getMessages(source, request);
}
