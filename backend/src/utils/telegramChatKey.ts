export function canonicalTelegramChatKey(value: unknown): string {
    return String(value ?? '').trim();
}

function numericPeerValue(value: unknown): string {
    return canonicalTelegramChatKey(value).replace(/^\+/, '');
}

export function telegramChatKeyFromPeerParts(
    peer: { userId?: unknown; chatId?: unknown; channelId?: unknown } | null | undefined,
    fallbackUserId?: unknown,
): string {
    if (peer?.userId !== undefined && peer.userId !== null) {
        return numericPeerValue(peer.userId);
    }
    if (peer?.chatId !== undefined && peer.chatId !== null) {
        const value = numericPeerValue(peer.chatId);
        return value.startsWith('-') ? value : `-${value}`;
    }
    if (peer?.channelId !== undefined && peer.channelId !== null) {
        const value = numericPeerValue(peer.channelId);
        if (/^-100\d+$/.test(value)) return value;
        return `-100${value.replace(/^-/, '')}`;
    }
    return numericPeerValue(fallbackUserId);
}
