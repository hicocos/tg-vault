import fs from 'node:fs/promises';
import path from 'node:path';
import { isPreviewPathActive } from './previewCache.js';

/** Only generated names, never originals/symlinks/subdirectories. A fresh DB check
 * covers ALL accounts (cloud previews are durable local derivatives, not evictable).
 * Fail closed on DB errors. Grace also protects publication -> DB update windows.
 */
export async function cleanupPreviewOrphans(
    directory: string,
    isReferenced: (basename: string) => Promise<boolean>,
    graceMs = 24 * 60 * 60 * 1000,
): Promise<{ deletedCount: number; freedBytes: number; deletedFiles: string[] }> {
    const result = { deletedCount: 0, freedBytes: 0, deletedFiles: [] as string[] };
    let entries;
    try { entries = await fs.opendir(directory); }
    catch (error: any) { if (error.code === 'ENOENT') return result; throw error; }
    for await (const entry of entries) {
        if (!entry.isFile() || !/^(?:preview_[a-f0-9-]+\.(?:mp4|webp)|\.preview_[a-f0-9_\-]+\.part)$/.test(entry.name)) continue;
        const target = path.join(directory, entry.name);
        const old = await fs.lstat(target).catch(() => null);
        if (!old?.isFile() || Date.now() - old.mtimeMs < graceMs || isPreviewPathActive(target)) continue;
        if (await isReferenced(entry.name)) continue;
        const current = await fs.lstat(target).catch(() => null);
        if (!current?.isFile() || current.ino !== old.ino || current.mtimeMs !== old.mtimeMs || isPreviewPathActive(target)) continue;
        await fs.unlink(target);
        result.deletedCount++;
        result.freedBytes += current.size;
        result.deletedFiles.push(`previews/${entry.name}`);
    }
    return result;
}
