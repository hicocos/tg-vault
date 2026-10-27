import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import axios from 'axios';
import { isRecord } from '../utils/typeGuards.js';
import type { StorageUploadProgress } from './storage/contracts.js';

const FRAGMENT_BYTES = 320 * 1024 * 10;
const MAX_ATTEMPTS = 3;

interface UploadInput {
    tempPath: string;
    resourceUrl: string;
    fileName: string;
    mimeType: string;
    getAccessToken: () => Promise<string>;
    signal?: AbortSignal;
    onProgress?: StorageUploadProgress;
}

interface DriveItem {
    id: string;
    name: string;
    size: number;
    sha1?: string;
    quickXor?: string;
}

function errorDetails(error: unknown) {
    const response = axios.isAxiosError<unknown>(error) ? error.response : undefined;
    const status = response?.status || 0;
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    const header = response?.headers['retry-after'];
    let retryAfter: number | undefined;
    if (typeof header === 'string' || typeof header === 'number') {
        const seconds = Number(header);
        const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(header)) - Date.now();
        if (Number.isFinite(milliseconds)) retryAfter = Math.max(0, milliseconds);
    }
    return {
        status, retryAfter,
        transient: status === 408 || status === 429 || status >= 500 && status <= 599
            || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED', 'UPLOAD_NO_PROGRESS'].includes(code),
    };
}

async function retryRequest<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let firstError: { error: unknown } | undefined;
    for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try { return await operation(); }
        catch (error) {
            signal?.throwIfAborted();
            firstError ??= { error };
            const details = errorDetails(error);
            if (!details.transient || attempt + 1 >= MAX_ATTEMPTS) throw firstError.error;
            await delay(details.retryAfter ?? 1000 * 2 ** attempt, undefined, { signal });
        }
    }
}

function parseItem(value: unknown): DriveItem {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string'
        || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0
        || !isRecord(value.file) || value.deleted) throw new Error('OneDrive returned invalid file metadata');
    const hashes = isRecord(value.file.hashes) ? value.file.hashes : {};
    return {
        id: value.id, name: value.name, size: value.size,
        sha1: typeof hashes.sha1Hash === 'string' && /^[a-f\d]{40}$/i.test(hashes.sha1Hash) ? hashes.sha1Hash : undefined,
        quickXor: typeof hashes.quickXorHash === 'string' && /^[A-Za-z\d+/]{27}=$/.test(hashes.quickXorHash) ? hashes.quickXorHash : undefined,
    };
}

function nextRange(value: unknown, size: number): { offset: number; end: number } | undefined {
    if (!isRecord(value) || !Array.isArray(value.nextExpectedRanges)) throw new Error('OneDrive returned invalid upload session status');
    let next: { offset: number; end: number } | undefined;
    for (const range of value.nextExpectedRanges) {
        const match = typeof range === 'string' ? /^(\d+)-(\d*)$/.exec(range) : null;
        if (!match) throw new Error('OneDrive returned invalid missing byte range');
        const offset = Number(match[1]);
        const end = match[2] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || offset >= size
            || end < offset || end >= size || offset % (320 * 1024) !== 0) throw new Error('OneDrive returned out-of-bounds missing byte range');
        if (!next || offset < next.offset) next = { offset, end };
    }
    return next;
}

/** Reads local bytes only when an ambiguous response requires content verification. */
async function matchesLocalFile(item: DriveItem, input: UploadInput, size: number): Promise<boolean> {
    if (item.name !== input.fileName || item.size !== size || !item.sha1 && !item.quickXor) return false;
    const source = fs.createReadStream(input.tempPath);
    const sha1 = item.sha1 ? createHash('sha1') : undefined;
    const lanes = sha1 ? undefined : new Uint8Array(160);
    let phase = 0;
    try {
        for await (const chunk of source) {
            input.signal?.throwIfAborted();
            if (sha1) sha1.update(chunk);
            else if (lanes) {
                for (let lane = 0; lane < Math.min(160, chunk.length); lane++) {
                    let value = 0;
                    for (let index = lane; index < chunk.length; index += 160) value ^= chunk[index];
                    lanes[(phase + lane) % 160] ^= value;
                }
                phase = (phase + chunk.length) % 160;
            }
        }
    } finally { source.destroy(); }
    if (sha1) return sha1.digest('hex').toUpperCase() === item.sha1!.toUpperCase();
    const hash = Buffer.alloc(20);
    for (let lane = 0; lane < 160; lane++) {
        const bit = lane * 11 % 160;
        const index = bit >>> 3;
        const shift = bit & 7;
        hash[index] ^= lanes![lane] << shift;
        if (shift) hash[(index + 1) % 20] ^= lanes![lane] >>> (8 - shift);
    }
    let length = BigInt(size);
    for (let index = 12; index < 20; index++) { hash[index] ^= Number(length & 255n); length >>= 8n; }
    return hash.toString('base64') === item.quickXor;
}

/** Resume the same session after errors; never blindly create a renamed replacement. */
export async function uploadOneDriveFile(input: UploadInput): Promise<string> {
    const { size } = await fs.promises.stat(input.tempPath);
    const readTarget = async (): Promise<DriveItem | undefined> => {
        try {
            const response = await retryRequest(async () => axios.get<unknown>(input.resourceUrl, {
                headers: { Authorization: `Bearer ${await input.getAccessToken()}` },
                params: { $select: 'id,name,size,file,deleted' }, timeout: 30_000, signal: input.signal,
            }), input.signal);
            return parseItem(response.data);
        } catch (error) {
            if (errorDetails(error).status === 404) return undefined;
            throw error;
        }
    };
    if (await readTarget()) throw new Error('OneDrive upload target already exists; refusing to overwrite or rename');
    if (size < 4 * 1024 * 1024) {
        const bytes = await fs.promises.readFile(input.tempPath);
        let firstError: { error: unknown } | undefined;
        for (let attempt = 0; ; attempt++) {
            input.signal?.throwIfAborted();
            input.onProgress?.(0, size);
            let uploading = true;
            try {
                const response = await axios.put<unknown>(`${input.resourceUrl}:/content`, bytes, {
                    headers: { Authorization: `Bearer ${await input.getAccessToken()}`, 'Content-Type': input.mimeType || 'application/octet-stream', 'Content-Length': String(size) },
                    params: { '@microsoft.graph.conflictBehavior': 'fail' },
                    maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 60_000, signal: input.signal,
                    onUploadProgress: input.onProgress ? event => {
                        if (uploading) input.onProgress!(Math.min(size, Math.max(0, event.loaded)), size);
                    } : undefined,
                });
                const item = parseItem(response.data);
                if (item.name !== input.fileName || item.size !== size) throw new Error('OneDrive simple upload result does not match the local file');
                input.onProgress?.(size, size);
                return item.id;
            } catch (error) {
                uploading = false;
                input.signal?.throwIfAborted();
                firstError ??= { error };
                const details = errorDetails(error);
                if (details.transient || details.status === 409 || details.status === 412) {
                    await delay(details.retryAfter ?? 1000 * 2 ** attempt, undefined, { signal: input.signal });
                    try {
                        const item = await readTarget();
                        if (item) {
                            if (await matchesLocalFile(item, input, size)) {
                                input.onProgress?.(size, size);
                                return item.id;
                            }
                            throw firstError.error;
                        }
                    } catch { input.signal?.throwIfAborted(); throw firstError.error; }
                }
                if (!details.transient || attempt + 1 >= MAX_ATTEMPTS) throw firstError.error;
            } finally {
                uploading = false;
            }
        }
    }

    let uploadUrl: string | undefined;
    let restarts = 0;
    const createSession = async (): Promise<string> => {
        const response = await retryRequest(async () => axios.post<unknown>(`${input.resourceUrl}:/createUploadSession`, {
            item: { '@microsoft.graph.conflictBehavior': 'fail', name: input.fileName },
        }, { headers: { Authorization: `Bearer ${await input.getAccessToken()}` }, timeout: 30_000, signal: input.signal }), input.signal);
        if (!isRecord(response.data) || typeof response.data.uploadUrl !== 'string') throw new Error('OneDrive returned invalid upload session');
        const url = new URL(response.data.uploadUrl);
        if (url.protocol !== 'https:' && url.protocol !== new URL(input.resourceUrl).protocol) throw new Error('OneDrive returned an insecure upload session');
        return url.href;
    };
    const handle = await fs.promises.open(input.tempPath, 'r');
    const buffer = Buffer.allocUnsafe(FRAGMENT_BYTES);
    let range = { offset: 0, end: size - 1 };
    let firstError: { error: unknown } | undefined;
    let failures = 0;
    try {
        uploadUrl = await createSession();
        while (range.offset < size) {
            input.signal?.throwIfAborted();
            const length = Math.min(buffer.length, range.end - range.offset + 1, size - range.offset);
            if (range.offset + length < size && length % (320 * 1024) !== 0) throw new Error('OneDrive missing range cannot be uploaded in aligned fragments');
            let read = 0;
            while (read < length) {
                const result = await handle.read(buffer, read, length - read, range.offset + read);
                if (result.bytesRead === 0) throw new Error('OneDrive local upload file ended unexpectedly');
                read += result.bytesRead;
            }
            const fragmentOffset = range.offset;
            input.onProgress?.(fragmentOffset, size);
            let uploading = true;
            try {
                const response = await axios.put<unknown>(uploadUrl, buffer.subarray(0, length), {
                    headers: { 'Content-Length': String(length), 'Content-Range': `bytes ${range.offset}-${range.offset + length - 1}/${size}` },
                    maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120_000, signal: input.signal,
                    onUploadProgress: input.onProgress ? event => {
                        if (uploading) input.onProgress!(Math.min(size, fragmentOffset + Math.min(length, Math.max(0, event.loaded))), size);
                    } : undefined,
                });
                if (response.status === 200 || response.status === 201) {
                    const item = parseItem(response.data);
                    if (item.name !== input.fileName || item.size !== size) throw new Error('OneDrive upload result does not match the local file');
                    input.onProgress?.(size, size);
                    return item.id;
                }
                const next = nextRange(response.data, size);
                if (!next || next.offset <= range.offset) throw Object.assign(new Error('OneDrive upload made no confirmed progress'), { code: 'UPLOAD_NO_PROGRESS' });
                range = next;
                input.onProgress?.(range.offset, size);
                firstError = undefined;
                failures = 0;
            } catch (error) {
                uploading = false;
                input.signal?.throwIfAborted();
                firstError ??= { error };
                const originalError = firstError.error;
                const details = errorDetails(error);
                if (!details.transient && ![404, 410, 416].includes(details.status)) throw originalError;
                failures++;
                await delay(details.retryAfter ?? 1000 * 2 ** (failures - 1), undefined, { signal: input.signal });
                let sessionStatus: unknown;
                let expired = false;
                try {
                    const response = await retryRequest(() => axios.get<unknown>(uploadUrl!, { timeout: 30_000, signal: input.signal }), input.signal);
                    sessionStatus = response.data;
                } catch (statusError) {
                    input.signal?.throwIfAborted();
                    if (![404, 410].includes(errorDetails(statusError).status)) throw originalError;
                    expired = true;
                }
                if (expired) {
                    let item: DriveItem | undefined;
                    try { item = await readTarget(); }
                    catch { input.signal?.throwIfAborted(); throw originalError; }
                    if (item) {
                        if (await matchesLocalFile(item, input, size)) {
                            input.onProgress?.(size, size);
                            return item.id;
                        }
                        throw originalError;
                    }
                    if (restarts++ >= 1) throw originalError;
                    try { uploadUrl = await createSession(); }
                    catch { input.signal?.throwIfAborted(); throw originalError; }
                    range = { offset: 0, end: size - 1 };
                    failures = 0;
                    continue;
                }
                const next = nextRange(sessionStatus, size);
                if (!next) {
                    let item: DriveItem | undefined;
                    try { item = await readTarget(); }
                    catch { input.signal?.throwIfAborted(); throw originalError; }
                    if (item && await matchesLocalFile(item, input, size)) {
                        input.onProgress?.(size, size);
                        return item.id;
                    }
                    throw originalError;
                }
                const progressed = next.offset > range.offset;
                if (next.offset < range.offset || failures >= MAX_ATTEMPTS && !progressed) throw originalError;
                range = next;
                if (progressed) { failures = 0; firstError = undefined; }
            } finally {
                uploading = false;
            }
        }
        throw new Error('OneDrive upload completion was not confirmed');
    } catch (error) {
        if (uploadUrl) {
            try { await axios.delete(uploadUrl, { timeout: 10_000 }); } catch { /* Expired sessions clean themselves up. */ }
        }
        input.signal?.throwIfAborted();
        throw error;
    } finally { await handle.close(); }
}
