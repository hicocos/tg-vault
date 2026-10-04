import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/index.js';
import { generateMediaPreview, generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';

export type MediaDerivativeStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'not_required';

interface MediaDerivativeJob {
    fileId: string;
    sourcePath: string;
    storedName: string;
    mimeType: string;
    cleanupSource?: boolean;
}

interface MediaDerivativeRow {
    id: string;
    stored_name: string;
    mime_type: string;
    path: string;
    derivative_source_path: string | null;
    derivative_cleanup_source: boolean;
}

const concurrency = Math.max(1, Math.min(4, Number.parseInt(process.env.MEDIA_DERIVATIVE_CONCURRENCY || '2', 10) || 2));
const timeoutMs = Math.max(10_000, Number.parseInt(process.env.MEDIA_DERIVATIVE_TIMEOUT_MS || '120000', 10) || 120_000);
const queue: MediaDerivativeJob[] = [];
const queuedIds = new Set<string>();
let active = 0;

/**
 * A deadline records failure without releasing the concurrency slot early.
 * The underlying Sharp/FFmpeg operation is awaited to settlement before cleanup
 * and before another job starts, so timed-out work cannot escape the bound.
 */
async function settleWithDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
        const result = await Promise.race([
            promise.then(value => ({ value })),
            new Promise<{ timeout: true }>(resolve => {
                timer = setTimeout(() => { timedOut = true; resolve({ timeout: true }); }, timeoutMs);
                timer.unref?.();
            }),
        ]);
        if ('timeout' in result) {
            await promise.catch(() => undefined);
            throw new Error(`${label}超时`);
        }
        return result.value;
    } finally {
        if (timer) clearTimeout(timer);
        if (timedOut) console.warn(`[MediaDerivatives] ${label} 已超过 ${timeoutMs}ms，等待底层进程退出后释放队列槽位`);
    }
}

function requiredResult<T>(value: T | null | undefined, label: string): T {
    if (value == null) throw new Error(`${label}未生成有效输出`);
    return value;
}

async function processJob(job: MediaDerivativeJob): Promise<void> {
    const claimed = await query(
        `UPDATE files
         SET derivative_status = 'processing', derivative_error = NULL,
             derivative_started_at = NOW(), derivative_attempts = derivative_attempts + 1, updated_at = NOW()
         WHERE id = $1 AND derivative_status = 'queued'
         RETURNING id`,
        [job.fileId],
    );
    if (!claimed.rowCount) return;

    try {
        const thumbnail = requiredResult(
            await settleWithDeadline(generateThumbnail(job.sourcePath, job.storedName, job.mimeType), '缩略图生成'),
            '缩略图',
        );
        const dimensions = await settleWithDeadline(getImageDimensions(job.sourcePath, job.mimeType), '媒体尺寸读取');
        if (!(dimensions.width > 0 && dimensions.height > 0)) throw new Error('媒体尺寸无效');
        const preview = await settleWithDeadline(
            generateMediaPreview(job.sourcePath, job.storedName, job.mimeType, job.fileId), '预览生成',
        );

        await query(
            `UPDATE files
             SET thumbnail_path = $1, preview_path = $2, width = $3, height = $4,
                 derivative_status = 'ready', derivative_error = NULL,
                 derivative_source_path = NULL, derivative_cleanup_source = FALSE,
                 derivative_started_at = NULL, updated_at = NOW()
             WHERE id = $5`,
            [path.basename(thumbnail), preview ? path.basename(preview) : null, dimensions.width, dimensions.height, job.fileId],
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await query(
            `UPDATE files
             SET derivative_status = 'failed', derivative_error = $1,
                 derivative_started_at = NULL, updated_at = NOW()
             WHERE id = $2`,
            [message.slice(0, 1000), job.fileId],
        ).catch(() => undefined);
        console.error(`[MediaDerivatives] ${job.fileId} 处理失败:`, error);
    } finally {
        if (job.cleanupSource) await fs.rm(job.sourcePath, { force: true }).catch(() => undefined);
    }
}

function drain(): void {
    while (active < concurrency && queue.length > 0) {
        const job = queue.shift()!;
        active += 1;
        void processJob(job).finally(() => {
            queuedIds.delete(job.fileId);
            active -= 1;
            drain();
        });
    }
}

export function enqueueMediaDerivatives(job: MediaDerivativeJob): void {
    if (queuedIds.has(job.fileId)) return;
    queuedIds.add(job.fileId);
    queue.push(job);
    drain();
}

function jobFromRow(row: MediaDerivativeRow): MediaDerivativeJob | null {
    const sourcePath = row.derivative_source_path || row.path;
    if (!sourcePath) return null;
    return {
        fileId: String(row.id),
        sourcePath: String(sourcePath),
        storedName: String(row.stored_name),
        mimeType: String(row.mime_type),
        cleanupSource: row.derivative_cleanup_source === true,
    };
}

/** Recover persisted queued jobs and stale processing jobs after a restart. */
export async function recoverMediaDerivativeJobs(): Promise<number> {
    await query(
        `UPDATE files
         SET derivative_status = 'queued', derivative_error = '上次处理被中断，已重新排队',
             derivative_started_at = NULL, updated_at = NOW()
         WHERE derivative_status = 'processing'`,
        [],
    );
    const result = await query(
        `SELECT id, stored_name, mime_type, path, derivative_source_path, derivative_cleanup_source
         FROM files
         WHERE derivative_status = 'queued'
         ORDER BY created_at ASC, id ASC
         LIMIT 1000`,
    );
    let recovered = 0;
    for (const row of result.rows as MediaDerivativeRow[]) {
        const job = jobFromRow(row);
        if (!job) continue;
        enqueueMediaDerivatives(job);
        recovered += 1;
    }
    if (recovered > 0) console.log(`[MediaDerivatives] 已恢复 ${recovered} 个持久化任务`);
    return recovered;
}

export function mediaDerivativeQueueSnapshot(): { active: number; queued: number; concurrency: number } {
    return { active, queued: queue.length, concurrency };
}
