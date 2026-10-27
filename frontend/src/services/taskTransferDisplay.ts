import type { UnifiedTask } from './apiTypes';
import { formatBytes } from './formatBytes';

/** Render server samples, never estimate transfer speed from browser polling. */
export function taskTransferDisplay(task: UnifiedTask) {
    const downloading = ['running', 'pausing'].includes(task.status)
        && (typeof task.detail.downloading === 'number' ? task.detail.downloading > 0
            : task.sourceType === 'telegram_channel' ? Number(task.detail.active) > 0 : task.stage === 'downloading');
    const uploading = task.sourceType === 'qbittorrent' && task.status === 'running' && task.stage === 'uploading';
    const sample = task.sourceType === 'qbittorrent' ? uploading ? task.detail.uploadSpeed : task.detail.downloadSpeed : task.detail.speedBytesPerSecond;
    const speed = (downloading || uploading) && typeof sample === 'number' && Number.isFinite(sample) && sample >= 0
        ? `${formatBytes(sample)}/s`
        : task.status === 'running' && typeof task.detail.speed === 'string' ? task.detail.speed : null;
    const transferred = Number.isFinite(task.bytes.transferred) ? Math.max(0, task.bytes.transferred) : 0;
    const total = Number.isFinite(task.bytes.total) ? Math.max(0, task.bytes.total) : 0;
    return {
        speed,
        showBytes: task.sourceType === 'telegram_channel'
            ? total > 0 || transferred > 0
            : task.detail.bytesKnown !== false && (total > 0 || transferred > 0 || downloading),
        transferred: `${formatBytes(transferred)}${task.detail.savedBytesKnown === false ? '+' : ''}`,
        total: total > 0 ? `${formatBytes(total)}${task.detail.bytesKnown === false ? '+' : ''}` : '—',
    };
}
