import type { DownloadTaskGroupSnapshot } from './downloadTaskQueue.js';

const TERMINAL_CHANNEL_STATES: Record<string, true | undefined> = {
    completed: true,
    completed_with_errors: true,
    failed: true,
    cancelled: true,
};

/** A claimed item may still be waiting for a worker; only live workers are active. */
export function channelRuntimeView<T extends Record<string, unknown>>(row: T, live?: DownloadTaskGroupSnapshot | null) {
    const claimed = Math.max(0, Number(row.downloading_count ?? row.active_items ?? 0));
    const active = Math.min(claimed, Math.max(0, live?.active || 0));
    const pending = Math.max(0, Number(row.pending_count || 0)) + claimed - active;
    const paused = !TERMINAL_CHANNEL_STATES[String(row.status)] && (Boolean(row.paused_at) || row.status === 'paused');
    return {
        ...row,
        downloading_count: active,
        pending_count: pending,
        runtime_active: active,
        runtime_pending: pending,
        runtime_status: paused ? (active > 0 ? 'pausing' : 'paused') : undefined,
        speed_bytes_per_second: live?.speedBytesPerSecond || 0,
        runtime_stage: live?.stage,
        runtime_downloading: live?.downloading || 0,
        runtime_uploading: live?.uploading || 0,
        runtime_waiting_upload: live?.waitingUpload || 0,
        runtime_retrying: live?.retrying || 0,
        current_file_name: live?.currentFileName || null,
    };
}
