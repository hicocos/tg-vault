import { spawn } from 'node:child_process';
import sharp from 'sharp';

function integerSetting(name: string, fallback: number, min: number, max: number): number {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
export const mediaConcurrency = integerSetting('MEDIA_CONCURRENCY', 1, 1, 4);
export const mediaQueueLimit = integerSetting('MEDIA_QUEUE_LIMIT', 64, 0, 256);

export const mediaThreads = integerSetting('MEDIA_THREADS', 1, 1, 4);
export const mediaThumbnailTimeoutMs = integerSetting('MEDIA_THUMBNAIL_TIMEOUT_MS', 30_000, 1_000, 300_000);
export const mediaProbeTimeoutMs = integerSetting('MEDIA_PROBE_TIMEOUT_MS', 15_000, 1_000, 120_000);
export const mediaPreviewTimeoutMs = integerSetting('MEDIA_PREVIEW_TIMEOUT_MS', 120_000, 1_000, 600_000);

sharp.concurrency(mediaThreads);
sharp.cache({ memory: 16, files: 0, items: 32 });

interface Waiter {
    grant: () => void;
    cancel: () => void;
}

/** Owns a slot until the actual operation settles, including after cancellation. */
export class MediaGate {
    private running = 0;
    private readonly waiters: Waiter[] = [];

    constructor(private readonly concurrency: number, private readonly queueLimit: number) {
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4
            || !Number.isInteger(queueLimit) || queueLimit < 0 || queueLimit > 256) {
            throw new Error('Invalid media gate limits');
        }
    }

    private async acquire(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (this.running < this.concurrency) {
            this.running++;
            return;
        }
        if (this.waiters.length >= this.queueLimit) throw new Error('Media processing queue full');
        await new Promise<void>((resolve, reject) => {
            const waiter: Waiter = {
                grant: () => {
                    signal?.removeEventListener('abort', waiter.cancel);
                    resolve();
                },
                cancel: () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index < 0) return;
                    this.waiters.splice(index, 1);
                    signal?.removeEventListener('abort', waiter.cancel);
                    reject(signal?.reason);
                },
            };
            this.waiters.push(waiter);
            signal?.addEventListener('abort', waiter.cancel, { once: true });
        });
    }

    async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        await this.acquire(signal);
        try {
            signal?.throwIfAborted();
            // Sharp cannot interrupt every native operation. Never race it with abort.
            const result = await work();
            signal?.throwIfAborted();
            return result;
        } finally {
            const next = this.waiters.shift();
            if (next) next.grant();
            else this.running--;
        }
    }
}

const mediaGate = new MediaGate(
    mediaConcurrency,
    mediaQueueLimit,
);

export function runMediaTask<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return mediaGate.run(work, signal);
}

export class MediaProcessTimeoutError extends Error {
    constructor(command: string, timeoutMs: number) {
        super(`${command} timed out after ${timeoutMs}ms`);
        this.name = 'MediaProcessTimeoutError';
    }
}

/** No shell or detached descendants: SIGKILL and close both precede slot release. */
export function runMediaProcess(
    executable: string,
    args: readonly string[],
    options: { timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
    return runMediaTask(() => new Promise<string>((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let failure: unknown;
        let failed = false;
        const stop = (reason: unknown) => {
            if (!failed) {
                failed = true;
                failure = reason;
            }
            child.kill('SIGKILL');
        };
        const abort = () => stop(options.signal!.reason);
        const timer = setTimeout(() => stop(new MediaProcessTimeoutError(executable, options.timeoutMs)), options.timeoutMs);
        options.signal?.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            if (stdout.length + chunk.length > 1024 * 1024) {
                stop(new Error(`${executable} output exceeds 1 MiB`));
            } else stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            stderr = (stderr + chunk).slice(-16_384);
        });
        child.on('error', error => {
            if (!failed) {
                failed = true;
                failure = error;
            }
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
            if (failed) reject(failure);
            else if (code !== 0) reject(new Error(`${executable} exited (${signal || code}): ${stderr.trim()}`));
            else resolve(stdout);
        });
    }), options.signal);
}

export interface MediaProbeData {
    streams: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number }>;
    format: { format_name?: string; duration?: string; tags?: Record<string, unknown> };
}

export async function probeMedia(filePath: string, signal?: AbortSignal): Promise<MediaProbeData> {
    const output = await runMediaProcess(process.env.FFPROBE_PATH || 'ffprobe', [
        '-v', 'error', '-threads', String(mediaThreads), '-show_streams', '-show_format', '-of', 'json', filePath,
    ], { timeoutMs: mediaProbeTimeoutMs, signal });
    return JSON.parse(output) as MediaProbeData;
}

/** Input decoder, simple/complex filters and output encoder all have explicit bounds. */
export function ffmpegInputArgs(filePath: string): string[] {
    return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-filter_threads', String(mediaThreads), '-filter_complex_threads', String(mediaThreads),
        '-threads', String(mediaThreads), '-i', filePath];
}
