import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
    ffmpegInputArgs, mediaThreads, mediaPreviewTimeoutMs, mediaConcurrency, mediaQueueLimit, probeMedia,
    runMediaProcess, runMediaTask,
} from './mediaControl.js';
import type { MediaProbeData } from './mediaControl.js';

const directory = path.resolve(process.env.PREVIEW_DIR || './data/previews');
interface PreviewFlight {
    promise: Promise<string | null>;
    controller: AbortController;
    consumers: number;
}
const flights = new Map<string, PreviewFlight>();
const compatible = new Map<string, boolean>();
const activePaths = new Set<string>();
const minFree = Math.max(0, Number(process.env.PREVIEW_MIN_FREE_BYTES) || 1024 ** 3);

export function isPreviewPathActive(filePath: string): boolean {
    return activePaths.has(path.resolve(filePath));
}

function browserCompatible(data: MediaProbeData): boolean {
    const videos = data.streams.filter(s => s.codec_type === 'video');
    const audios = data.streams.filter(s => s.codec_type === 'audio');
    // ffprobe combines MOV/MP4 names. Require an MP4 brand, not a filename/MIME guess.
    const brand = String(data.format.tags?.major_brand || '').trim();
    return (data.format.format_name || '').split(',').includes('mp4')
        && /^(isom|iso[2-9]|mp4[12]|avc1|M4V|M4A)$/.test(brand)
        && videos.length === 1 && videos[0].codec_name === 'h264'
        && videos[0].pix_fmt === 'yuv420p'
        && audios.every(s => s.codec_name === 'aac' || s.codec_name === 'mp3');
}

function consumeFlight(flight: PreviewFlight, signal?: AbortSignal): Promise<string | null> {
    flight.consumers++;
    let subscribed = true;
    const unsubscribe = () => {
        if (!subscribed) return;
        subscribed = false;
        flight.consumers--;
        if (flight.consumers === 0 && signal?.aborted) flight.controller.abort(signal.reason);
    };
    signal?.addEventListener('abort', unsubscribe, { once: true });
    // Wait for shared work to settle even when this consumer aborts. Its source
    // may be a temporary upload file, so the caller must not clean it up early.
    return flight.promise.then(result => {
        signal?.throwIfAborted();
        return result;
    }, error => {
        signal?.throwIfAborted();
        throw error;
    }).finally(() => {
        signal?.removeEventListener('abort', unsubscribe);
        unsubscribe();
    });
}

/** Shared by lazy HTTP requests and uploads. null is intentional; errors reject.
 * File IDs identify immutable originals even when cloud staging paths differ.
 * Never returns the source path: callers may persist/delete the preview basename.
 */
export function generateMediaPreview(
    filePath: string, _storedName: string, mimeType: string, fileId?: string, signal?: AbortSignal,
): Promise<string | null> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const source = path.resolve(filePath);
    const key = crypto.createHash('sha256').update(`v2:${fileId || source}`).digest('hex');
    const existing = flights.get(key);
    if (existing) return consumeFlight(existing, signal);
    // Bound outstanding preview flights without a second processing gate.
    if (flights.size >= mediaQueueLimit + mediaConcurrency) return Promise.reject(new Error('Preview queue full'));
    const controller = new AbortController();
    const workSignal = controller.signal;
    const task = (async () => {
        let temporary: string | undefined;
        let output: string | undefined;
        try {
            if (!mimeType.startsWith('video/') && (!mimeType.startsWith('image/') || mimeType === 'image/gif')) return null;
            await fs.access(source);
            workSignal.throwIfAborted();
            if (compatible.has(key)) {
                compatible.delete(key); compatible.set(key, true);
                return null;
            }
            await fs.mkdir(directory, { recursive: true });
            output = path.join(directory, `preview_${key}.${mimeType.startsWith('video/') ? 'mp4' : 'webp'}`);
            if (source === output) throw new Error('Preview source aliases output');
            activePaths.add(output);
            const cached = await fs.lstat(output).catch(() => null);
            if (cached?.isFile() && cached.size > 0) {
                // Lease grace for the DB pointer write after returning to the caller.
                await fs.utimes(output, new Date(), new Date());
                return output;
            }
            if (mimeType.startsWith('video/') && browserCompatible(await probeMedia(source, workSignal))) {
                compatible.set(key, true);
                if (compatible.size > 4096) compatible.delete(compatible.keys().next().value!);
                return null;
            }
            const disk = await fs.statfs(directory);
            const sourceStat = await fs.stat(source);
            if (disk.bavail * disk.bsize < minFree + sourceStat.size * 2) throw new Error('Insufficient free space for preview');
            workSignal.throwIfAborted();
            temporary = path.join(directory, `.preview_${key}_${crypto.randomUUID()}.part`);
            activePaths.add(temporary);
            if (mimeType.startsWith('image/')) {
                const target = temporary;
                await runMediaTask(() => sharp(source).rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
                    .webp({ quality: 86, effort: 4 }).toFile(target), workSignal);
            } else {
                await runMediaProcess(process.env.FFMPEG_PATH || 'ffmpeg', [
                    ...ffmpegInputArgs(source), '-vf', 'scale=-2:720', '-c:v', 'libx264', '-c:a', 'aac',
                    '-threads', String(mediaThreads), '-preset', 'veryfast', '-crf', '23',
                    '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline',
                    '-level', '3.1', '-b:a', '128k', '-f', 'mp4', temporary,
                ], { timeoutMs: mediaPreviewTimeoutMs, signal: workSignal });
            }
            workSignal.throwIfAborted();
            if ((await fs.stat(temporary)).size === 0) throw new Error('Empty preview output');
            await fs.rename(temporary, output);
            return output;
        } finally {
            if (temporary) {
                await fs.rm(temporary, { force: true }).catch(() => undefined);
                activePaths.delete(temporary);
            }
            if (output) activePaths.delete(output);
        }
    })().finally(() => { flights.delete(key); });
    const flight = { promise: task, controller, consumers: 0 };
    flights.set(key, flight);
    return consumeFlight(flight, signal);
}
