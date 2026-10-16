import { setTimeout as delay } from 'node:timers/promises';
import { classifyTelegramDownloadAccountError, telegramFloodWaitSeconds } from './telegramUserClientPool.js';
import { withTelegramOperationSignal } from './telegramOperationContext.js';

/** Keep each stripe's committed offset across FLOOD_WAIT; never restart the file. */
export async function* telegramDownloadStream<T extends { length: number }>(
    open: (offset: number) => AsyncIterable<T>,
    options: { offset: number; stride?: number; end?: number; signal?: AbortSignal; beforeRead?: () => Promise<void> },
): AsyncGenerator<T> {
    let offset = options.offset;
    while (options.end === undefined || offset < options.end) {
        options.signal?.throwIfAborted();
        await options.beforeRead?.();
        const iterator = open(offset)[Symbol.asyncIterator]();
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
            if (classifyTelegramDownloadAccountError(error) !== 'flood_wait') throw error;
            await delay(telegramFloodWaitSeconds(error) * 1000, undefined, { signal: options.signal });
        } finally {
            await iterator.return?.();
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
