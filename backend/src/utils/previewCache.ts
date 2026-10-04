import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';

const directory = path.resolve(process.env.PREVIEW_DIR || './data/previews');
const flights = new Map<string, Promise<string | null>>();
const compatible = new Map<string, boolean>();
const activePaths = new Set<string>();
let running = 0;
const waiters: Array<() => void> = [];
const minFree = Math.max(0, Number(process.env.PREVIEW_MIN_FREE_BYTES) || 1024 ** 3);

export function isPreviewPathActive(filePath: string): boolean {
    return activePaths.has(path.resolve(filePath));
}
async function acquire(): Promise<void> {
    if (running < 2) { running++; return; }
    if (waiters.length >= 32) throw new Error('Preview queue full');
    await new Promise<void>(resolve => waiters.push(resolve));
}
function release(): void {
    const next = waiters.shift();
    if (next) next(); else running--;
}
function probe(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => ffmpeg.ffprobe(filePath, (err, data) => err ? reject(err) : resolve(data)));
}
function browserCompatible(data: ffmpeg.FfprobeData): boolean {
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
function run(command: ffmpeg.FfmpegCommand): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => command.kill('SIGKILL'), 120_000);
        command.on('end', () => { clearTimeout(timer); resolve(); })
            .on('error', err => { clearTimeout(timer); reject(err); }).run();
    });
}

/** Shared by lazy HTTP requests and uploads. null is intentional; errors reject.
 * File IDs identify immutable originals even when cloud staging paths differ.
 * Never returns the source path: callers may persist/delete the preview basename.
 */
export function generateMediaPreview(filePath: string, _storedName: string, mimeType: string, fileId?: string): Promise<string | null> {
    const source = path.resolve(filePath);
    const key = crypto.createHash('sha256').update(`v2:${fileId || source}`).digest('hex');
    const existing = flights.get(key);
    if (existing) return existing;
    const task = (async () => {
        await acquire();
        let temporary: string | undefined;
        let output: string | undefined;
        try {
            if (!mimeType.startsWith('video/') && (!mimeType.startsWith('image/') || mimeType === 'image/gif')) return null;
            await fs.access(source);
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
            if (mimeType.startsWith('video/') && browserCompatible(await probe(source))) {
                compatible.set(key, true);
                if (compatible.size > 4096) compatible.delete(compatible.keys().next().value!);
                return null;
            }
            const disk = await fs.statfs(directory);
            const sourceStat = await fs.stat(source);
            if (disk.bavail * disk.bsize < minFree + sourceStat.size * 2) throw new Error('Insufficient free space for preview');
            temporary = path.join(directory, `.preview_${key}_${crypto.randomUUID()}.part`);
            activePaths.add(temporary);
            if (mimeType.startsWith('image/')) {
                await sharp(source).rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
                    .webp({ quality: 86, effort: 4 }).toFile(temporary);
            } else {
                await run(ffmpeg(source).videoCodec('libx264').audioCodec('aac')
                    .size('?x720').outputOptions(['-threads 1', '-preset veryfast', '-crf 23',
                        '-movflags +faststart', '-pix_fmt yuv420p', '-profile:v baseline', '-level 3.1', '-b:a 128k'])
                    .format('mp4').output(temporary));
            }
            if ((await fs.stat(temporary)).size === 0) throw new Error('Empty preview output');
            await fs.rename(temporary, output);
            return output;
        } finally {
            if (temporary) {
                await fs.rm(temporary, { force: true }).catch(() => undefined);
                activePaths.delete(temporary);
            }
            if (output) activePaths.delete(output);
            release();
        }
    })().finally(() => { flights.delete(key); });
    flights.set(key, task);
    return task;
}
