import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/index.js';
import { generateMediaPreview, generateThumbnail, getImageDimensions } from '../utils/thumbnail.js';
import { mediaConcurrency } from '../utils/mediaControl.js';

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

const concurrency = mediaConcurrency;
const timeoutMs = Math.max(10_000, Number.parseInt(process.env.MEDIA_DERIVATIVE_TIMEOUT_MS || '120000', 10) || 120_000);
const queue: MediaDerivativeJob[] = [];
const queuedIds = new Set<string>();
let active = 0;

/** Abort the underlying work at its deadline; do not release until it settles. */
async function settleWithDeadline<T>(work: (signal: AbortSignal) => Promise<T>, label: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label}超时`)), timeoutMs);
    timer.unref?.();
    try {
        const value = await work(controller.signal);
        controller.signal.throwIfAborted();
        return value;
    } finally {
        clearTimeout(timer);
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
            await settleWithDeadline(signal => generateThumbnail(job.sourcePath, job.storedName, job.mimeType, signal), '缩略图生成'),
            '缩略图',
        );
        const dimensions = await settleWithDeadline(signal => getImageDimensions(job.sourcePath, job.mimeType, signal), '媒体尺寸读取');
        if (!(dimensions.width > 0 && dimensions.height > 0)) throw new Error('媒体尺寸无效');
        const preview = await settleWithDeadline(
            signal => generateMediaPreview(job.sourcePath, job.storedName, job.mimeType, job.fileId, signal), '预览生成',
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
