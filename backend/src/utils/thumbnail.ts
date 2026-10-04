import path from 'path';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import crypto from 'crypto';

const THUMBNAIL_DIR = path.resolve(process.env.THUMBNAIL_DIR || './data/thumbnails');

// 确保目录存在
if (!fs.existsSync(THUMBNAIL_DIR)) {
    fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

export { generateMediaPreview } from './previewCache.js';
/**
 * 为图片或视频生成缩略图
 * @returns 返回生成的缩略图绝对路径，失败返回 null
 */
export async function generateThumbnail(filePath: string, storedName: string, mimeType: string): Promise<string | null> {
    const absFilePath = path.resolve(filePath);
    const thumbName = `thumb_${crypto.randomUUID()}.webp`;
    const thumbPath = path.join(THUMBNAIL_DIR, thumbName);

    console.log(`[Thumbnail] 🚀 Starting generation for: ${storedName}`);
    console.log(`[Thumbnail] Source: ${absFilePath}`);
    console.log(`[Thumbnail] Target: ${thumbPath}`);
    console.log(`[Thumbnail] MIME: ${mimeType}`);

    if (!fs.existsSync(absFilePath)) {
        console.error(`[Thumbnail] ❌ Source file does not exist: ${absFilePath}`);
        return null;
    }

    // 对于 GIF 文件，不生成静态缩略图，以便在前端利用原始文件实现动图预览
    if (mimeType === 'image/gif') {
        console.log(`[Thumbnail] ⏩ Skipping GIF to preserve animation`);
        return null;
    }

    try {
        if (mimeType.startsWith('image/')) {
            console.log(`[Thumbnail] 🖼️  Processing image with Sharp...`);
            await sharp(absFilePath)
                .resize(400, 300, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 80 })
                .toFile(thumbPath);
            console.log(`[Thumbnail] ✅ Image thumbnail created: ${thumbName}`);
            return thumbPath;
        } else if (mimeType.startsWith('video/')) {
            console.log(`[Thumbnail] 🎬 Processing video with Ffmpeg...`);

            // 内部辅助函数：尝试特定时间截屏
            const tryScreenshot = (timestamp: string): Promise<boolean> => {
                return new Promise((resolve) => {
                    console.log(`[Thumbnail] 📸 Attempting screenshot at ${timestamp}`);
                    ffmpeg(absFilePath)
                        .screenshots({
                            count: 1,
                            folder: THUMBNAIL_DIR,
                            filename: thumbName,
                            size: '400x300',
                            timestamps: [timestamp],
                        })
                        .on('start', (cmd) => console.log(`[Thumbnail] FFmpeg CMD: ${cmd}`))
                        .on('end', () => {
                            // 某些情况下 end 触发了但文件没生成（例如时间点无效）
                            if (fs.existsSync(thumbPath)) {
                                console.log(`[Thumbnail] ✅ Video thumbnail created at ${timestamp}`);
                                resolve(true);
                            } else {
                                console.warn(`[Thumbnail] ⚠️  FFmpeg finished but file not found at ${timestamp}`);
                                resolve(false);
                            }
                        })
                        .on('error', (err) => {
                            console.error(`[Thumbnail] ❌ FFmpeg error at ${timestamp}:`, err.message);
                            resolve(false);
                        });
                });
            };

            // 1. 尝试 10% 处
            let success = await tryScreenshot('10%');

            // 2. 如果失败，尝试 1 秒处
            if (!success) {
                console.log(`[Thumbnail] 🔄 Retrying at 1s mark...`);
                success = await tryScreenshot('00:00:01');
            }

            if (success) {
                return thumbPath;
            }
        }
    } catch (error: any) {
        console.error(`[Thumbnail] ❌ Unexpected error:`, error.message);
    }
    return null;
}

export async function getImageDimensions(filePath: string, mimeType: string): Promise<{ width: number; height: number }> {
    const absFilePath = path.resolve(filePath);
    console.log(`[Dimensions] 📏 Getting dimensions for: ${absFilePath} (${mimeType})`);

    try {
        if (mimeType.startsWith('image/')) {
            const metadata = await sharp(absFilePath).metadata();
            const result = { width: metadata.width || 0, height: metadata.height || 0 };
            console.log(`[Dimensions] ✅ Image dimensions: ${result.width}x${result.height}`);
            return result;
        } else if (mimeType.startsWith('video/')) {
            return new Promise((resolve) => {
                ffmpeg.ffprobe(absFilePath, (err, metadata) => {
                    if (err) {
                        console.error(`[Dimensions] ❌ Probe failed:`, err.message);
                        resolve({ width: 0, height: 0 });
                    } else {
                        const stream = metadata.streams.find(s => s.width && s.height);
                        const result = {
                            width: stream?.width || 0,
                            height: stream?.height || 0
                        };
                        console.log(`[Dimensions] ✅ Video dimensions: ${result.width}x${result.height}`);
                        resolve(result);
                    }
                });
            });
        }
    } catch (error) {
        console.error('Get dimensions failed:', error);
    }
    return { width: 0, height: 0 };
}
