import { authService } from './auth';
import { ApiActionError } from './apiActionError';
import { apiRequest } from './httpClient';
import { sha256Hex } from './chunkHash';

import { API_BASE } from './config';
import { classifyBatchDeleteResponse } from './batchDeleteContract';
import { chunkBounds, parseChunkUploadInit } from './chunkUploadProtocol';
import { apiActionErrorFromResponse } from './apiActionError';
import { parseXhrError } from './xhrError';
import { getApiHeaders } from './clients/clientHeaders';
import { systemClient } from './clients/systemClient';
import { tasksClient } from './clients/tasksClient';
import type {
    AdvancedTaskSettings,
    BatchDeletePreview,
    BatchDeleteResult,
    ChunkUploadCancelStatus,
    ChunkUploadSession,
    CreateYtDlpTaskResult,
    FileData,
    FileQueryOptions,
    FilesPage,
    FolderAggregation,
    FolderMovePreview,
    MediaStatus,
    OAuthStartResult,
    StorageAccount,
    StorageConfig,
    StorageDeleteImpact,
    StorageStats,
    TaskDismissalInput,
    TaskDismissalPreview,
    TaskDismissalResult,
    TaskFilters,
    TelegramBotPublicConfig,
    TelegramAdDecisionList,
    TelegramAdFilterMode,
    TelegramAdRule,
    TelegramAdRuleAction,
    TelegramAdRuleKind,
    TelegramSubscription,
    TelegramSubscriptionList,
    TelegramPermissionCheckResult,
    TelegramUserAccountStatus,
    TelegramUserAccountsOverview,
    TelegramUserLoginComplete,
    TelegramUserLoginStatus,
    TelegramUserPhoneLoginStarted,
    TelegramUserQrLoginStarted,
    UnifiedTaskList,
    UnifiedTaskSource,
    UpdateStatus,
    UploadCapabilities,
    UploadProgress,
    UploadTargetSnapshot,
} from './apiTypes';

export type * from './apiTypes';

const getHeaders = getApiHeaders;

async function postStorageAccount<T>(path: string, body: unknown, providerLabel: string): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 65_000);
    let response: Response;
    try {
        response = await apiRequest(`${API_BASE}${path}`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`${providerLabel} 连接测试超时，请检查服务器地址和网络`);
        }
        throw error;
    } finally {
        window.clearTimeout(timeout);
    }
    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error || `添加 ${providerLabel} 账户失败`);
    }
    return response.json();
}

class FileAPI {
    private uploadCapabilitiesPromise: Promise<UploadCapabilities> | null = null;

    async getUploadCapabilities(): Promise<UploadCapabilities> {
        if (!this.uploadCapabilitiesPromise) {
            this.uploadCapabilitiesPromise = apiRequest(`${API_BASE}/api/upload/capabilities`, {
                credentials: 'include',
                headers: getHeaders(),
            }).then(async response => {
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
        const response = await apiRequest(`${API_BASE}/api/files?${params.toString()}`, {
            credentials: 'include',
            headers: getHeaders(),
            signal: options.signal,
        });
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
        const response = await apiRequest(`${API_BASE}/api/files/folders/aggregation?${params.toString()}`, {
            credentials: 'include',
            headers: getHeaders(),
            signal: options.signal,
        });
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
        const response = await apiRequest(`${API_BASE}/api/files/${id}`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (!response.ok) throw new Error('获取文件信息失败');
        return response.json();
    }

    async getMediaStatus(fileId: string): Promise<MediaStatus> {
        const response = await apiRequest(`${API_BASE}/api/files/${fileId}/media-status`, {
            credentials: 'include',
            headers: getHeaders(),
            classifyErrors: false,
        });
        const payload = await response.json().catch(() => ({}));
        return {
            available: response.ok && payload.available !== false,
            source: payload.source,
            code: payload.code,
            error: payload.error,
            reason: payload.reason,
        };
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
        const response = await apiRequest(`${API_BASE}/api/chunked/sessions`, {
            credentials: 'include',
            headers: getHeaders(),
        });
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
        const response = await apiRequest(`${API_BASE}/api/chunked/${uploadId}`, {
            credentials: 'include',
            method: 'DELETE',
            headers: getHeaders(),
            acceptedStatuses: [404, 409],
        });
        const payload = await response.json().catch(() => ({}));
        if (response.status === 409 && payload.status === 'busy') return 'busy';
        if (response.status === 404) return 'not_found';
        if (!response.ok) {
            throw new Error(payload.error || '取消上传失败');
        }
        return ['cancelled', 'terminal'].includes(payload.status) ? payload.status : 'terminal';
    }

    async createYtDlpTask(input: { url: string; format: 'best' | 'audio' }): Promise<CreateYtDlpTaskResult> {
        return tasksClient.createYtDlpTask(input);
    }

    async getTasks(filters: TaskFilters = {}): Promise<UnifiedTaskList> {
        return tasksClient.getTasks(filters);
    }

    async controlTask(sourceType: UnifiedTaskSource, id: string, action: 'cancel' | 'retry'): Promise<void> {
        return tasksClient.controlTask(sourceType, id, action);
    }

    async prepareTaskDismissal(input: TaskDismissalInput): Promise<TaskDismissalPreview> {
        return tasksClient.prepareTaskDismissal(input);
    }

    async confirmTaskDismissal(preview: TaskDismissalPreview): Promise<TaskDismissalResult> {
        return tasksClient.confirmTaskDismissal(preview);
    }

    async getSubscriptions(filters: { limit?: number; offset?: number } = {}): Promise<TelegramSubscriptionList> {
        const params = new URLSearchParams({ limit: String(filters.limit || 20), offset: String(filters.offset || 0) });
        const response = await apiRequest(`${API_BASE}/api/subscriptions?${params.toString()}`, { credentials: 'include', headers: getHeaders() });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '获取订阅列表失败');
        return response.json();
    }

    async updateSubscriptionAdFilter(subscriptionId: string, adFilterMode: TelegramAdFilterMode): Promise<TelegramSubscription> {
        const response = await apiRequest(`${API_BASE}/api/subscriptions/${encodeURIComponent(subscriptionId)}`, {
            credentials: 'include', method: 'PATCH', headers: getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ adFilterMode }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '更新广告过滤模式失败');
        return (await response.json()).subscription;
    }

    async getSubscriptionAdRules(subscriptionId: string): Promise<TelegramAdRule[]> {
        const response = await apiRequest(`${API_BASE}/api/subscriptions/${encodeURIComponent(subscriptionId)}/rules`, { credentials: 'include', headers: getHeaders() });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '获取过滤规则失败');
        return (await response.json()).rules || [];
    }

    async createSubscriptionAdRule(subscriptionId: string, input: { kind: TelegramAdRuleKind; action: TelegramAdRuleAction; pattern: string; label?: string }): Promise<TelegramAdRule> {
        const response = await apiRequest(`${API_BASE}/api/subscriptions/${encodeURIComponent(subscriptionId)}/rules`, {
            credentials: 'include', method: 'POST', headers: getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(input),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '创建过滤规则失败');
        return (await response.json()).rule;
    }

    async setSubscriptionAdRuleEnabled(subscriptionId: string, ruleId: string, enabled: boolean): Promise<TelegramAdRule> {
        const response = await apiRequest(`${API_BASE}/api/subscriptions/${encodeURIComponent(subscriptionId)}/rules/${encodeURIComponent(ruleId)}`, {
            credentials: 'include', method: 'PATCH', headers: getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ enabled }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '更新过滤规则失败');
        return (await response.json()).rule;
    }

    async deleteSubscriptionAdRule(subscriptionId: string, ruleId: string): Promise<void> {
        const response = await apiRequest(`${API_BASE}/api/subscriptions/${encodeURIComponent(subscriptionId)}/rules/${encodeURIComponent(ruleId)}`, {
            credentials: 'include', method: 'DELETE', headers: getHeaders(),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '删除过滤规则失败');
    }

    async getSubscriptionAdDecisions(filters: { subscriptionId?: string; decision?: 'blocked' | 'review' | 'allow'; limit?: number; offset?: number } = {}): Promise<TelegramAdDecisionList> {
        const params = new URLSearchParams();
        if (filters.subscriptionId) params.set('subscriptionId', filters.subscriptionId);
        if (filters.decision) params.set('decision', filters.decision);
        params.set('limit', String(filters.limit || 100));
        params.set('offset', String(filters.offset || 0));
        const response = await apiRequest(`${API_BASE}/api/subscriptions/decisions/list?${params.toString()}`, { credentials: 'include', headers: getHeaders() });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '获取过滤记录失败');
        return response.json();
    }

    async reviewSubscriptionAdDecision(decisionId: string, label: 'ad' | 'normal', learnTemplate = true): Promise<{ restoredJobId?: string | null }> {
        const response = await apiRequest(`${API_BASE}/api/subscriptions/decisions/${encodeURIComponent(decisionId)}/review`, {
            credentials: 'include', method: 'POST', headers: getHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ label, learnTemplate }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '修正过滤结果失败');
        return response.json();
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
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch {
                        reject(new Error('解析响应失败'));
                    }
                } else {
                    const error = parseXhrError(xhr.status, xhr.responseText);
                    if (error instanceof ApiActionError && error.kind === 'unauthorized') authService.invalidateSession(error.status);
                    reject(error);
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
                const retryResponse = await apiRequest(`${API_BASE}/api/chunked/${uploadId}/retry`, {
                    credentials: 'include', method: 'POST', headers: getHeaders(), signal,
                });
                if (!retryResponse.ok) throw new Error('服务器无法重新打开该上传会话');
            }
            onProgress?.({ loaded: uploadedBytes, total: file.size, percent: Math.round((uploadedBytes / file.size) * 100) });
        } else {
            const initResponse = await apiRequest(`${API_BASE}/api/chunked/init`, {
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

                const chunkResponse = await apiRequest(`${API_BASE}/api/chunked/chunk`, {
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

            const completeResponse = await apiRequest(`${API_BASE}/api/chunked/complete`, {
                credentials: 'include',
                method: 'POST',
                headers: getHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ uploadId }),
                signal,
            });

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
        const confirmationResponse = await apiRequest(`${API_BASE}/api/files/${id}/delete-confirmation`, {
            credentials: 'include', method: 'POST', headers: getHeaders(),
        });
        if (!confirmationResponse.ok) throw new Error((await confirmationResponse.json().catch(() => ({}))).error || '无法创建删除确认');
        const { confirmationToken } = await confirmationResponse.json();
        const response = await apiRequest(`${API_BASE}/api/files/${id}`, {
            credentials: 'include',
            method: 'DELETE',
            headers: getHeaders({ 'X-Confirmation-Token': confirmationToken }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || payload.details || '删除文件失败');
        return payload;
    }

    async previewBatchDelete(fileIds: string[], folderNames: string[]): Promise<BatchDeletePreview> {
        const response = await apiRequest(`${API_BASE}/api/files/batch-delete/preview`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ fileIds, folderNames }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '获取删除影响范围失败');
        }
        return response.json();
    }

    // 批量删除
    async batchDelete(confirmationToken: string): Promise<BatchDeleteResult> {
        const response = await apiRequest(`${API_BASE}/api/files/batch-delete`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ confirmationToken }),
            classifyErrors: false,
        });
        return classifyBatchDeleteResponse(response);
    }

    // 创建分享链接
    async createShareLink(fileId: string, password?: string, expiration?: string): Promise<{ link: string }> {
        const response = await apiRequest(`${API_BASE}/api/files/${fileId}/share`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ password, expiration }),
        });

        if (!response.ok) throw await apiActionErrorFromResponse(response, '创建分享链接失败');
        return response.json();
    }

    // 获取下载 URL (直接链接或签名链接)
    async getDownloadLink(id: string): Promise<string> {
        const response = await apiRequest(`${API_BASE}/api/files/${id}/download-url`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (!response.ok) throw await apiActionErrorFromResponse(response, '获取下载链接失败');

        const data = await response.json();
        if (data.isRelative) {
            return `${API_BASE}${data.url}`;
        }
        return data.url;
    }

    async getOriginalFileLink(id: string): Promise<string> {
        const response = await apiRequest(`${API_BASE}/api/files/${id}/original`, { credentials: 'include', headers: getHeaders(), redirect: 'manual', acceptedStatuses: [301, 302, 303, 307, 308] });
        if (!response.ok && response.type !== 'opaqueredirect') throw await apiActionErrorFromResponse(response, '打开原文件失败');
        return response.headers.get('Location') || `${API_BASE}/api/files/${id}/original`;
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
        const response = await apiRequest(`${API_BASE}/api/storage/config/advanced-tasks`, {
            credentials: 'include', headers: getHeaders(),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '获取高级任务设置失败');
        return response.json();
    }

    async updateAdvancedTaskSetting(patch: Partial<Pick<AdvancedTaskSettings, 'telegramDownloadWorkers' | 'telegramFileConcurrency' | 'duplicateMode' | 'autoCleanupOrphans' | 'skipTelegramPhotosInBatch' | 'telegramDownloadHistoryPolicy'>>, confirmed = false): Promise<{ success: boolean; deletedCount?: number }> {
        const response = await apiRequest(`${API_BASE}/api/storage/config/advanced-tasks`, {
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
        return payload;
    }

    async getStorageStats(): Promise<StorageStats> {
        const response = await apiRequest(`${API_BASE}/api/storage/stats`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (!response.ok) throw new Error('获取存储统计失败');
        return response.json();
    }

    // 获取存储配置
    async getStorageConfig(): Promise<StorageConfig> {
        const response = await apiRequest(`${API_BASE}/api/storage/config`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (!response.ok) throw new Error('获取存储配置失败');
        return response.json();
    }

    async setUnsafeWebdavEndpointsAllowed(enabled: boolean, confirmed = false): Promise<{ success: boolean; allowUnsafeWebdavEndpoints: boolean }> {
        const response = await apiRequest(`${API_BASE}/api/storage/config/webdav-security`, {
            credentials: 'include',
            method: 'PATCH',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ enabled, confirmed }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || '更新 WebDAV 安全设置失败') as Error & { code?: string };
            error.code = payload.code;
            throw error;
        }
        return payload;
    }

    async getTelegramBotConfig(): Promise<TelegramBotPublicConfig> {
        const response = await apiRequest(`${API_BASE}/api/storage/config/telegram-bot`, { credentials: 'include', headers: getHeaders() });
        if (!response.ok) throw new Error('获取 Telegram Bot 配置失败');
        return response.json();
    }

    async getUpdateStatus(): Promise<UpdateStatus> {
        return systemClient.getUpdateStatus();
    }

    async checkForUpdates(): Promise<UpdateStatus> {
        return systemClient.checkForUpdates();
    }

    async testTelegramBotConfig(input: { botToken: string; apiId: string; apiHash: string }): Promise<{ success: boolean; bot: { username: string | null; displayName: string | null } }> {
        return this.telegramBotConfigRequest('/api/storage/config/telegram-bot/test', 'POST', input);
    }

    async saveTelegramBotConfig(input: { botToken: string; apiId: string; apiHash: string; enabled: boolean; required: boolean; telegramPin?: string }): Promise<{ success: boolean; config: TelegramBotPublicConfig }> {
        return this.telegramBotConfigRequest('/api/storage/config/telegram-bot', 'PUT', input);
    }

    async migrateTelegramBotConfig(input: { telegramPin?: string } = {}): Promise<{ success: boolean; config: TelegramBotPublicConfig }> {
        return this.telegramBotConfigRequest('/api/storage/config/telegram-bot/migrate', 'POST', input);
    }

    async changeTelegramBotPin(input: { verificationMethod: 'current_pin' | 'web_password'; verificationSecret: string; newPin: string }): Promise<{ success: boolean; message: string }> {
        return this.telegramBotConfigRequest('/api/storage/config/telegram-bot/pin', 'PUT', input);
    }

    async disableTelegramBot(): Promise<{ success: boolean; config: TelegramBotPublicConfig }> {
        return this.telegramBotConfigRequest('/api/storage/config/telegram-bot/disable', 'POST', {});
    }

    async deleteTelegramBotConfig(): Promise<{ success: boolean; config: TelegramBotPublicConfig }> {
        return this.telegramBotConfigRequest('/api/storage/config/telegram-bot', 'DELETE', { confirmed: true });
    }

    private async telegramBotConfigRequest(path: string, method: string, body: unknown): Promise<any> {
        const response = await apiRequest(`${API_BASE}${path}`, {
            credentials: 'include', method,
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Telegram Bot 配置操作失败');
        return payload;
    }

    async getTelegramUserAccounts(): Promise<TelegramUserAccountsOverview> {
        return this.telegramUserRequest('/api/storage/config/telegram-user/accounts', 'GET');
    }

    async startTelegramUserQrLogin(): Promise<TelegramUserQrLoginStarted> {
        const payload = await this.telegramUserRequest('/api/storage/config/telegram-user/login/qr', 'POST');
        return this.normalizeTelegramUserLoginStatus(payload) as TelegramUserQrLoginStarted;
    }

    async getTelegramUserLoginStatus(flowId: string): Promise<TelegramUserLoginStatus> {
        const payload = await this.telegramUserRequest(`/api/storage/config/telegram-user/login/${encodeURIComponent(flowId)}`, 'GET');
        return this.normalizeTelegramUserLoginStatus(payload);
    }

    async cancelTelegramUserLogin(flowId: string): Promise<{ success: boolean }> {
        return this.telegramUserRequest(`/api/storage/config/telegram-user/login/${encodeURIComponent(flowId)}`, 'DELETE');
    }

    async startTelegramUserPhoneLogin(phone: string): Promise<TelegramUserPhoneLoginStarted> {
        const payload = await this.telegramUserRequest('/api/storage/config/telegram-accounts/login/phone', 'POST', { phone });
        return this.normalizeTelegramUserLoginStatus(payload) as TelegramUserPhoneLoginStarted;
    }

    async submitTelegramUserLoginCode(flowId: string, code: string): Promise<TelegramUserLoginStatus> {
        const payload = await this.telegramUserRequest('/api/storage/config/telegram-accounts/login/code', 'POST', { flowId, code });
        return this.normalizeTelegramUserLoginStatus(payload, flowId);
    }

    async submitTelegramUserLoginPassword(flowId: string, password: string): Promise<TelegramUserLoginStatus> {
        const payload = await this.telegramUserRequest('/api/storage/config/telegram-accounts/login/password', 'POST', { flowId, password });
        return this.normalizeTelegramUserLoginStatus(payload, flowId);
    }

    async setTelegramUserAccountEnabled(accountId: string, enabled: boolean): Promise<{ success: boolean; enabled: boolean }> {
        return this.telegramUserRequest(`/api/storage/config/telegram-user/accounts/${encodeURIComponent(accountId)}/${enabled ? 'enable' : 'disable'}`, 'POST');
    }

    async unlinkTelegramUserAccountById(accountId: string): Promise<{ success: boolean }> {
        return this.telegramUserRequest(`/api/storage/config/telegram-user/accounts/${encodeURIComponent(accountId)}`, 'DELETE');
    }

    async checkTelegramUserAccountPermissions(accountId: string): Promise<TelegramPermissionCheckResult> {
        return this.telegramUserRequest(`/api/storage/config/telegram-user/accounts/${encodeURIComponent(accountId)}/permissions/check`, 'POST');
    }

    async getTelegramUserAccount(): Promise<TelegramUserAccountStatus> {
        return this.telegramUserRequest('/api/storage/config/telegram-user', 'GET');
    }

    async startTelegramUserLogin(phone: string): Promise<{ flowId: string; delivery: 'app' | 'sms'; expiresAt: string }> {
        return this.telegramUserRequest('/api/storage/config/telegram-user/login/phone', 'POST', { phone });
    }

    async submitTelegramUserCode(flowId: string, code: string): Promise<{ step: 'password_required' } | TelegramUserLoginComplete> {
        return this.telegramUserRequest('/api/storage/config/telegram-user/login/code', 'POST', { flowId, code });
    }

    async submitTelegramUserPassword(flowId: string, password: string): Promise<TelegramUserLoginComplete> {
        return this.telegramUserRequest('/api/storage/config/telegram-user/login/password', 'POST', { flowId, password });
    }

    async disableTelegramUserAccount(): Promise<{ success: boolean; enabled: false }> {
        return this.telegramUserRequest('/api/storage/config/telegram-user/disable', 'POST');
    }

    async unlinkTelegramUserAccount(): Promise<{ success: boolean }> {
        return this.telegramUserRequest('/api/storage/config/telegram-user', 'DELETE');
    }

    private normalizeTelegramUserLoginStatus(payload: any, fallbackFlowId = ''): TelegramUserLoginStatus {
        if (payload?.step === 'complete') {
            return { flowId: String(payload.flowId || fallbackFlowId), status: 'complete', account: payload.account };
        }
        if (payload?.step === 'password_required') {
            return { flowId: String(payload.flowId || fallbackFlowId), status: 'password_required' };
        }
        const rawStatus = String(payload?.status || (payload?.delivery ? 'code_required' : 'error'));
        const status = rawStatus === 'pending' ? 'waiting_for_scan' : rawStatus as TelegramUserLoginStatus['status'];
        const qrCode = typeof payload?.qrCode === 'string'
            ? payload.qrCode
            : typeof payload?.qrData === 'string' ? payload.qrData : undefined;
        return {
            flowId: String(payload?.flowId || fallbackFlowId),
            status,
            ...(qrCode ? { qrCode, qrExpiresAt: String(payload?.qrExpiresAt || payload?.expiresAt || '') } : {}),
            ...(payload?.expiresAt ? { expiresAt: String(payload.expiresAt) } : {}),
            ...(payload?.account ? { account: payload.account } : {}),
            ...(payload?.delivery ? { delivery: payload.delivery, message: payload.delivery === 'sms' ? '短信' : 'Telegram 应用' } : payload?.message ? { message: String(payload.message) } : {}),
        } as TelegramUserLoginStatus;
    }

    private async telegramUserRequest(path: string, method: string, body?: unknown): Promise<any> {
        const response = await apiRequest(`${API_BASE}${path}`, { credentials: 'include', method, headers: getHeaders({ 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Telegram 用户账号操作失败');
        return payload;
    }

    async setTelegramUserDownloadEnabled(enabled: boolean): Promise<{ success: boolean; enabled: boolean }> {
        const response = await apiRequest(`${API_BASE}/api/storage/config/telegram-user-download`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ enabled }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '更新 Telegram 用户下载设置失败');
        }
        return response.json();
    }

    async setTelegramAllowedUserIds(userIds: string): Promise<{ success: boolean; userIds: number[] }> {
        const response = await apiRequest(`${API_BASE}/api/storage/config/telegram-allowed-users`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ userIds }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '更新 Telegram 允许用户列表失败');
        }
        return response.json();
    }

    async cleanupDownloadItems(retentionDays: number = 7): Promise<{ success: boolean; deletedCount: number; retentionDays: number }> {
        const response = await apiRequest(`${API_BASE}/api/storage/maintenance/download-items/cleanup`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ retentionDays }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '清理下载任务明细失败');
        }
        return response.json();
    }

    // 更新 OneDrive 配置
    async updateOneDriveConfig(clientId: string, clientSecret: string, refreshToken: string, tenantId: string = 'common', name?: string): Promise<{ success: boolean; message: string }> {
        const response = await apiRequest(`${API_BASE}/api/storage/config/onedrive`, {
            credentials: 'include',
            method: 'PUT',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ clientId, clientSecret, refreshToken, tenantId, name }),
        });
        if (!response.ok) throw new Error('更新配置失败');
        return response.json();
    }

    // 添加 Aliyun OSS 账户
    async addAliyunOSSAccount(name: string, region: string, accessKeyId: string, accessKeySecret: string, bucket: string): Promise<{ success: boolean; message: string; accountId: string }> {
        return postStorageAccount('/api/storage/config/aliyun-oss', { name, region, accessKeyId, accessKeySecret, bucket }, 'Aliyun OSS');
    }

    // 添加 S3 账户
    async addS3Account(name: string, endpoint: string, region: string, accessKeyId: string, accessKeySecret: string, bucket: string, forcePathStyle: boolean = false): Promise<{ success: boolean; message: string; accountId: string }> {
        return postStorageAccount('/api/storage/config/s3', { name, endpoint, region, accessKeyId, accessKeySecret, bucket, forcePathStyle }, 'S3');
    }

    // 添加 WebDAV 账户
    async addWebDAVAccount(name: string, url: string, username?: string, password?: string): Promise<{ success: boolean; message: string; accountId: string }> {
        return postStorageAccount('/api/storage/config/webdav', { name, url, username, password }, 'WebDAV');
    }

    // 添加 OpenList 原生存储账户
    async addOpenListAccount(name: string, baseUrl: string, rootPath: string, username: string, password: string): Promise<{ success: boolean; message: string; accountId: string }> {
        return postStorageAccount('/api/storage/config/openlist', { name, baseUrl, rootPath, username, password }, 'OpenList');
    }

    // 切换存储提供商或账户
    async switchStorageProvider(provider: 'local' | 'onedrive' | 'aliyun_oss' | 's3' | 'webdav' | 'openlist' | 'google_drive', accountId?: string): Promise<{ success: boolean; message: string; scope?: string; inFlightTargetsPreserved?: boolean }> {
        const response = await apiRequest(`${API_BASE}/api/storage/switch`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ provider, accountId }),
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '切换存储失败');
        }
        return response.json();
    }

    // 获取所有账户
    async getAccounts(): Promise<StorageAccount[]> {
        const response = await apiRequest(`${API_BASE}/api/storage/accounts`, {
            credentials: 'include',
            headers: getHeaders(),
        });
        if (!response.ok) throw new Error('获取账户列表失败');
        return response.json();
    }

    async probeStorageAccount(accountId: string): Promise<{ success: boolean; accountId: string; provider: string; status: 'available'; checkedAt: string }> {
        const response = await apiRequest(`${API_BASE}/api/storage/accounts/${encodeURIComponent(accountId)}/probe`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '存储账户连接测试失败');
        }
        return response.json();
    }

    // 删除账户：先获取影响快照，用户确认后再传回一次性令牌执行。
    async previewAccountDeletion(accountId: string): Promise<{ confirmationToken: string; expiresAt: number; impact: StorageDeleteImpact }> {
        const response = await apiRequest(`${API_BASE}/api/storage/accounts/${encodeURIComponent(accountId)}/delete-confirmation`, {
            credentials: 'include', method: 'POST', headers: getHeaders(),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '无法创建删除确认');
        return response.json();
    }

    async deleteAccount(accountId: string, confirmationToken: string): Promise<{ success: boolean; message: string }> {
        const response = await apiRequest(`${API_BASE}/api/storage/accounts/${encodeURIComponent(accountId)}`, {
            credentials: 'include',
            method: 'DELETE',
            headers: getHeaders({ 'X-Confirmation-Token': confirmationToken }),
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '删除账户失败');
        }
        return response.json();
    }

    async createFolder(folderName: string): Promise<{ success: boolean; folder: string }> {
        const response = await apiRequest(`${API_BASE}/api/files/folders`, {
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
        const response = await apiRequest(`${API_BASE}/api/files/${id}/rename`, {
            credentials: 'include',
            method: 'PATCH',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name }),
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '重命名失败');
        }
        return response.json();
    }

    // 重命名文件夹
    async renameFolder(oldName: string, newName: string): Promise<{ success: boolean; name: string }> {
        const response = await apiRequest(`${API_BASE}/api/files/rename-folder`, {
            credentials: 'include',
            method: 'PATCH',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ oldName, newName }),
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '重命名文件夹失败');
        }
        return response.json();
    }

    // 移动文件
    async moveFile(id: string, folder: string | null): Promise<{ success: boolean; folder: string | null }> {
        const response = await apiRequest(`${API_BASE}/api/files/${id}/move`, {
            credentials: 'include',
            method: 'PATCH',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ folder }),
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '移动失败');
        }
        return response.json();
    }

    // 移动文件夹
    async moveFolder(oldName: string, newName: string | null): Promise<{ success: boolean; folder: string | null }> {
        const response = await apiRequest(`${API_BASE}/api/files/move-folder`, {
            credentials: 'include',
            method: 'PATCH',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ oldName, newName }),
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '移动文件夹失败');
        }
        return response.json();
    }

    async previewMoveFolder(oldName: string, newName: string | null, signal?: AbortSignal): Promise<FolderMovePreview> {
        const response = await apiRequest(`${API_BASE}/api/files/move-folder/preview`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ oldName, newName }),
            signal,
        });
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
        const response = await apiRequest(`${API_BASE}/api/files/${fileId}/favorite`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
        });
        if (!response.ok) throw new Error('切换收藏状态失败');
        return response.json();
    }

    // 切换文件夹收藏状态
    async toggleFolderFavorite(folderName: string): Promise<{ success: boolean; isFavorite: boolean }> {
        const response = await apiRequest(`${API_BASE}/api/files/folders/favorite`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ folderName }),
        });
        if (!response.ok) throw new Error('切换文件夹收藏状态失败');
        return response.json();
    }

    // 健康检查
    async healthCheck(): Promise<{ status: string; timestamp: string }> {
        return systemClient.healthCheck();
    }

    async getOneDriveAuthUrl(clientId: string, tenantId: string = 'common', clientSecret?: string, name?: string): Promise<OAuthStartResult> {
        const response = await apiRequest(`${API_BASE}/api/storage/config/onedrive/auth-url`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ clientId, tenantId, clientSecret, name }),
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '获取授权地址失败');
        }
        return response.json();
    }

    async getGoogleDriveAuthUrl(clientId: string, clientSecret: string, name?: string, sharedDriveId?: string): Promise<OAuthStartResult> {
        const response = await apiRequest(`${API_BASE}/api/storage/config/google-drive/auth-url`, {
            credentials: 'include',
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ clientId, clientSecret, name, sharedDriveId }),
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '获取授权地址失败');
        }
        return response.json();
    }
}

export const fileApi = new FileAPI();
export default fileApi;
