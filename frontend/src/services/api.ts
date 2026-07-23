import { authService } from './auth';
import { sha256Hex } from './chunkHash';

import { API_BASE } from './config';
import { classifyBatchDeleteResponse, type BatchDeleteResult } from './batchDeleteContract';
import { chunkBounds, parseChunkUploadInit } from './chunkUploadProtocol';

export interface FileData {
    id: string;
    name: string;
    stored_name: string;
    type: 'image' | 'video' | 'audio' | 'document' | 'other';
    mime_type: string;
    size: string;
    date: string;
    thumbnailUrl?: string;
    previewUrl: string;
    width?: number;
    height?: number;
    source?: string;
    folder?: string;
    created_at: string;
    is_favorite?: boolean;
}

export interface StorageCapabilities {
    share: boolean;
    sharePassword: boolean;
    shareExpiration: boolean;
    quota: boolean;
}

export interface StorageStats {
    provider: string;
    accountId: string | null;
    capabilities: StorageCapabilities;
    temporary: { totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number };
    indexed: { usedBytes: number; fileCount: number };
    remoteQuota: { totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number } | null;
    health: { probeStatus: 'available' | 'failed' | null; lastProbedAt: string | null; cooldownUntil: string | null; cooldownReason: string | null };
    server: {
        total: string;
        totalBytes: number;
        used: string;
        usedBytes: number;
        free: string;
        freeBytes: number;
        usedPercent: number;
    };
    tgvault: {
        used: string;
        usedBytes: number;
        fileCount: number;
        usedPercent?: number;
    };
}

export interface UploadProgress {
    loaded: number;
    total: number;
    percent: number;
}

export interface UploadCapabilities {
    acceptsAnyFile: boolean;
    simpleUploadThresholdBytes: number;
    simpleUploadMaxBytes: number;
    chunkBytes: number;
    maxChunkUploadBytes: number;
    globalSessionBudgetBytes: number;
    maxChunks: number;
    sessionTtlMs: number;
}

export interface UploadTargetSnapshot {
    provider: string;
    accountId: string | null;
    accountName?: string | null;
    folder?: string | null;
}

export interface ChunkUploadSession {
    uploadId: string;
    filename: string;
    mimeType: string;
    folder: string | null;
    status: 'open' | 'completing' | 'failed';
    totalChunks: number;
    uploadedChunks: number[];
    uploadedChunkHashes: Record<number, string>;
    receivedBytes: number;
    totalSize: number;
    progress: number;
    maxChunkBytes: number;
    targetProvider: string;
    targetAccountId: string | null;
    targetAccountName?: string | null;
    expiresAt: string;
    error?: string | null;
}

export type ChunkUploadCancelStatus = 'cancelled' | 'busy' | 'terminal' | 'not_found';

export type UnifiedTaskSource = 'telegram_bot' | 'telegram_channel' | 'ytdlp' | 'web_upload' | 'subscription';

export interface UnifiedTask {
    id: string;
    sourceType: UnifiedTaskSource;
    kind: string;
    title: string;
    status: string;
    stage: string;
    progress: number;
    ownerUserId: number | null;
    chatId: string | null;
    source: string | null;
    target: {
        provider: string | null;
        accountId: string | null;
        accountName: string | null;
        folder: string | null;
    };
    counts: { total: number; completed: number; failed: number };
    bytes: { total: number; transferred: number };
    detail: Record<string, unknown>;
    error: string | null;
    retryable: boolean;
    cancellable: boolean;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
}

export interface UnifiedTaskList {
    tasks: UnifiedTask[];
    total: number;
    generatedAt: string;
}

export interface StorageAccount {
    id: string;
    name: string;
    type: string;
    is_active: boolean;
    capabilities: StorageCapabilities;
    last_probe_status: 'available' | 'failed' | null;
    last_probe_error: string | null;
    last_probed_at: string | null;
}

export interface StorageConfig {
    provider: string;
    activeAccountId: string | null;
    activeAccountName?: string;
    capabilities: StorageCapabilities;
    accounts: StorageAccount[];
    redirectUri: string;
    googleDriveRedirectUri: string;
    telegramUserDownloadEnabled?: boolean;
    telegramUserSessionReady?: boolean;
    telegramUserClientStatus?: { status: string; userId: string | null; username: string | null; checkedAt: string | null; lastError: string | null; action: string | null };
    telegramAllowedUserIds?: number[];
    telegramAllowedUserIdsFromEnv?: boolean;
}

export interface FolderMovePreview {
    sourcePath: string;
    destinationParent: string | null;
    finalPath: string;
    fileCount: number;
    folderCount: number;
    totalSizeBytes: number;
    conflict: boolean;
    conflictReason?: string;
    noChange: boolean;
}

export interface FilesPage {
    files: FileData[];
    nextCursor: string | null;
    hasMore: boolean;
}

export interface FileQueryOptions {
    cursor?: string | null;
    limit?: number;
    q?: string;
    type?: 'image' | 'video' | 'audio' | 'document' | 'other' | 'media';
    folder?: string | null;
    favorite?: boolean;
    sort?: 'name' | 'date';
    direction?: 'asc' | 'desc';
    signal?: AbortSignal;
}

export interface FolderAggregation {
    name: string;
    fileCount: number;
    totalSizeBytes: number;
    latestDate: string;
    isFavorite: boolean;
    coverFile: FileData | null;
}

export interface BatchDeletePreview {
    confirmationToken: string;
    fileCount: number;
    dataFileCount: number;
    placeholderCount: number;
    folderCount: number;
    totalSizeBytes: number;
    expiresAt: string;
}

export type { BatchDeleteResult };

export interface AdvancedTaskSettings {
    telegramDownloadWorkers: number;
    telegramFileConcurrency: number;
    duplicateMode: 'copy' | 'skip';
    autoCleanupOrphans: boolean;
    highRisk: { telegramDownloadWorkers: boolean; telegramFileConcurrency: boolean };
}

export interface StorageDeleteImpact {
    accountId: string;
    accountName: string;
    provider: string;
    fileCount: number;
    totalSizeBytes: number;
    folderCount: number;
    activeLeaseCount: number;
    activeTaskCount: number;
    activeUploadCount: number;
    remoteObjectsDeleted: false;
}

export interface OAuthStartResult {
    authUrl: string;
    flowNonce: string;
    frontendOrigin: string;
    expiresAt: string;
}

// 获取带认证的请求头
function getHeaders(additionalHeaders: Record<string, string> = {}): HeadersInit {
    return {
        ...authService.getAuthHeaders(),
        ...additionalHeaders,
    };
}

class FileAPI {
    private uploadCapabilitiesPromise: Promise<UploadCapabilities> | null = null;

    async getUploadCapabilities(): Promise<UploadCapabilities> {
        if (!this.uploadCapabilitiesPromise) {
            this.uploadCapabilitiesPromise = fetch(`${API_BASE}/api/upload/capabilities`, {
                credentials: 'include',
                headers: getHeaders(),
            }).then(async response => {
                if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
                if (!response.ok) throw new Error('获取上传能力失败');
                return response.json();
            }).catch(error => {
                this.uploadCapabilitiesPromise = null;
                throw error;
            });
        }
        return this.uploadCapabilitiesPromise;
    }
    async getFilesPage(options: FileQueryOptions = {}): Promise<FilesPage> {
        const params = new URLSearchParams({ page: 'cursor', limit: String(options.limit ?? 200) });
        if (options.cursor) params.set('cursor', options.cursor);
        if (options.q?.trim()) params.set('q', options.q.trim());
        if (options.type) params.set('type', options.type);
        if (options.folder !== undefined) params.set('folder', options.folder || '');
        if (options.favorite !== undefined) params.set('favorite', String(options.favorite));
        if (options.sort) params.set('sort', options.sort);
        if (options.direction) params.set('direction', options.direction);
        const response = await fetch(`${API_BASE}/api/files?${params.toString()}`, {
            credentials: 'include',
            headers: getHeaders(),
            signal: options.signal,
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('获取文件列表失败');
        return response.json();
    }

    async getFolderAggregations(options: Omit<FileQueryOptions, 'cursor' | 'folder'> = {}): Promise<FolderAggregation[]> {
        const params = new URLSearchParams();
        if (options.q?.trim()) params.set('q', options.q.trim());
        if (options.type) params.set('type', options.type);
        if (options.favorite !== undefined) params.set('favorite', String(options.favorite));
        if (options.sort) params.set('sort', options.sort);
        if (options.direction) params.set('direction', options.direction);
        const response = await fetch(`${API_BASE}/api/files/folders/aggregation?${params.toString()}`, {
            credentials: 'include',
            headers: getHeaders(),
            signal: options.signal,
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('获取文件夹统计失败');
        const payload = await response.json();
        return payload.folders;
    }

    // 获取文件列表
    async getFiles(): Promise<FileData[]> {
        const page = await this.getFilesPage();
        return page.files;
    }

    // 获取单个文件
    async getFile(id: string): Promise<FileData> {
        const response = await fetch(`${API_BASE}/api/files/${id}`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('获取文件信息失败');
        return response.json();
    }

    // 智能上传：阈值和上限来自服务端能力契约，避免客户端文案/行为漂移。
    async uploadFile(file: File, folder?: string, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal, target?: UploadTargetSnapshot, onSession?: (session: ChunkUploadSession) => void): Promise<{ success: boolean; file: FileData }> {
        const capabilities = await this.getUploadCapabilities();
        if (file.size > capabilities.maxChunkUploadBytes) {
            throw new Error(`文件超过服务端允许的最大上传大小 ${Math.round(capabilities.maxChunkUploadBytes / 1024 / 1024 / 1024)} GiB`);
        }
        if (file.size > capabilities.simpleUploadThresholdBytes) {
            return this.chunkedUpload(file, folder, onProgress, signal, undefined, target, onSession);
        }
        return this.simpleUpload(file, folder, onProgress, signal, target);
    }

    async getIncompleteChunkUploads(): Promise<ChunkUploadSession[]> {
        const response = await fetch(`${API_BASE}/api/chunked/sessions`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('获取未完成上传失败');
        const payload = await response.json();
        return payload.sessions || [];
    }

    async resumeChunkedUpload(file: File, session: ChunkUploadSession, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<{ success: boolean; file: FileData }> {
        const liveSession = (await this.getIncompleteChunkUploads()).find(item => item.uploadId === session.uploadId);
        if (!liveSession) throw new Error('该上传会话已完成、取消或过期，请刷新任务列表');
        if (file.name !== liveSession.filename || file.size !== liveSession.totalSize) {
            throw new Error('所选文件的名称或大小与原上传任务不一致');
        }
        const mimeType = file.type || 'application/octet-stream';
        if (liveSession.mimeType !== mimeType && liveSession.mimeType !== 'application/octet-stream') {
            throw new Error('所选文件的类型与原上传任务不一致');
        }
        if (liveSession.status === 'completing') throw new Error('服务器正在完成该上传，请稍后刷新');
        const { verifyResumeFileIdentity } = await import('./chunkResumeIdentity.js');
        await verifyResumeFileIdentity(file, liveSession);
        return this.chunkedUpload(file, liveSession.folder || undefined, onProgress, signal, liveSession, {
            provider: liveSession.targetProvider,
            accountId: liveSession.targetAccountId,
            accountName: liveSession.targetAccountName,
            folder: liveSession.folder,
        });
    }

    async cancelChunkUpload(uploadId: string): Promise<ChunkUploadCancelStatus> {
        const response = await fetch(`${API_BASE}/api/chunked/${uploadId}`, {
            credentials: 'include',
            method: 'DELETE',
            headers: getHeaders(),
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        const payload = await response.json().catch(() => ({}));
        if (response.status === 409 && payload.status === 'busy') return 'busy';
        if (response.status === 404) return 'not_found';
        if (!response.ok) {
            throw new Error(payload.error || '取消上传失败');
        }
        return ['cancelled', 'terminal'].includes(payload.status) ? payload.status : 'terminal';
    }

    async getTasks(filters: { source?: string; status?: string; limit?: number } = {}): Promise<UnifiedTaskList> {
        const params = new URLSearchParams({ limit: String(filters.limit ?? 200) });
        if (filters.source) params.set('source', filters.source);
        if (filters.status) params.set('status', filters.status);
        const response = await fetch(`${API_BASE}/api/tasks?${params.toString()}`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || '获取任务列表失败');
        }
        return response.json();
    }

    async controlTask(sourceType: UnifiedTaskSource, id: string, action: 'cancel' | 'retry'): Promise<void> {
        let confirmationToken: string | undefined;
        if (action === 'cancel') {
            const confirmation = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(sourceType)}/${encodeURIComponent(id)}/cancel-confirmation`, {
                credentials: 'include',
                method: 'POST',
                headers: getHeaders(),
            });
            if (confirmation.status === 401 || confirmation.status === 428) throw new Error('UNAUTHORIZED');
            const payload = await confirmation.json().catch(() => ({}));
            if (!confirmation.ok || !payload.confirmationToken) {
                throw new Error(payload.error || '无法创建任务取消确认');
            }
            confirmationToken = String(payload.confirmationToken);
        }
        const response = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(sourceType)}/${encodeURIComponent(id)}/${action}`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({
                'Content-Type': 'application/json',
                ...(confirmationToken ? { 'X-Confirmation-Token': confirmationToken } : {}),
            }),
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || payload.error || '任务操作失败');
        }
    }

    // 简单上传（适用于小文件）
    private simpleUpload(file: File, folder?: string, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal, target?: UploadTargetSnapshot): Promise<{ success: boolean; file: FileData }> {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const formData = new FormData();
            formData.append('file', file);
            if (folder) {
                formData.append('folder', folder);
            }
            if (target) {
                formData.append('targetProvider', target.provider);
                if (target.accountId) formData.append('targetAccountId', target.accountId);
            }

            // 进度监听
            xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable && onProgress) {
                    onProgress({
                        loaded: event.loaded,
                        total: event.total,
                        percent: Math.round((event.loaded / event.total) * 100),
                    });
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status === 401) {
                    reject(new Error('UNAUTHORIZED'));
                } else if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch {
                        reject(new Error('解析响应失败'));
                    }
                } else {
                    reject(new Error(`上传失败: ${xhr.status}`));
                }
            });

            xhr.addEventListener('error', () => {
                reject(new Error('网络错误'));
            });

            xhr.addEventListener('abort', () => {
                reject(new DOMException('Upload cancelled', 'AbortError'));
            });

            xhr.open('POST', `${API_BASE}/api/upload`);
            xhr.withCredentials = true;

            const abortUpload = () => xhr.abort();
            if (signal?.aborted) {
                abortUpload();
                return;
            }
            signal?.addEventListener('abort', abortUpload, { once: true });
            xhr.addEventListener('loadend', () => signal?.removeEventListener('abort', abortUpload), { once: true });
            xhr.send(formData);
        });
    }

    // 分块上传（适用于大文件）
    private async chunkedUpload(
        file: File,
        folder?: string,
        onProgress?: (progress: UploadProgress) => void,
        signal?: AbortSignal,
        resumeSession?: ChunkUploadSession,
        target?: UploadTargetSnapshot,
        onSession?: (session: ChunkUploadSession) => void,
    ): Promise<{ success: boolean; file: FileData }> {
        let uploadId: string;
        let maxChunkBytes: number;
        let totalChunks: number;
        let uploadedBytes = resumeSession?.receivedBytes || 0;
        let uploadedChunks = new Set(resumeSession?.uploadedChunks || []);

        if (resumeSession) {
            uploadId = resumeSession.uploadId;
            maxChunkBytes = resumeSession.maxChunkBytes;
            totalChunks = resumeSession.totalChunks;
            if (resumeSession.status === 'failed') {
                const retryResponse = await fetch(`${API_BASE}/api/chunked/${uploadId}/retry`, {
                    credentials: 'include', method: 'POST', headers: getHeaders(), signal,
                });
                if (!retryResponse.ok) throw new Error('服务器无法重新打开该上传会话');
            }
            onProgress?.({ loaded: uploadedBytes, total: file.size, percent: Math.round((uploadedBytes / file.size) * 100) });
        } else {
            const initResponse = await fetch(`${API_BASE}/api/chunked/init`, {
                credentials: 'include',
                method: 'POST',
                headers: getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    filename: file.name,
                    mimeType: file.type || 'application/octet-stream',
                    totalSize: file.size,
                    folder,
                    targetProvider: target?.provider,
                    targetAccountId: target?.accountId ?? null,
                }),
                signal,
            });
            if (initResponse.status === 401 || initResponse.status === 428) throw new Error('UNAUTHORIZED');
            if (!initResponse.ok) {
                const payload = await initResponse.json().catch(() => ({}));
                throw new Error(payload.error || '初始化分块上传失败');
            }
            const initPayload = await initResponse.json();
            ({ uploadId, maxChunkBytes, totalChunks } = parseChunkUploadInit(initPayload, file.size));
            uploadedChunks = new Set();
            const initTarget = initPayload.target || target || {};
            onSession?.({
                uploadId,
                filename: file.name,
                mimeType: file.type || 'application/octet-stream',
                folder: initTarget.folder ?? folder ?? null,
                status: 'open',
                totalChunks,
                uploadedChunks: [],
                uploadedChunkHashes: {},
                receivedBytes: 0,
                totalSize: file.size,
                progress: 0,
                maxChunkBytes,
                targetProvider: String(initTarget.provider || target?.provider || ''),
                targetAccountId: initTarget.accountId ?? target?.accountId ?? null,
                targetAccountName: target?.accountName || null,
                expiresAt: String(initPayload.expiresAt || ''),
                error: null,
            });
        }

        try {
            for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                if (uploadedChunks.has(chunkIndex)) continue;
                const { start, end } = chunkBounds(file.size, chunkIndex, maxChunkBytes);
                const chunk = file.slice(start, end);
                const chunkHash = await sha256Hex(chunk);

                const chunkResponse = await fetch(`${API_BASE}/api/chunked/chunk`, {
                    credentials: 'include',
                    method: 'POST',
                    headers: getHeaders({
                        'Content-Type': 'application/octet-stream',
                        'X-Upload-Id': uploadId,
                        'X-Chunk-Index': chunkIndex.toString(),
                        'X-Chunk-Size': chunk.size.toString(),
                        'X-Chunk-Sha256': chunkHash,
                    }),
                    body: chunk,
                    signal,
                });

                if (chunkResponse.status === 401 || chunkResponse.status === 428) throw new Error('UNAUTHORIZED');
                if (!chunkResponse.ok) {
                    const payload = await chunkResponse.json().catch(() => ({}));
                    throw new Error(payload.error || `上传分块 ${chunkIndex + 1}/${totalChunks} 失败`);
                }
                const chunkResult = await chunkResponse.json().catch(() => ({}));
                uploadedBytes = Number(chunkResult.receivedBytes || (uploadedBytes + chunk.size));

                if (onProgress) {
                    onProgress({
                        loaded: uploadedBytes,
                        total: file.size,
                        percent: Math.round((uploadedBytes / file.size) * 100),
                    });
                }
            }

            const completeResponse = await fetch(`${API_BASE}/api/chunked/complete`, {
                credentials: 'include',
                method: 'POST',
                headers: getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ uploadId }),
                signal,
            });

            if (completeResponse.status === 401 || completeResponse.status === 428) throw new Error('UNAUTHORIZED');
            if (!completeResponse.ok) {
                const payload = await completeResponse.json().catch(() => ({}));
                throw new Error(payload.error || '完成分块上传失败');
            }

            return completeResponse.json();
        } catch (error) {
            if (signal?.aborted) {
                let cancellation: ChunkUploadCancelStatus;
                try {
                    cancellation = await this.cancelChunkUpload(uploadId);
                } catch {
                    throw new Error('浏览器传输已停止，但无法确认服务器上传会话是否已取消，请刷新上传任务');
                }
                if (cancellation === 'busy') {
                    throw new Error('浏览器传输已停止，服务器正在完成上传，请稍后刷新确认结果');
                }
                throw new DOMException('Upload cancelled', 'AbortError');
            }
            throw error;
        }
    }

    // 批量上传
    async uploadFiles(files: File[], folder?: string, onProgress?: (fileIndex: number, progress: UploadProgress) => void): Promise<{ success: boolean; files: FileData[] }> {
        const results: FileData[] = [];

        for (let i = 0; i < files.length; i++) {
            const result = await this.uploadFile(files[i], folder, (progress) => {
                onProgress?.(i, progress);
            });
            if (result.file) {
                results.push(result.file);
            }
        }

        return { success: true, files: results };
    }

    // 删除文件
    async deleteFile(id: string): Promise<{ status: 'complete'; deletedIds: string[]; message: string }> {
        const confirmationResponse = await fetch(`${API_BASE}/api/files/${id}/delete-confirmation`, {
            credentials: 'include', method: 'POST', headers: getHeaders(),
        });
        if (!confirmationResponse.ok) throw new Error((await confirmationResponse.json().catch(() => ({}))).error || '无法创建删除确认');
        const { confirmationToken } = await confirmationResponse.json();
        const response = await fetch(`${API_BASE}/api/files/${id}`, {
            credentials: 'include',
            method: 'DELETE',
            headers: getHeaders({ 'X-Confirmation-Token': confirmationToken }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || payload.details || '删除文件失败');
        return payload;
    }

    async previewBatchDelete(fileIds: string[], folderNames: string[]): Promise<BatchDeletePreview> {
        const response = await fetch(`${API_BASE}/api/files/batch-delete/preview`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ fileIds, folderNames }),
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '获取删除影响范围失败');
        }
        return response.json();
    }

    // 批量删除
    async batchDelete(confirmationToken: string): Promise<BatchDeleteResult> {
        const response = await fetch(`${API_BASE}/api/files/batch-delete`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ confirmationToken }),
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        return classifyBatchDeleteResponse(response);
    }

    // 创建分享链接
    async createShareLink(fileId: string, password?: string, expiration?: string): Promise<{ link: string }> {
        const response = await fetch(`${API_BASE}/api/files/${fileId}/share`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ password, expiration }),
        });

        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '创建分享链接失败');
        }
        return response.json();
    }

    // 获取下载 URL (直接链接或签名链接)
    async getDownloadLink(id: string): Promise<string> {
        const response = await fetch(`${API_BASE}/api/files/${id}/download-url`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('获取下载链接失败');

        const data = await response.json();
        if (data.isRelative) {
            return `${API_BASE}${data.url}`;
        }
        return data.url;
    }

    // 安全下载文件（使用直接链接，不经过 Blob 缓冲）
    async downloadFile(id: string, fileName: string): Promise<void> {
        try {
            const url = await this.getDownloadLink(id);

            const link = document.createElement('a');
            link.href = url;
            link.download = fileName; // 尝试设置文件名 (对于跨域链接可能无效，但后端已有 Content-Disposition)
            // 如果是同源链接 (local signed url)，download 属性有效
            // 如果是跨域 (OneDrive)，浏览器会根据 URL 或 Headers 决定

            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (error) {
            console.error('下载出错:', error);
            throw error;
        }
    }


    // 获取存储统计
    async getAdvancedTaskSettings(): Promise<AdvancedTaskSettings> {
        const response = await fetch(`${API_BASE}/api/storage/config/advanced-tasks`, {
            credentials: 'include', headers: getHeaders(),
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '获取高级任务设置失败');
        return response.json();
    }

    async updateAdvancedTaskSetting(patch: Partial<Pick<AdvancedTaskSettings, 'telegramDownloadWorkers' | 'telegramFileConcurrency' | 'duplicateMode' | 'autoCleanupOrphans'>>, confirmed = false): Promise<void> {
        const response = await fetch(`${API_BASE}/api/storage/config/advanced-tasks`, {
            credentials: 'include', method: 'PATCH',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ ...patch, confirmed }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || '更新高级任务设置失败') as Error & { code?: string };
            error.code = payload.code;
            throw error;
        }
    }

    async getStorageStats(): Promise<StorageStats> {
        const response = await fetch(`${API_BASE}/api/storage/stats`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('获取存储统计失败');
        return response.json();
    }

    // 获取存储配置
    async getStorageConfig(): Promise<StorageConfig> {
        const response = await fetch(`${API_BASE}/api/storage/config`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('获取存储配置失败');
        return response.json();
    }

    async setTelegramUserDownloadEnabled(enabled: boolean): Promise<{ success: boolean; enabled: boolean }> {
        const response = await fetch(`${API_BASE}/api/storage/config/telegram-user-download`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ enabled }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '更新 Telegram 用户下载设置失败');
        }
        return response.json();
    }

    async setTelegramAllowedUserIds(userIds: string): Promise<{ success: boolean; userIds: number[] }> {
        const response = await fetch(`${API_BASE}/api/storage/config/telegram-allowed-users`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ userIds }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '更新 Telegram 允许用户列表失败');
        }
        return response.json();
    }

    async cleanupDownloadItems(retentionDays: number = 7): Promise<{ success: boolean; deletedCount: number; retentionDays: number }> {
        const response = await fetch(`${API_BASE}/api/storage/maintenance/download-items/cleanup`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ retentionDays }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '清理下载任务明细失败');
        }
        return response.json();
    }

    // 更新 OneDrive 配置
    async updateOneDriveConfig(clientId: string, clientSecret: string, refreshToken: string, tenantId: string = 'common', name?: string): Promise<{ success: boolean; message: string }> {
        const response = await fetch(`${API_BASE}/api/storage/config/onedrive`, {
            credentials: 'include',
            method: 'PUT',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ clientId, clientSecret, refreshToken, tenantId, name }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('更新配置失败');
        return response.json();
    }

    // 添加 Aliyun OSS 账户
    async addAliyunOSSAccount(name: string, region: string, accessKeyId: string, accessKeySecret: string, bucket: string): Promise<{ success: boolean; message: string; accountId: string }> {
        const response = await fetch(`${API_BASE}/api/storage/config/aliyun-oss`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name, region, accessKeyId, accessKeySecret, bucket }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '添加 Aliyun OSS 账户失败');
        }
        return response.json();
    }

    // 添加 S3 账户
    async addS3Account(name: string, endpoint: string, region: string, accessKeyId: string, accessKeySecret: string, bucket: string, forcePathStyle: boolean = false): Promise<{ success: boolean; message: string; accountId: string }> {
        const response = await fetch(`${API_BASE}/api/storage/config/s3`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name, endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '添加 S3 账户失败');
        }
        return response.json();
    }

    // 添加 WebDAV 账户
    async addWebDAVAccount(name: string, url: string, username?: string, password?: string): Promise<{ success: boolean; message: string; accountId: string }> {
        const response = await fetch(`${API_BASE}/api/storage/config/webdav`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name, url, username, password }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '添加 WebDAV 账户失败');
        }
        return response.json();
    }

    // 切换存储提供商或账户
    async switchStorageProvider(provider: 'local' | 'onedrive' | 'aliyun_oss' | 's3' | 'webdav' | 'google_drive', accountId?: string): Promise<{ success: boolean; message: string; scope?: string; inFlightTargetsPreserved?: boolean }> {
        const response = await fetch(`${API_BASE}/api/storage/switch`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ provider, accountId }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '切换存储失败');
        }
        return response.json();
    }

    // 获取所有账户
    async getAccounts(): Promise<StorageAccount[]> {
        const response = await fetch(`${API_BASE}/api/storage/accounts`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('获取账户列表失败');
        return response.json();
    }

    async probeStorageAccount(accountId: string): Promise<{ success: boolean; accountId: string; provider: string; status: 'available'; checkedAt: string }> {
        const response = await fetch(`${API_BASE}/api/storage/accounts/${encodeURIComponent(accountId)}/probe`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '存储账户连接测试失败');
        }
        return response.json();
    }

    // 删除账户：先获取影响快照，用户确认后再传回一次性令牌执行。
    async previewAccountDeletion(accountId: string): Promise<{ confirmationToken: string; expiresAt: string; impact: StorageDeleteImpact }> {
        const response = await fetch(`${API_BASE}/api/storage/accounts/${accountId}/delete-confirmation`, {
            credentials: 'include', method: 'POST', headers: getHeaders(),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '无法创建删除确认');
        return response.json();
    }

    async deleteAccount(accountId: string, confirmationToken: string): Promise<{ success: boolean; message: string }> {
        const response = await fetch(`${API_BASE}/api/storage/accounts/${accountId}`, {
            credentials: 'include',
            method: 'DELETE',
            headers: getHeaders({ 'X-Confirmation-Token': confirmationToken }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '删除账户失败');
        }
        return response.json();
    }

    async createFolder(folderName: string): Promise<{ success: boolean; folder: string }> {
        const response = await fetch(`${API_BASE}/api/files/folders`, {
            credentials: 'include',
            method: 'POST',
            headers: {
                ...getHeaders(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ folderName }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '创建文件夹失败');
        }

        return response.json();
    }

    // 重命名文件
    async renameFile(id: string, name: string): Promise<{ success: boolean; name: string }> {
        const response = await fetch(`${API_BASE}/api/files/${id}/rename`, {
            credentials: 'include',
            method: 'PATCH',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '重命名失败');
        }
        return response.json();
    }

    // 重命名文件夹
    async renameFolder(oldName: string, newName: string): Promise<{ success: boolean; name: string }> {
        const response = await fetch(`${API_BASE}/api/files/rename-folder`, {
            credentials: 'include',
            method: 'PATCH',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ oldName, newName }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '重命名文件夹失败');
        }
        return response.json();
    }

    // 移动文件
    async moveFile(id: string, folder: string | null): Promise<{ success: boolean; folder: string | null }> {
        const response = await fetch(`${API_BASE}/api/files/${id}/move`, {
            credentials: 'include',
            method: 'PATCH',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ folder }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '移动失败');
        }
        return response.json();
    }

    // 移动文件夹
    async moveFolder(oldName: string, newName: string | null): Promise<{ success: boolean; folder: string | null }> {
        const response = await fetch(`${API_BASE}/api/files/move-folder`, {
            credentials: 'include',
            method: 'PATCH',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ oldName, newName }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '移动文件夹失败');
        }
        return response.json();
    }

    async previewMoveFolder(oldName: string, newName: string | null, signal?: AbortSignal): Promise<FolderMovePreview> {
        const response = await fetch(`${API_BASE}/api/files/move-folder/preview`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ oldName, newName }),
            signal,
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || '获取移动影响范围失败');
        return payload;
    }
    // 获取收藏的文件
    async getFavoriteFiles(): Promise<FileData[]> {
        const page = await this.getFilesPage({ favorite: true });
        return page.files;
    }

    // 切换文件收藏状态
    async toggleFavorite(fileId: string): Promise<{ success: boolean; isFavorite: boolean }> {
        const response = await fetch(`${API_BASE}/api/files/${fileId}/favorite`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('切换收藏状态失败');
        return response.json();
    }

    // 切换文件夹收藏状态
    async toggleFolderFavorite(folderName: string): Promise<{ success: boolean; isFavorite: boolean }> {
        const response = await fetch(`${API_BASE}/api/files/folders/favorite`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ folderName }),
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('切换文件夹收藏状态失败');
        return response.json();
    }

    // 健康检查
    async healthCheck(): Promise<{ status: string; timestamp: string }> {
        const response = await fetch(`${API_BASE}/health`);
        if (!response.ok) throw new Error('健康检查失败');
        return response.json();
    }

    async getOneDriveAuthUrl(clientId: string, tenantId: string = 'common', clientSecret?: string, name?: string): Promise<OAuthStartResult> {
        const response = await fetch(`${API_BASE}/api/storage/config/onedrive/auth-url`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ clientId, tenantId, clientSecret, name }),
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '获取授权地址失败');
        }
        return response.json();
    }

    async getGoogleDriveAuthUrl(clientId: string, clientSecret: string, name?: string, sharedDriveId?: string): Promise<OAuthStartResult> {
        const response = await fetch(`${API_BASE}/api/storage/config/google-drive/auth-url`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ clientId, clientSecret, name, sharedDriveId }),
        });
        if (response.status === 401 || response.status === 428) throw new Error('UNAUTHORIZED');
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '获取授权地址失败');
        }
        return response.json();
    }
}

export const fileApi = new FileAPI();
export default fileApi;
