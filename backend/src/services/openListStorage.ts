import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IStorageProvider } from './storage.js';
import type { StorageReadOptions, StorageWriteOptions } from './storage/contracts.js';
import { trackUploadProgress } from './storage/uploadProgress.js';
import { fetchPublicHttpUrl } from '../utils/networkSecurity.js';
import { isRecord } from '../utils/typeGuards.js';

interface OpenListEnvelope<T = unknown> {
    code: number;
    message?: string;
    data?: T;
}

interface OpenListFileInfo {
    name?: string;
    size?: number;
    is_dir?: boolean;
    raw_url?: string;
}

interface OpenListLoginData {
    token?: string;
}

export class OpenListRequestError extends Error {
    status?: number;
    statusCode?: number;
    code?: string;
    response?: { status: number };
    cause?: unknown;
    remoteMessage?: string;

    constructor(message: string, options: { status?: number; code?: number | string; cause?: unknown; remoteMessage?: string } = {}) {
        super(message);
        this.name = 'OpenListRequestError';
        this.status = options.status;
        this.statusCode = options.status;
        this.code = options.code === undefined ? undefined : String(options.code);
        this.response = options.status ? { status: options.status } : undefined;
        this.cause = options.cause;
        this.remoteMessage = options.remoteMessage;
    }
}

function isMissingOpenListObject(error: unknown): boolean {
    // OpenList wraps its ObjectNotFound sentinel in an envelope with code 500.
    // Do not treat generic HTTP 404s, provider/login failures, or arbitrary "not found" text as absence.
    return error instanceof OpenListRequestError && error.code === '500'
        && typeof error.remoteMessage === 'string'
        && /(?:^|: )object not found$/.test(error.remoteMessage);
}

function normalizeAddress(value: string): string {
    return value.trim().replace(/\/+$/g, '');
}

function normalizeRoot(value: string): string {
    const normalized = path.posix.normalize(`/${String(value || '/').replace(/\\/g, '/')}`);
    return normalized === '.' ? '/' : normalized;
}

function joinRemotePath(root: string, folder?: string | null, name?: string): string {
    const segments = [root];
    if (folder) segments.push(String(folder).replace(/\\/g, '/'));
    if (name) segments.push(name);
    return path.posix.join(...segments);
}

function encodeFilePath(value: string): string {
    return encodeURIComponent(value);
}

function copyResponseMetadata(stream: Readable, response: Response): Readable {
    const enriched = stream as Readable & { upstreamStatus?: number; upstreamHeaders?: Headers };
    enriched.upstreamStatus = response.status;
    enriched.upstreamHeaders = response.headers;
    return enriched;
}

export async function fetchResponseWithBodyTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    fetchImpl: typeof fetch = fetch,
): Promise<Response> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let finished = false;
    let timedOut = false;
    const timeoutError = new OpenListRequestError('OpenList 文件读取超时');
    const clear = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
    };
    const timer = setTimeout(() => {
        if (finished) return;
        timedOut = true;
        controller.abort(timeoutError);
        void reader?.cancel(timeoutError).catch(() => undefined);
    }, timeoutMs);

    try {
        const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
        const response = await fetchImpl(url, { ...init, signal });
        if (!response.body) {
            clear();
            return response;
        }
        reader = response.body.getReader();
        const stream = new ReadableStream<Uint8Array>({
            async pull(target) {
                try {
                    const chunk = await reader!.read();
                    if (timedOut) throw timeoutError;
                    if (chunk.done) {
                        clear();
                        target.close();
                    } else {
                        target.enqueue(chunk.value);
                    }
                } catch (error) {
                    clear();
                    target.error(timedOut ? timeoutError : new OpenListRequestError('OpenList 文件读取失败', { cause: error }));
                }
            },
            async cancel(reason) {
                clear();
                controller.abort(reason);
                await reader!.cancel(reason).catch(() => undefined);
            },
        });
        return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
        clear();
        init.signal?.throwIfAborted();
        if (timedOut || controller.signal.aborted) throw timeoutError;
        throw new OpenListRequestError('OpenList 文件读取失败', { cause: error });
    }
}

export class OpenListStorageProvider implements IStorageProvider {
    name = 'openlist';
    private token: string | null = null;
    private readonly address: string;
    private readonly rootPath: string;

    constructor(
        public id: string,
        address: string,
        rootPath: string = '/',
        private username: string,
        private password: string,
        private requestTimeoutMs = 5 * 60 * 1000,
        private uploadTimeoutMs = 6 * 60 * 60 * 1000,
        private probeTimeoutMs = 15_000,
        private requestFetch: typeof fetch = fetchPublicHttpUrl as typeof fetch,
    ) {
        this.address = normalizeAddress(address);
        this.rootPath = normalizeRoot(rootPath);
    }

    private async login(signal?: AbortSignal): Promise<string> {
        const response = await this.fetchWithTimeout('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: this.username, password: this.password }),
            signal,
        }, this.probeTimeoutMs);
        const envelope = await this.parseEnvelope<OpenListLoginData>(response);
        const token = String(envelope.data?.token || '');
        if (!token) throw new OpenListRequestError('OpenList 登录响应缺少 Token', { status: response.status, code: envelope.code });
        this.token = token;
        return token;
    }

    private async getToken(force = false, signal?: AbortSignal | null): Promise<string> {
        signal?.throwIfAborted();
        if (!force && this.token) return this.token;
        return this.login(signal ?? undefined);
    }

    private async fetchWithTimeout(relativeUrl: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('OpenList request timed out')), timeoutMs);
        try {
            const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
            return await this.requestFetch(`${this.address}${relativeUrl}`, { ...init, signal });
        } catch (error) {
            init.signal?.throwIfAborted();
            if ((error as any)?.name === 'AbortError' || controller.signal.aborted) {
                throw new OpenListRequestError('OpenList 请求超时', { cause: error });
            }
            throw new OpenListRequestError('OpenList 端点无法连接', { cause: error });
        } finally {
            clearTimeout(timer);
        }
    }

    private async parseEnvelope<T>(response: Response): Promise<OpenListEnvelope<T>> {
        let envelope: OpenListEnvelope<T>;
        try {
            envelope = await response.json() as OpenListEnvelope<T>;
        } catch (error) {
            throw new OpenListRequestError('OpenList 返回了无法解析的响应', { status: response.status, cause: error });
        }
        if (!response.ok || envelope.code !== 200) {
            throw new OpenListRequestError(
                envelope.message ? `OpenList 请求失败：${envelope.message}` : `OpenList 请求失败（HTTP ${response.status}）`,
                { status: response.ok ? envelope.code : response.status, code: envelope.code, remoteMessage: envelope.message },
            );
        }
        return envelope;
    }

    private async api<T>(relativeUrl: string, init: RequestInit, timeoutMs = this.requestTimeoutMs, retry = true): Promise<OpenListEnvelope<T>> {
        const token = await this.getToken(false, init.signal);
        const headers = new Headers(init.headers);
        headers.set('Authorization', token);
        const response = await this.fetchWithTimeout(relativeUrl, { ...init, headers }, timeoutMs);
        try {
            return await this.parseEnvelope<T>(response);
        } catch (error) {
            const code = Number((error as OpenListRequestError)?.code || (error as OpenListRequestError)?.status || 0);
            if (retry && (code === 401 || code === 403)) {
                await this.getToken(true, init.signal);
                return this.api<T>(relativeUrl, init, timeoutMs, false);
            }
            throw error;
        }
    }

    private async getInfo(storedPath: string, signal?: AbortSignal): Promise<OpenListFileInfo> {
        const envelope = await this.api<OpenListFileInfo>('/api/fs/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: storedPath }),
            signal,
        });
        if (!envelope.data) throw new OpenListRequestError('OpenList 文件信息为空');
        return envelope.data;
    }

    private async ensureDirectory(remoteDirectory: string): Promise<void> {
        const rootSegments = normalizeRoot(remoteDirectory).split('/').filter(Boolean);
        let current = '';
        for (const segment of rootSegments) {
            current = `${current}/${segment}`;
            try {
                const info = await this.getInfo(current);
                if (!info.is_dir) throw new OpenListRequestError(`OpenList 目标路径不是目录：${current}`);
            } catch (error) {
                if (!isMissingOpenListObject(error)) throw error;
                await this.api('/api/fs/mkdir', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: current }),
                });
            }
        }
    }

    async probe(): Promise<void> {
        await this.api<OpenListFileInfo>('/api/fs/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: this.rootPath }),
        }, this.probeTimeoutMs);
    }

    async fileExists(fileName: string, folder?: string | null): Promise<boolean> {
        const segments = joinRemotePath(this.rootPath, folder).split('/').filter(Boolean);
        let current = '/';
        // Resolve every parent from successful fresh listings. Some mounted drivers flatten lookup
        // failures into "object not found", so that error alone cannot prove a missing folder.
        for (let index = 0; index <= segments.length; index++) {
            const envelope = await this.api<unknown>('/api/fs/list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: current, page: 1, per_page: 0, refresh: true }),
            });
            const listing = envelope.data;
            if (!isRecord(listing) || typeof listing.total !== 'number' || listing.total < 0) {
                throw new OpenListRequestError('OpenList 返回了无效目录信息');
            }
            if (listing.total === 0 && listing.content === null) return false;
            if (!Array.isArray(listing.content) || listing.content.length !== listing.total) {
                throw new OpenListRequestError('OpenList 返回了不完整目录信息');
            }
            const target = index === segments.length ? fileName : segments[index];
            let match: Record<string, unknown> | undefined;
            for (const entry of listing.content) {
                if (!isRecord(entry) || typeof entry.name !== 'string') {
                    throw new OpenListRequestError('OpenList 返回了无效目录条目');
                }
                if (entry.name === target) match = entry;
            }
            if (!match) return false;
            if (index === segments.length) return true;
            if (match.is_dir !== true) throw new OpenListRequestError('OpenList 目标路径不是目录');
            current = joinRemotePath(current, target);
        }
        throw new OpenListRequestError('OpenList 目录解析失败');
    }

    async probeWritable(timeoutMs = this.probeTimeoutMs): Promise<void> {
        const originalRequestTimeout = this.requestTimeoutMs;
        const originalUploadTimeout = this.uploadTimeoutMs;
        this.requestTimeoutMs = Math.min(originalRequestTimeout, timeoutMs);
        this.uploadTimeoutMs = Math.min(originalUploadTimeout, timeoutMs);
        const markerName = `.tgvault-probe-${crypto.randomUUID()}.txt`;
        const tempPath = path.join(os.tmpdir(), markerName);
        const expected = Buffer.from(`tg-vault-openlist-probe:${markerName}`, 'utf8');
        await fs.promises.writeFile(tempPath, expected, { flag: 'wx' });
        let storedPath: string | null = null;
        try {
            storedPath = await this.saveFile(tempPath, markerName, 'text/plain');
            const stream = await this.getFileStream(storedPath);
            const chunks: Buffer[] = [];
            for await (const chunk of stream as any) chunks.push(Buffer.from(chunk));
            if (!Buffer.concat(chunks).equals(expected)) throw new OpenListRequestError('OpenList 写入测试内容校验失败');
        } finally {
            try {
                if (storedPath) await this.deleteFile(storedPath).catch(() => undefined);
                await fs.promises.rm(tempPath, { force: true });
            } finally {
                this.requestTimeoutMs = originalRequestTimeout;
                this.uploadTimeoutMs = originalUploadTimeout;
            }
        }
    }

    async saveFile(tempPath: string, fileName: string, mimeType: string, folder?: string | null, options?: StorageWriteOptions): Promise<string> {
        options?.signal?.throwIfAborted();
        const stats = await fs.promises.stat(tempPath);
        const remoteDirectory = joinRemotePath(this.rootPath, folder);
        const storedPath = joinRemotePath(remoteDirectory, null, fileName);
        await this.ensureDirectory(remoteDirectory);

        const uploadOnce = async () => {
            const token = await this.getToken();
            options?.signal?.throwIfAborted();
            const source = trackUploadProgress(fs.createReadStream(tempPath, { signal: options?.signal }), stats.size, options?.onProgress);
            const body = Readable.toWeb(source, options?.onProgress ? {
                strategy: { highWaterMark: source.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength },
            } : undefined) as ReadableStream;
            try {
                const response = await this.fetchWithTimeout('/api/fs/put', {
                    method: 'PUT',
                    headers: {
                        Authorization: token,
                        'File-Path': encodeFilePath(storedPath),
                        'Content-Type': mimeType || 'application/octet-stream',
                        'Content-Length': String(stats.size),
                        'X-File-Size': String(stats.size),
                        'As-Task': 'false',
                        Overwrite: 'false',
                    },
                    body,
                    signal: options?.signal,
                    duplex: 'half',
                } as RequestInit, this.uploadTimeoutMs);
                return await this.parseEnvelope(response);
            } finally { source.destroy(); }
        };

        try {
            await uploadOnce();
        } catch (error) {
            options?.signal?.throwIfAborted();
            const code = Number((error as OpenListRequestError)?.code || (error as OpenListRequestError)?.status || 0);
            if (code === 401 || code === 403) {
                await this.getToken(true);
                await uploadOnce();
            } else {
                throw error;
            }
        }

        const remote = await this.getInfo(storedPath);
        if (remote.is_dir || Number(remote.size) !== stats.size) {
            throw new OpenListRequestError('OpenList 上传后文件大小校验失败');
        }
        options?.onProgress?.(stats.size, stats.size);
        return storedPath;
    }

    async getFileStream(storedPath: string, options?: StorageReadOptions): Promise<NodeJS.ReadableStream> {
        const info = await this.getInfo(storedPath, options?.signal);
        if (!info.raw_url) throw new OpenListRequestError('OpenList 未返回可读取的文件地址');
        let rawUrl: URL;
        try {
            rawUrl = new URL(info.raw_url);
        } catch (error) {
            throw new OpenListRequestError('OpenList 返回了不安全的文件地址', { cause: error });
        }
        const headers = new Headers();
        if (options?.range) headers.set('Range', options.range);
        const response = await this.fetchWithTimeoutAbsolute(rawUrl.toString(), { method: 'GET', headers, signal: options?.signal }, this.requestTimeoutMs);
        if (!response.ok && response.status !== 206) {
            response.body?.cancel().catch(() => undefined);
            const errorHeaders = new Headers(response.headers);
            if (response.status === 416 && !errorHeaders.has('Content-Range') && Number.isSafeInteger(info.size) && Number(info.size) >= 0) {
                errorHeaders.set('Content-Range', `bytes */${info.size}`);
            }
            throw new OpenListRequestError(`OpenList 文件读取失败（HTTP ${response.status}）`, {
                status: response.status,
                cause: { status: response.status, response: { status: response.status, headers: errorHeaders } },
            });
        }
        if (!response.body) throw new OpenListRequestError('OpenList 文件读取响应为空');
        return copyResponseMetadata(Readable.fromWeb(response.body as any), response);
    }

    private async fetchWithTimeoutAbsolute(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        return fetchResponseWithBodyTimeout(url, init, timeoutMs, this.requestFetch);
    }

    async getFileAvailability(storedPath: string): Promise<{ available: true }> {
        const info = await this.getInfo(storedPath);
        if (info.is_dir) throw new OpenListRequestError('OpenList 目标不是文件');
        return { available: true };
    }

    async getFileSize(storedPath: string): Promise<number> {
        const info = await this.getInfo(storedPath);
        if (info.is_dir) throw new OpenListRequestError('OpenList 目标不是文件');
        const size = Number(info.size);
        if (!Number.isFinite(size) || size < 0) throw new OpenListRequestError('OpenList 返回了无效文件大小');
        return size;
    }

    async getPreviewUrl(_storedPath: string): Promise<string> {
        // Keep the raw URL server-side so TG Vault can enforce its own authorization and Range contract.
        return '';
    }

    async deleteFile(storedPath: string): Promise<void> {
        const normalized = normalizeRoot(storedPath);
        if (normalized === '/' || normalized === this.rootPath) throw new OpenListRequestError('拒绝删除 OpenList 存储根目录');
        await this.api('/api/fs/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: path.posix.dirname(normalized), names: [path.posix.basename(normalized)] }),
        });
    }
}
