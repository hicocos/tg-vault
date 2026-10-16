import { query } from '../db/index.js';
import type { TelegramDownloadMessageRef } from './telegramUpload.js';
import { getTelegramBatchFileType } from '../utils/telegramBatchMediaFilter.js';

export const TELEGRAM_REF_WRITE_BATCH_SIZE = 100;
export type TelegramRefQuery = (sql: string, values: unknown[]) => Promise<unknown>;

export async function persistTelegramDownloadRefs(
    jobId: string,
    source: string,
    refs: TelegramDownloadMessageRef[],
    folderOverride?: string | null,
    execute: TelegramRefQuery = query,
): Promise<void> {
    for (let offset = 0; offset < refs.length; offset += TELEGRAM_REF_WRITE_BATCH_SIZE) {
        const rows = new Map<string, unknown[]>();
        for (const ref of refs.slice(offset, offset + TELEGRAM_REF_WRITE_BATCH_SIZE)) {
            const peer = ref.source == null ? source : String(ref.source);
            const key = `${peer}:${ref.id}`;
            const row = [jobId, source, peer, ref.origin || 'channel', ref.id, ref.groupedId || null,
                ref.channelPostId || null, ref.fileInfo?.fileName || null, ref.fileInfo?.mimeType || null,
                ref.fileInfo?.generatedName || false, ref.totalSize || 0, folderOverride || null,
                ref.sharedCaption || null, ref.groupIndex || null, ref.groupSize || null,
                ref.fileInfo ? getTelegramBatchFileType(ref.fileInfo) : null];
            const previous = rows.get(key);
            if (previous) {
                // Match sequential upserts: null metadata keeps the last known value;
                // identity/origin remain those of the first discovered row.
                for (const index of [5, 7, 8, 9, 10, 12, 13, 14, 15]) {
                    if (row[index] !== null) previous[index] = row[index];
                }
                previous[11] = row[11];
            } else rows.set(key, row);
        }
        const values: unknown[] = [];
        const tuples: string[] = [];
        for (const row of rows.values()) {
            const base = values.length;
            values.push(...row);
            tuples.push(`(${row.map((_, index) => `$${base + index + 1}`).join(',')},'pending',NULL,NULL,NULL,NULL)`);
        }
        await execute(`INSERT INTO telegram_download_items (
            job_id, source, source_peer, origin, message_id, grouped_id, channel_post_id,
            file_name, mime_type, generated_name, total_size, folder_override, shared_caption, group_index, group_size,
            file_category, status, error, last_error, locked_at, completed_at
        ) VALUES ${tuples.join(',')}
        ON CONFLICT (job_id, source_peer, message_id) DO UPDATE SET
            file_name = COALESCE(EXCLUDED.file_name, telegram_download_items.file_name),
            mime_type = COALESCE(EXCLUDED.mime_type, telegram_download_items.mime_type),
            file_category = COALESCE(EXCLUDED.file_category, telegram_download_items.file_category),
            generated_name = COALESCE(EXCLUDED.generated_name, telegram_download_items.generated_name),
            total_size = COALESCE(EXCLUDED.total_size, telegram_download_items.total_size),
            grouped_id = COALESCE(EXCLUDED.grouped_id, telegram_download_items.grouped_id),
            shared_caption = COALESCE(EXCLUDED.shared_caption, telegram_download_items.shared_caption),
            group_index = COALESCE(EXCLUDED.group_index, telegram_download_items.group_index),
            group_size = COALESCE(EXCLUDED.group_size, telegram_download_items.group_size),
            folder_override = EXCLUDED.folder_override, updated_at = NOW()`, values);
    }
}
