import type { Readable } from 'node:stream';
import type { StorageUploadProgress } from './contracts.js';

/** Observe delivered data without attaching a listener that starts flowing before the uploader. */
export function trackUploadProgress<T extends Readable>(source: T, totalBytes: number, onProgress?: StorageUploadProgress): T {
    if (!onProgress) return source;
    let transferredBytes = 0;
    const emit = source.emit;
    source.emit = function (event: string | symbol, ...args: unknown[]): boolean {
        if (event === 'data') {
            const chunk = args[0] as Buffer | string;
            transferredBytes = Math.min(totalBytes, transferredBytes + Buffer.byteLength(chunk));
            onProgress(transferredBytes, totalBytes);
        }
        return emit.call(this, event, ...args);
    };
    onProgress(0, totalBytes);
    return source;
}
