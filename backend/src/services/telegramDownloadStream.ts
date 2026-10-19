import { setTimeout as delay } from 'node:timers/promises';
import { classifyTelegramDownloadAccountError, telegramFloodWaitSeconds } from './telegramUserClientPool.js';
import { withTelegramOperationSignal } from './telegramOperationContext.js';
import { isTelegramTransientDownloadError } from './telegramDownloadRetry.js';

/** A yielded chunk is committed by the consumer before its offset advances. */
export async function* telegramDownloadStream<T extends { length: number }>(
    open: (offset: number) => AsyncIterable<T>,
    options: { offset: number; stride?: number; end?: number; signal?: AbortSignal; beforeRead?: () => Promise<void>;
        recover?: (error: unknown, offset: number, attempt: number, signal?: AbortSignal) => Promise<void> },
): AsyncGenerator<T> {
    let offset = options.offset;
    let networkRetries = 0;
    while (options.end === undefined || offset < options.end) {
        options.signal?.throwIfAborted();
        await options.beforeRead?.();
        const iterator = open(offset)[Symbol.asyncIterator]();
        let iteratorClosed = false;
        try {
            while (options.end === undefined || offset < options.end) {
                options.signal?.throwIfAborted();
                await options.beforeRead?.();
                const next = async () => {
                    await options.beforeRead?.();
                    options.signal?.throwIfAborted();
                    return withTelegramOperationSignal(options.signal, () => iterator.next());
                };
                const result = await next();
                if (result.done) return;
                options.signal?.throwIfAborted();
                await options.beforeRead?.();
                yield result.value;
                offset += options.stride ?? result.value.length;
            }
            return;
        } catch (error) {
            options.signal?.throwIfAborted();
            if (classifyTelegramDownloadAccountError(error) === 'flood_wait') {
                await delay(telegramFloodWaitSeconds(error) * 1000, undefined, { signal: options.signal });
            } else {
                const code = error instanceof Error ? error.message : String(error);
                const botInterrupted = code === 'BOT_CONNECTION_LOST' || code === 'BOT_DC_CONNECTION_LOST' || code === 'BOT_CANCELLED';
                if ((!isTelegramTransientDownloadError(error) && !(options.recover && botInterrupted)) || networkRetries >= 3) throw error;
                networkRetries++;
                await iterator.return?.();
                iteratorClosed = true;
                await delay(300 * 2 ** (networkRetries - 1), undefined, { signal: options.signal });
                await options.recover?.(error, offset, networkRetries, options.signal);
                console.info(JSON.stringify({ event: 'telegram_download_resumed', offset, attempt: networkRetries,
                    code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'TRANSPORT_ERROR' }));
            }
        } finally {
            if (!iteratorClosed) await iterator.return?.();
        }
    }
}

/** Abort sibling stripes on the first error; settle all writes before closing the file. */
export async function runTelegramDownloadStripes<T>(workers: number, operation: (index: number, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T[]> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let failure: unknown;
    const results = await Promise.allSettled(Array.from({ length: workers }, (_, index) =>
        withTelegramOperationSignal(combined, () => operation(index, combined)).catch((error: unknown) => {
            if (!controller.signal.aborted) { failure = error; controller.abort(error); }
            throw error;
        })));
    if (controller.signal.aborted) throw failure;
    combined.throwIfAborted();
    return results.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
    });
}
