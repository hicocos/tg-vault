import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
    ffmpegInputArgs, mediaThreads, mediaThumbnailTimeoutMs, MediaProcessTimeoutError,
    probeMedia, runMediaProcess, runMediaTask,
} from './mediaControl.js';

const THUMBNAIL_DIR = path.resolve(process.env.THUMBNAIL_DIR || './data/thumbnails');

if (!fs.existsSync(THUMBNAIL_DIR)) {
    fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

export { generateMediaPreview } from './previewCache.js';

/** Returns null for unsupported media or an ordinary generation failure. */
export async function generateThumbnail(
    filePath: string, storedName: string, mimeType: string, signal?: AbortSignal,
): Promise<string | null> {
    signal?.throwIfAborted();
    const source = path.resolve(filePath);
    const thumbPath = path.join(THUMBNAIL_DIR, `thumb_${crypto.randomUUID()}.webp`);
    if (mimeType === 'image/gif' || (!mimeType.startsWith('image/') && !mimeType.startsWith('video/'))) return null;
    if (!fs.existsSync(source)) return null;

    try {
        if (mimeType.startsWith('image/')) {
            await runMediaTask(() => sharp(source)
                .resize(400, 300, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 80 }).toFile(thumbPath), signal);
        } else {
            let timestamp = 1;
            try {
                const data = await probeMedia(source, signal);
                const duration = Number(data.format.duration);
                if (Number.isFinite(duration) && duration > 0) timestamp = duration * 0.1;
            } catch (error) {
                signal?.throwIfAborted();
                if (error instanceof MediaProcessTimeoutError) throw error;
                console.warn(`[Thumbnail] Duration probe failed for ${storedName}:`, error);
            }
            const screenshot = async (seconds: number) => {
                await runMediaProcess(process.env.FFMPEG_PATH || 'ffmpeg', [
                    '-ss', String(seconds), ...ffmpegInputArgs(source), '-map', '0:v:0',
                    '-frames:v', '1', '-an', '-vf', 'scale=400:300:force_original_aspect_ratio=decrease',
                    '-threads', String(mediaThreads), '-c:v', 'libwebp', '-quality', '80', thumbPath,
                ], { timeoutMs: mediaThumbnailTimeoutMs, signal });
                if (!fs.existsSync(thumbPath) || fs.statSync(thumbPath).size === 0) throw new Error('Empty thumbnail output');
            };
            try {
                await screenshot(timestamp);
            } catch (error) {
                signal?.throwIfAborted();
                if (error instanceof MediaProcessTimeoutError || timestamp === 1) throw error;
                await fs.promises.rm(thumbPath, { force: true });
                await screenshot(1);
            }
        }
        return thumbPath;
    } catch (error) {
        await fs.promises.rm(thumbPath, { force: true }).catch(() => undefined);
        signal?.throwIfAborted();
        if (error instanceof MediaProcessTimeoutError) throw error;
        console.error(`[Thumbnail] Generation failed for ${storedName}:`, error);
        return null;
    }
}

export async function getImageDimensions(
    filePath: string, mimeType: string, signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
    signal?.throwIfAborted();
    const source = path.resolve(filePath);
    try {
        if (mimeType.startsWith('image/')) {
            const metadata = await runMediaTask(() => sharp(source).metadata(), signal);
            return { width: metadata.width || 0, height: metadata.height || 0 };
        }
        if (mimeType.startsWith('video/')) {
            const metadata = await probeMedia(source, signal);
            const stream = metadata.streams.find(s => s.width && s.height);
            return { width: stream?.width || 0, height: stream?.height || 0 };
        }
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof MediaProcessTimeoutError) throw error;
        console.error('Get dimensions failed:', error);
    }
    return { width: 0, height: 0 };
}
