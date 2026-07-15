export const TELEGRAM_SUBSCRIPTION_PAGE_SIZE = 5;

export type TelegramSubscriptionRow = {
    id: string;
    title?: string | null;
    source?: string | null;
};

export type TelegramSubscriptionPage<T extends TelegramSubscriptionRow> = {
    page: number;
    totalPages: number;
    startIndex: number;
    visibleRows: T[];
};

export function buildTelegramSubscriptionPage<T extends TelegramSubscriptionRow>(
    rows: T[],
    requestedPage = 0,
): TelegramSubscriptionPage<T> {
    const totalPages = Math.max(1, Math.ceil(rows.length / TELEGRAM_SUBSCRIPTION_PAGE_SIZE));
    const page = Math.min(Math.max(0, Math.floor(requestedPage || 0)), totalPages - 1);
    const startIndex = page * TELEGRAM_SUBSCRIPTION_PAGE_SIZE;
    return {
        page,
        totalPages,
        startIndex,
        visibleRows: rows.slice(startIndex, startIndex + TELEGRAM_SUBSCRIPTION_PAGE_SIZE),
    };
}

export type TelegramSubscriptionCallback =
    | { kind: 'page'; page: number }
    | { kind: 'action'; action: 'view' | 'folder' | 'clear' | 'cancel'; id: string; page: number }
    | { kind: 'confirm' | 'back'; token: string };

export function parseTelegramSubscriptionCallback(data: string): TelegramSubscriptionCallback | null {
    let match = data.match(/^tsub_page_(\d{1,6})$/);
    if (match) return { kind: 'page', page: Number(match[1]) };

    match = data.match(/^tsub_(view|folder|clear|cancel)_([0-9a-f-]{36})(?:_(\d{1,6}))?$/i);
    if (match) {
        return {
            kind: 'action',
            action: match[1] as 'view' | 'folder' | 'clear' | 'cancel',
            id: match[2],
            page: Number(match[3] || 0),
        };
    }

    match = data.match(/^tsub_(confirm|back)_([A-Za-z0-9_-]{1,64})$/);
    if (match) return { kind: match[1] as 'confirm' | 'back', token: match[2] };
    return null;
}
