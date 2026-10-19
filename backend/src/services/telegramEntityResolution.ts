import type { TelegramClient } from 'telegram';
import { telegramOperationSignal } from './telegramOperationContext.js';

export function isTelegramEntityResolutionError(error: unknown): boolean {
    const value = error as { message?: unknown } | null;
    return /Could not find the input entity|Cannot find any entity/i.test(String(value?.message || error || ''));
}

// StringSession persists authorization, not entities. Rebuild from this account's
// own dialogs on a cache miss; never reuse another account's access hashes.
const dialogLoads = new WeakMap<object, { flight: Promise<void>; expiresAt: number }>();
const DIALOG_REFRESH_INTERVAL_MS = 15 * 60_000;

export async function loadTelegramDialogEntities(client: Pick<TelegramClient, 'iterDialogs' | 'session'>): Promise<void> {
    const signal = telegramOperationSignal();
    signal?.throwIfAborted();
    let entry = dialogLoads.get(client.session);
    if (!entry || entry.expiresAt <= Date.now()) {
        const session = client.session;
        const flight = (async () => {
            for await (const _dialog of client.iterDialogs({})) signal?.throwIfAborted();
            signal?.throwIfAborted();
        })();
        entry = { flight, expiresAt: Infinity };
        dialogLoads.set(session, entry);
        const current = entry;
        void flight.then(() => { current.expiresAt = Date.now() + DIALOG_REFRESH_INTERVAL_MS; }, () => {
            if (dialogLoads.get(session) === current) dialogLoads.delete(session);
        });
    }
    await entry.flight;
    signal?.throwIfAborted();
}
