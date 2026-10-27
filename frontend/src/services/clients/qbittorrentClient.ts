import { apiJson } from '../httpClient';
import { getApiHeaders } from './clientHeaders';

export const QB_CONFIG_CHANGED = 'qbittorrent-config-changed';
export const QB_DEFAULT_PATH = '/qBittorrent/download';

export interface QbSettings {
    apiUrl: string;
    username: string;
    downloadDir: string;
    targetFolder: string;
    targetAccountId: string;
    preserveLocalFiles: boolean;
}
export type QbConfig = { enabled: false } | (QbSettings & { enabled: true; hasPassword: boolean });
export type QbConfigInput = Partial<QbSettings> & { enabled?: boolean; password?: string };
export interface QbTestResult {
    api: { ok: boolean; version?: string; error?: string };
    directory: { ok: boolean; error?: string };
}
export interface QbTask {
    id: string;
    title: string;
    status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    stage: 'submitting' | 'metadata' | 'downloading' | 'uploading' | 'cleaning' | 'cancelling' | 'completed' | 'failed' | 'paused' | 'cancelled';
    progress: number;
    downloadProgress: number;
    downloadSpeed: number;
    downloadedBytes: number;
    uploadSpeed: number;
    totalBytes: number;
    transferredBytes: number;
    totalItems: number;
    completedItems: number;
    error: string | null;
    retryable: boolean;
    cancelRequested: boolean;
    targetAccountId: string | null;
    targetProvider: string;
    targetFolder: string;
    preserveLocalFiles: boolean;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
}
export interface QbFile { index: number; name: string; size: number; progress: number; priority: number; }
export const qbDefaults: QbSettings = {
    apiUrl: '', username: '', downloadDir: QB_DEFAULT_PATH, targetFolder: QB_DEFAULT_PATH,
    targetAccountId: 'local', preserveLocalFiles: false,
};
const root = '/api/qbittorrent';
const json = (method: string, body: unknown) => ({ method, headers: getApiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
export const qbittorrentClient = {
    getConfig: () => apiJson<QbConfig>(`${root}/config`, { headers: getApiHeaders() }),
    async saveConfig(input: QbConfigInput) {
        const config = await apiJson<QbConfig>(`${root}/config`, json('PUT', input));
        window.dispatchEvent(new CustomEvent<QbConfig>(QB_CONFIG_CHANGED, { detail: config }));
        return config;
    },
    test: (input: QbConfigInput) => apiJson<QbTestResult>(`${root}/test`, json('POST', input)),
    getTasks: () => apiJson<{ tasks: QbTask[] }>(`${root}/tasks`, { headers: getApiHeaders() }),
    createTask: (body: FormData) => apiJson<QbTask>(`${root}/tasks`, { method: 'POST', headers: getApiHeaders(), body }),
    controlTask: (id: string, action: 'pause' | 'resume' | 'retry' | 'cancel') => apiJson<{ success: true }>(`${root}/tasks/${encodeURIComponent(id)}/${action}`, json('POST', {})),
    getFiles: (id: string) => apiJson<{ files: QbFile[] }>(`${root}/tasks/${encodeURIComponent(id)}/files`, { headers: getApiHeaders() }),
    selectFiles: (id: string, indexes: number[]) => apiJson<unknown>(`${root}/tasks/${encodeURIComponent(id)}/files`, json('POST', { indexes })),
};
