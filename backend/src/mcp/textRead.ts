import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { requireTargetFile } from '../services/scopedFiles.js';
import { isPathInside } from '../utils/localPath.js';
import { McpError, type McpContext } from './contracts.js';
import { firstHeader, type CloudMediaResponseInput } from '../services/cloudMediaResponse.js';

const textExtensions = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.py', '.sh', '.toml', '.ini', '.sql']);
const textMime = /^(text\/|application\/(json|x-ndjson|jsonl|xml|javascript|yaml|x-yaml)(?:;|$))/i;
type Source = Readable & Pick<CloudMediaResponseInput, 'upstreamStatus' | 'upstreamHeaders'>;
interface TextReadInput { fileId: string; offset: number; maxBytes: number; expectedVersion?: string }

function unsatisfiedRange(error: unknown): { totalBytes?: number } | undefined {
    type Failure = { cause?: unknown; status?: number;
        response?: { status?: number; headers?: CloudMediaResponseInput['upstreamHeaders']; data?: unknown; body?: unknown };
        $metadata?: { httpStatusCode?: number };
        $response?: { statusCode?: number; headers?: CloudMediaResponseInput['upstreamHeaders']; body?: unknown } };
    let received416 = false;
    for (let current = error; current && typeof current === 'object'; current = (current as Failure).cause) {
        const failure = current as Failure;
        const status = failure.response?.status ?? failure.$metadata?.httpStatusCode ?? failure.$response?.statusCode ?? failure.status;
        if (status !== 416) continue;
        received416 = true;
        const response = failure.response ?? failure.$response;
        const body = failure.response?.data ?? response?.body;
        if (body && typeof body === 'object' && typeof (body as Readable).destroy === 'function') (body as Readable).destroy();
        const range = firstHeader(response?.headers, 'content-range');
        if (!range) continue;
        const match = /^bytes \*\/(\d+)$/.exec(range);
        const totalBytes = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
            throw new McpError('INVALID_RANGE_RESPONSE', 'Storage returned an invalid file length for an unsatisfied range.');
        }
        return { totalBytes };
    }
    return received416 ? {} : undefined;
}

function versionOf(file: Record<string, any>, sourceVersion: string): string {
    return createHash('sha256').update(JSON.stringify([file.id, file.size, file.updated_at, sourceVersion])).digest('hex');
}

function checkVersion(actual: string, expected?: string): void {
    if (expected !== undefined && actual !== expected) throw new McpError('FILE_CHANGED', 'The file changed between pages. Restart at offset 0 without expectedVersion.');
}

async function readCloudWindow(context: McpContext, file: Record<string, any>, input: TextReadInput) {
    let source: Source | undefined;
    let expired = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            expired = true;
            const error = new McpError('READ_TIMEOUT', 'Text reading timed out. Retry this page.');
            reject(error);
            controller.abort(error);
            source?.destroy();
        }, 15_000);
        timer.unref();
    });
    const probe = async (range?: string) => {
        source = await context.target.provider.getFileStream(file.path, { range, signal: controller.signal }) as Source;
        if (expired) { source.destroy(); throw new McpError('READ_TIMEOUT', 'Text reading timed out. Retry this page.'); }
        try {
            const status = source.upstreamStatus;
            const headers = source.upstreamHeaders;
            let length = 0;
            for await (const chunk of source) {
                length = Math.min(2, length + Buffer.byteLength(chunk));
                if (length === 2) break;
            }
            return { status, headers, length };
        } finally { source.destroy(); }
    };
    const readEnd = async (failure: { totalBytes?: number }) => {
        let result: Awaited<ReturnType<typeof probe>>;
        let totalBytes: number;
        let verifyEmpty = failure.totalBytes === 0;
        if (verifyEmpty) {
            result = await probe();
        } else {
            try {
                result = await probe('bytes=0-0');
            } catch (error) {
                const firstByteFailure = unsatisfiedRange(error);
                if (!firstByteFailure) throw error;
                if (firstByteFailure.totalBytes !== undefined && firstByteFailure.totalBytes !== 0) {
                    throw new McpError('INVALID_RANGE_RESPONSE', 'Storage rejected the first byte of a nonempty file.');
                }
                verifyEmpty = true;
                result = await probe();
            }
        }
        const header = (name: string) => firstHeader(result.headers, name) ?? '';
        if (verifyEmpty || ((result.status === 200 || result.status === undefined) && result.length === 0)) {
            if ((result.status !== undefined && result.status !== 200) || result.length !== 0
                || (header('content-length') !== '' && !/^0+$/.test(header('content-length')))) {
                throw new McpError('INVALID_RANGE_RESPONSE', 'Storage did not confirm an empty file; EOF was not returned.');
            }
            totalBytes = 0;
        } else {
            const range = /^bytes 0-0\/(\d+)$/.exec(header('content-range'));
            totalBytes = range ? Number(range[1]) : NaN;
            if (result.status !== 206 || result.length !== 1 || !Number.isSafeInteger(totalBytes) || totalBytes <= 0
                || (header('content-length') !== '' && !/^0*1$/.test(header('content-length')))) {
                throw new McpError('INVALID_RANGE_RESPONSE', 'Storage did not provide a valid first-byte range to confirm the file length.');
            }
        }
        if (failure.totalBytes !== undefined && failure.totalBytes !== totalBytes) {
            throw new McpError('FILE_CHANGED', 'The file length changed while confirming its end. Restart at offset 0.');
        }
        const validator = header('etag') || header('last-modified');
        const version = versionOf(file, validator);
        checkVersion(version, input.expectedVersion);
        if (input.offset > totalBytes) throw new McpError('OFFSET_OUT_OF_RANGE', 'Offset is beyond the end of the file.', { offset: input.offset, totalBytes });
        if (input.offset < totalBytes) throw new McpError('INVALID_RANGE_RESPONSE', 'Storage rejected a range that starts before the end of the file.');
        return { bytes: Buffer.alloc(0), version, totalBytes, rangeSupported: true,
            versionSource: validator ? 'index-and-provider-validator' : 'index-metadata' };
    };
    const read = async () => {
        try {
            source = await context.target.provider.getFileStream(file.path, { range: `bytes=${input.offset}-${input.offset + input.maxBytes + 3}`, signal: controller.signal }) as Source;
        } catch (error) {
            const failure = unsatisfiedRange(error);
            if (!failure) throw error;
            return readEnd(failure);
        }
        if (expired) { source.destroy(); throw new McpError('READ_TIMEOUT', 'Text reading timed out. Retry this page.'); }
        try {
            const headers = source.upstreamHeaders;
            const header = (name: string) => firstHeader(headers, name) ?? '';
            let rangeLength: number | undefined;
            let totalBytes: number | undefined;
            if (source.upstreamStatus === 206) {
                const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header('content-range'));
                if (!range || Number(range[1]) !== input.offset || Number(range[2]) < input.offset
                    || Number(range[2]) > input.offset + input.maxBytes + 3
                    || (range[3] !== '*' && Number(range[3]) <= Number(range[2]))) {
                    throw new McpError('INVALID_RANGE_RESPONSE', 'Storage returned a different byte range; no text was returned.');
                }
                rangeLength = Number(range[2]) - input.offset + 1;
                if (range[3] === '*') throw new McpError('RANGE_UNSUPPORTED', 'Storage did not provide a total byte length for text pagination. Use files_link to download this file.');
                totalBytes = Number(range[3]);
            } else if (input.offset !== 0) {
                throw new McpError('RANGE_UNSUPPORTED', 'This storage does not support paged text reads. Read offset 0 or use files_link to download the file.');
            } else if (source.upstreamStatus !== undefined && source.upstreamStatus !== 200) {
                throw new McpError('READ_FAILED', 'Storage could not provide the requested text.');
            }
            const validator = header('etag') || header('last-modified');
            const version = versionOf(file, validator);
            checkVersion(version, input.expectedVersion);
            const chunks: Buffer[] = [];
            const limit = input.maxBytes + 4;
            let length = 0;
            for await (const chunk of source) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                const slice = buffer.subarray(0, limit - length);
                chunks.push(slice); length += slice.length;
                if (length === limit) break;
            }
            if (rangeLength !== undefined && length !== rangeLength) throw new McpError('INVALID_RANGE_RESPONSE', 'Storage returned an incomplete or inconsistent byte range. Retry this page.');
            return { bytes: Buffer.concat(chunks, length), version, totalBytes, rangeSupported: source.upstreamStatus === 206,
                versionSource: validator ? 'index-and-provider-validator' : 'index-metadata' };
        } finally { source.destroy(); }
    };
    try { return await Promise.race([read(), timeout]); }
    finally { clearTimeout(timer!); controller.abort(); }
}

export async function readTextFile(context: McpContext, input: TextReadInput): Promise<Record<string, unknown>> {
    const file = await requireTargetFile(context.target, input.fileId);
    if (file.name === '.folder' || file.mime_type === 'application/x-directory') throw new McpError('NOT_A_FILE', 'Use folder tools for directory records.');
    if (!textExtensions.has(path.extname(file.name).toLowerCase()) && !textMime.test(file.mime_type || '')) {
        throw new McpError('UNSUPPORTED_TEXT_TYPE', 'Native text reading supports text files such as TXT, Markdown, JSON and CSV. Use files_link for binary documents.');
    }
    let bytes: Buffer;
    let version: string;
    let rangeSupported = true;
    let totalBytes: number | undefined;
    let versionSource = 'index-and-local-stat';
    if (file.source === 'local') {
        const root = await fs.realpath(process.env.UPLOAD_DIR || './data/uploads');
        const candidate = path.resolve(file.path || path.join(root, file.stored_name));
        if (!isPathInside(root, candidate)) throw new McpError('MEDIA_UNAVAILABLE', 'File is outside the managed storage directory.');
        const real = await fs.realpath(candidate);
        if (!isPathInside(root, real)) throw new McpError('MEDIA_UNAVAILABLE', 'File is outside the managed storage directory.');
        const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = await handle.stat();
            totalBytes = stat.size;
            if (!stat.isFile()) throw new McpError('NOT_A_FILE', 'The indexed object is not a regular file.');
            version = versionOf(file, `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
            checkVersion(version, input.expectedVersion);
            if (input.offset > totalBytes) throw new McpError('OFFSET_OUT_OF_RANGE', 'Offset is beyond the end of the file.', { offset: input.offset, totalBytes });
            const buffer = Buffer.alloc(input.maxBytes + 4);
            let length = 0;
            while (length < buffer.length) {
                const result = await handle.read(buffer, length, buffer.length - length, input.offset + length);
                if (result.bytesRead === 0) break;
                length += result.bytesRead;
            }
            bytes = buffer.subarray(0, length);
            const after = await handle.stat();
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new McpError('FILE_CHANGED', 'The file changed during reading. Retry from offset 0.');
        } finally { await handle.close(); }
    } else {
        ({ bytes, version, totalBytes, rangeSupported, versionSource } = await readCloudWindow(context, file, input));
    }
    if (input.offset === 0 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
        throw new McpError('UNSUPPORTED_ENCODING', 'This file uses UTF-16. Native text reading currently supports UTF-8 only.');
    }
    if (bytes.length && (bytes[0] & 0xc0) === 0x80) throw new McpError('INVALID_OFFSET', 'Offset is inside a UTF-8 character. Use nextOffset from the preceding page.');
    let end = Math.min(input.maxBytes, bytes.length);
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === bytes.length && end > 0 && totalBytes !== undefined && input.offset + end < totalBytes) {
        let start = end - 1;
        while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
        const lead = bytes[start];
        const width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
        if (end - start < width) {
            end = start;
            if (end === 0) throw new McpError('INVALID_RANGE_RESPONSE', 'Storage returned less than one complete UTF-8 character. Retry this page.');
        }
    }
    if (end === 0 && bytes.length) throw new McpError('UNSUPPORTED_ENCODING', 'File content is not valid UTF-8.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: input.offset !== 0 }).decode(bytes.subarray(0, end)); }
    catch { throw new McpError('UNSUPPORTED_ENCODING', 'File content is not valid UTF-8. Use files_link to download it.'); }
    if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new McpError('BINARY_CONTENT', 'The file contains binary control bytes; no text was returned.');
    const truncated = bytes.length > end || (totalBytes !== undefined && input.offset + end < totalBytes);
    return { fileId: file.id, name: file.name, text, encoding: 'utf-8', offset: input.offset,
        bytesConsumed: end, truncated, nextOffset: truncated && rangeSupported ? input.offset + end : null,
        rangeSupported, version, versionSource,
        pageSha256: createHash('sha256').update(bytes.subarray(0, end)).digest('hex') };
}
