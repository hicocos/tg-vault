import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import * as z from 'zod';
import { pool, query } from '../db/index.js';
import { McpError, type McpContext, type McpTool } from './contracts.js';
import { authenticateMcpToken, getMcpPrincipal, hashMcpSecret, mcpEndpoint, resolveMcpTarget } from './security.js';
import { normalizeFileName, publicFile } from '../services/scopedFiles.js';
import { uploadIndexedFile } from '../services/indexedUpload.js';
import { normalizeFolderPath } from '../utils/folderPath.js';
import { buildUploadCapabilities, SIMPLE_UPLOAD_MAX_BYTES } from '../utils/uploadCapabilities.js';
import { lockStorageTargetForUse } from '../services/storageAccountLifecycle.js';
import { recordMcpAudit, safeMcpError } from './operations.js';
import { transferLockPool } from './lockPool.js';
import { isPhysicalFileNotFound } from '../services/fileDeletion.js';
import { getReservedUploadBytes } from '../services/chunkUploadSessions.js';
import { taskActionAvailability, type TaskActionBlocks } from './taskActions.js';

const UPLOAD_DIRECTORY = path.resolve(process.env.CHUNK_DIR || './data/chunks', 'mcp');
const uploadIdSchema = z.string().uuid();
const MCP_WRITE_MAX_BYTES = 1024 * 1024;
const CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const RECOMMENDED_CHUNK_BYTES = 4 * 1024 * 1024;
const TICKET_TTL_MS = 15 * 60_000;
const activeWorkers = new Set<string>();
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

function uploadPath(id: string) { return path.join(UPLOAD_DIRECTORY, `${id}.upload`); }

async function withUploadLock<T>(id: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await transferLockPool.connect();
    let locked = false;
    try {
        locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`mcp-upload:${id}`])).rows[0].locked;
        if (!locked) throw new McpError('UPLOAD_BUSY', 'An upload operation is already running.');
        return await operation(client);
    } finally {
        try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`mcp-upload:${id}`]); }
        finally { client.release(); }
    }
}

function ticketDeadline(ctx: McpContext, expiresAt: Date | string) {
    return new Date(Math.min(Date.now() + TICKET_TTL_MS, new Date(expiresAt).getTime(), Date.parse(ctx.client.expiresAt)));
}

function receipt(row: Record<string, any>) {
    return { uploadId: row.id, status: row.status, sizeBytes: Number(row.size), receivedBytes: Number(row.received_bytes),
        nextOffset: row.status === 'receiving' ? 0 : Number(row.received_bytes), sha256: row.content_sha256 ?? null,
        chunkMaxBytes: CHUNK_MAX_BYTES, recommendedChunkBytes: RECOMMENDED_CHUNK_BYTES };
}

async function fileSha256(id: string, start?: number, end?: number): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(uploadPath(id), { start, end })) hash.update(chunk);
    return hash.digest('hex');
}

async function syncUploadFile(id: string) {
    const handle = await fs.promises.open(uploadPath(id), 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const directory = await fs.promises.open(UPLOAD_DIRECTORY, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
}

function assertFileHash(row: Record<string, any>, actual: string) {
    if (row.expected_sha256 && row.expected_sha256 !== actual) throw new McpError('FILE_HASH_MISMATCH', 'Uploaded bytes do not match the declared SHA-256. Resend the complete file or prepare a new session.', { uploadId: row.id });
}

async function recoverInterruptedReceive(client: PoolClient, row: Record<string, any>) {
    if (row.status === 'receiving') {
        await fs.promises.rm(uploadPath(row.id), { force: true });
        return (await client.query("UPDATE mcp_uploads SET status='open',received_bytes=0,content_sha256=NULL,error_code='UPLOAD_BODY_INCOMPLETE',updated_at=NOW() WHERE id=$1 RETURNING *", [row.id])).rows[0];
    }
    if (row.status !== 'receiving_chunk') return row;
    const confirmed = Number(row.received_bytes);
    const source = await fs.promises.stat(uploadPath(row.id)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if ((!source && confirmed > 0) || (source && source.size < confirmed)) {
        return (await client.query("UPDATE mcp_uploads SET status='failed',error_code='SOURCE_REQUIRED',updated_at=NOW() WHERE id=$1 RETURNING *", [row.id])).rows[0];
    }
    if (!source) await fs.promises.writeFile(uploadPath(row.id), Buffer.alloc(0), { mode: 0o600 });
    await fs.promises.truncate(uploadPath(row.id), confirmed);
    await syncUploadFile(row.id);
    const complete = confirmed === Number(row.size);
    const sha256 = complete ? await fileSha256(row.id) : null;
    if (sha256) assertFileHash(row, sha256);
    return (await client.query("UPDATE mcp_uploads SET status=$2,content_sha256=$3,error_code=NULL,updated_at=NOW() WHERE id=$1 RETURNING *", [row.id, complete ? 'ready' : 'open', sha256])).rows[0];
}

async function committedUploadFile(client: Pick<PoolClient,'query'>, id: string) {
    const result=await client.query(`SELECT f.* FROM files f JOIN mcp_uploads u ON u.id=f.id
        LEFT JOIN storage_accounts a ON a.id=f.storage_account_id
        WHERE u.id=$1 AND f.size=u.size AND f.stored_name=u.stored_name
        AND (u.stored_path IS NULL OR f.path=u.stored_path)
        AND ((u.storage_id='local' AND f.source='local' AND f.storage_account_id IS NULL)
             OR (f.storage_account_id::text=u.storage_id AND f.source=a.type))`,[id]);
    return result.rows[0]??null;
}

async function completeIndexedUpload(client: Pick<PoolClient,'query'>, id: string) {
    const file=await committedUploadFile(client,id);
    if(!file) return null;
    const result=await client.query(`UPDATE mcp_uploads SET status='completed',result=$2::jsonb,
        transferred_bytes=size,error_code=NULL,updated_at=NOW()
        WHERE id=$1 AND status IN ('running','reconciliation_required','completed') RETURNING *`,
    [id,JSON.stringify({success:true,file:publicFile(file)})]);
    return result.rows[0]??null;
}

function taskView(row: Record<string, any>) {
    return { id: row.id, sourceType: 'mcp_upload', kind: 'mcp_upload', status: row.status, title: row.filename,
        stage: ['receiving', 'receiving_chunk'].includes(row.status) ? 'receiving_bytes' : row.status === 'running' ? 'writing_storage' : row.status,
        progress: row.status === 'completed' ? 100 : Number(row.size) > 0
            ? Math.floor(Number(row.status === 'running' ? row.transferred_bytes : row.received_bytes) / Number(row.size) * 100) : 0,
        totalBytes: String(row.size), receivedBytes: String(row.received_bytes), nextOffset: row.status === 'receiving' ? 0 : Number(row.received_bytes), sha256: row.content_sha256 ?? null, storageAccountId: row.storage_id,
        transferredBytes: String(row.transferred_bytes),
        result: row.result, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at };
}

async function findUpload(ctx: McpContext, id: string) {
    const parsed = uploadIdSchema.safeParse(id);
    if (!parsed.success) throw new McpError('INVALID_ARGUMENT', 'Upload ID must be a UUID.');
    const result = await query('SELECT * FROM mcp_uploads WHERE id=$1 AND client_id=$2 AND storage_id=$3', [id, ctx.client.id, ctx.storageId]);
    if (!result.rows[0]) throw new McpError('UPLOAD_NOT_FOUND', 'Upload not found for this client and storage account.');
    return result.rows[0];
}

async function uploadActions(ctx: McpContext, row: Record<string, any>) {
    const blocks: TaskActionBlocks = {};
    if (!['open', 'ready', 'queued', 'paused', 'failed'].includes(row.status)) blocks.cancel = 'INVALID_STATE';
    if (!['ready', 'queued'].includes(row.status)) blocks.pause = 'INVALID_STATE';
    if (row.status !== 'paused') blocks.resume = 'TASK_NOT_PAUSED';
    if (row.status !== 'failed') blocks.retry = 'TASK_NOT_FAILED';
    if (row.stored_name !== null && !['completed', 'cancelled'].includes(row.status)) {
        blocks.cancel = blocks.resume = blocks.retry = 'RECONCILIATION_REQUIRED';
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
        blocks.pause = blocks.resume = blocks.retry = 'UPLOAD_EXPIRED';
    }
    if (!ctx.client.permissions.includes('files:upload')) blocks.resume = blocks.retry = 'FORBIDDEN';
    if (!blocks.resume || !blocks.retry) {
        const source = await fs.promises.stat(uploadPath(row.id)).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (!source || source.size !== Number(row.size)) blocks.resume = blocks.retry = 'SOURCE_REQUIRED';
    }
    return taskActionAvailability(ctx, blocks);
}

export async function getMcpUpload(ctx: McpContext, id: string) {
    const row = await findUpload(ctx, id);
    return { ...taskView(row), ...await uploadActions(ctx, row) };
}

export async function listMcpUploads(ctx: McpContext, input: { limit: number; offset: number }) {
    const result = await query('SELECT * FROM mcp_uploads WHERE client_id=$1 AND storage_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4',
        [ctx.client.id, ctx.storageId, input.limit + 1, input.offset]);
    return { tasks: await Promise.all(result.rows.slice(0, input.limit).map(async row => ({ ...taskView(row), ...await uploadActions(ctx, row) }))),
        nextOffset: result.rows.length > input.limit ? input.offset + input.limit : null };
}

async function prepareUpload(ctx: McpContext, input: { filename: string; mimeType: string; sizeBytes: number; folder?: string | null; sha256?: string }) {
    const filename = normalizeFileName(input.filename);
    const folder = input.folder ? normalizeFolderPath(input.folder) : null;
    await fs.promises.mkdir(UPLOAD_DIRECTORY, { recursive: true });
    const disk = await fs.promises.statfs(UPLOAD_DIRECTORY);
    const diskFreeBytes = disk.bavail * disk.bsize;
    const diskReserveBytes = Math.max(1024 ** 3, (parseInt(process.env.CHUNK_DISK_RESERVE_GB || '8', 10) || 8) * 1024 ** 3);
    const client = await pool.connect();
    const id = randomUUID();
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.min(Date.now() + Math.min(buildUploadCapabilities().sessionTtlMs, 24 * 60 * 60 * 1000), Date.parse(ctx.client.expiresAt)));
    const ticketExpiresAt = ticketDeadline(ctx, expiresAt);
    try {
        await client.query('BEGIN');
        await lockStorageTargetForUse(client, ctx.target.provider.name, ctx.target.accountId);
        await client.query("SELECT pg_advisory_xact_lock(hashtext('chunk_upload_global_budget'))");
        const usage = await client.query(`SELECT
            COUNT(*) FILTER (WHERE client_id=$1 AND created_at > NOW()-INTERVAL '15 minutes')::int AS recent,
            COUNT(*) FILTER (WHERE client_id=$1 AND status IN ('open','receiving','receiving_chunk','ready','queued','running','paused') AND expires_at>NOW())::int AS active
            FROM mcp_uploads`, [ctx.client.id]);
        if (usage.rows[0].recent >= 60) throw new McpError('RATE_LIMITED', 'At most 60 uploads may be prepared per 15 minutes.');
        if (usage.rows[0].active >= 4) throw new McpError('UPLOAD_CONCURRENCY_LIMIT', 'Finish or cancel an active upload before preparing another (limit 4).');
        const reservedBytes = await getReservedUploadBytes(client);
        if (reservedBytes + input.sizeBytes > buildUploadCapabilities().globalSessionBudgetBytes) {
            throw new McpError('UPLOAD_BUDGET_EXCEEDED', 'The temporary upload byte budget is exhausted.');
        }
        if (reservedBytes + input.sizeBytes + diskReserveBytes > diskFreeBytes) {
            throw new McpError('UPLOAD_BUDGET_EXCEEDED', 'The temporary upload volume has insufficient free space after its disk reserve.');
        }
        await client.query(`INSERT INTO mcp_uploads (id,client_id,storage_id,filename,mime_type,size,folder,token_hash,status,expires_at,request_id,ticket_expires_at,expected_sha256)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12)`, [id,ctx.client.id,ctx.storageId,filename,input.mimeType,input.sizeBytes,folder,hashMcpSecret(ticket),expiresAt,ctx.requestId,ticketExpiresAt,input.sha256 ?? null]);
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return preparedUploadView({ id, size: input.sizeBytes, expires_at: expiresAt, ticket_expires_at: ticketExpiresAt }, ticket);
}

function preparedUploadView(row: { id: string; size: number | string; expires_at: Date | string; ticket_expires_at: Date | string }, ticket: string) {
    return { uploadId: row.id, jobId: row.id, uploadUrl: `${mcpEndpoint()}/uploads/${row.id}`, method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-MCP-Upload-Ticket': ticket },
        authorization: 'Send the same MCP Bearer token in the Authorization header.',
        ticketUpload: { url: `${mcpEndpoint()}/uploads/${row.id}/content`, method: 'PUT',
            statusUrl: `${mcpEndpoint()}/uploads/${row.id}/content`, headers: { 'Content-Type': 'application/octet-stream', 'X-MCP-Upload-Ticket': ticket },
            ticketExpiresAt: new Date(row.ticket_expires_at).toISOString(), chunkMaxBytes: CHUNK_MAX_BYTES, recommendedChunkBytes: RECOMMENDED_CHUNK_BYTES,
            authorization: 'This short-lived single-file ticket is sufficient; do not forward a long-lived Bearer token.' },
        mcpWriteTool: 'upload_write', mcpWriteMaxBytes: MCP_WRITE_MAX_BYTES,
        sizeBytes: Number(row.size), maxBytes: SIMPLE_UPLOAD_MAX_BYTES, expiresAt: new Date(row.expires_at).toISOString(),
        nextStep: 'For files up to mcpWriteMaxBytes, call upload_write through MCP without handling a Bearer token. Otherwise use ticketUpload to send raw bytes or sequential Content-Range chunks with X-Content-SHA256; GET its statusUrl for nextOffset, and renew using upload_ticket when needed. Then call upload_commit with this uploadId and a new requestId.' };
}

function assertUploadReceivable(row: Record<string, any>) {
    if (row.status === 'cancelled') throw new McpError('UPLOAD_CANCELLED', 'This upload was cancelled. Prepare a new upload session.', { uploadId: row.id, status: row.status });
    if (row.status === 'reconciliation_required') throw new McpError('RECONCILIATION_REQUIRED', 'The storage write must be reconciled before this upload can continue.', { uploadId: row.id, status: row.status });
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new McpError('UPLOAD_EXPIRED', 'Prepare a new upload session.');
}

async function receiveUploadBytes(client: PoolClient, ctx: McpContext, row: Record<string, any>, source: Readable) {
    assertUploadReceivable(row);
    const claim = await client.query("UPDATE mcp_uploads SET status='receiving',received_bytes=0,content_sha256=NULL,updated_at=NOW() WHERE id=$1 AND status IN ('open','ready') RETURNING id", [row.id]);
    if (!claim.rowCount) throw new McpError('INVALID_STATE', 'Upload bytes can only be sent before commit.');
    let persistingReady = false;
    try {
        await fs.promises.mkdir(UPLOAD_DIRECTORY, { recursive: true });
        let received = 0;
        let lastProgressAt = 0;
        const hash = createHash('sha256');
        const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > Number(row.size) || received > SIMPLE_UPLOAD_MAX_BYTES) return callback(new McpError('SIZE_MISMATCH', 'Body exceeds the declared file size.'));
            hash.update(chunk);
            if (Date.now() - lastProgressAt >= 500) {
                lastProgressAt = Date.now();
                void client.query("UPDATE mcp_uploads SET received_bytes=$2,updated_at=NOW() WHERE id=$1 AND status='receiving'", [row.id, received])
                    .then(() => callback(null, chunk), error => callback(error));
                return;
            }
            callback(null, chunk);
        } });
        await pipeline(source, limiter, fs.createWriteStream(uploadPath(row.id), { flags: 'w', mode: 0o600 }));
        if (received !== Number(row.size)) throw new McpError('SIZE_MISMATCH', 'Body does not match the declared file size.');
        const sha256 = hash.digest('hex');
        assertFileHash(row, sha256);
        await syncUploadFile(row.id);
        await resolveMcpTarget(ctx.client, ctx.storageId, 'files:upload');
        persistingReady = true;
        const ready = (await client.query("UPDATE mcp_uploads SET status='ready',received_bytes=$2,content_sha256=$3,error_code=NULL,updated_at=NOW() WHERE id=$1 RETURNING *", [row.id, received, sha256])).rows[0];
        return receipt(ready);
    } catch (error) {
        if (!persistingReady) {
            await fs.promises.rm(uploadPath(row.id), { force: true });
            await client.query("UPDATE mcp_uploads SET status='open',received_bytes=0,content_sha256=NULL,error_code=$2,updated_at=NOW() WHERE id=$1 AND status='receiving'", [row.id, error instanceof McpError ? error.code : 'UPLOAD_BODY_INCOMPLETE']);
        }
        throw error;
    }
}

async function writeUpload(ctx: McpContext, input: { uploadId: string; content: string; encoding: 'utf8' | 'base64' }) {
    if (input.encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)
        || Buffer.from(input.content, 'base64').toString('base64') !== input.content)) {
        throw new McpError('INVALID_ARGUMENT', 'Provide canonical padded base64 without whitespace.');
    }
    const bytes = Buffer.from(input.content, input.encoding);
    if (input.encoding === 'utf8' && bytes.toString('utf8') !== input.content) throw new McpError('INVALID_ARGUMENT', 'Text must contain valid Unicode characters.');
    if (bytes.length > MCP_WRITE_MAX_BYTES) throw new McpError('INVALID_ARGUMENT', 'upload_write accepts at most 1048576 decoded bytes. Use the ticket upload channel for larger files.');
    const client = await transferLockPool.connect();
    let locked = false;
    try {
        const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`mcp-upload:${input.uploadId}`]);
        if (!lock.rows[0].locked) throw new McpError('UPLOAD_BUSY', 'An upload operation is already running.');
        locked = true;
        const row = await recoverInterruptedReceive(client, await findUpload(ctx, input.uploadId));
        assertUploadReceivable(row);
        if (bytes.length !== Number(row.size)) throw new McpError('SIZE_MISMATCH', 'Content bytes must equal the size declared by upload_prepare.');
        if (row.status === 'ready') return replayUploadBytes(ctx, row, Readable.from([bytes]), Number(row.size), row.content_sha256 || await fileSha256(row.id));
        return await receiveUploadBytes(client, ctx, row, Readable.from([bytes]));
    } finally {
        try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`mcp-upload:${input.uploadId}`]); }
        finally { client.release(); }
    }
}

async function replayUploadBytes(ctx: McpContext, row: Record<string, any>, source: Readable, length: number, expectedHash: string) {
    let received = 0;
    const hash = createHash('sha256');
    for await (const chunk of source) {
        received += chunk.length;
        if (received > length) throw new McpError('SIZE_MISMATCH', 'Body exceeds the declared byte range.');
        hash.update(chunk);
    }
    if (received !== length) throw new McpError('SIZE_MISMATCH', 'Body does not match the declared byte range.');
    if (hash.digest('hex') !== expectedHash) throw new McpError('UPLOAD_OFFSET_CONFLICT', 'Already confirmed bytes differ from this request. Query the confirmed nextOffset before continuing.', { nextOffset: Number(row.received_bytes) });
    await resolveMcpTarget(ctx.client, ctx.storageId, 'files:upload');
    return { ...receipt(row), replayed: true };
}

async function ticketContext(client: Pick<PoolClient, 'query'>, id: string, ticket: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new McpError('UNAUTHORIZED', 'A valid single-file upload ticket is required.');
    const row = (await client.query('SELECT * FROM mcp_uploads WHERE id=$1', [id])).rows[0];
    if (!row || !row.ticket_expires_at || !timingSafeEqual(Buffer.from(hashMcpSecret(ticket), 'hex'), Buffer.from(row.token_hash, 'hex'))) {
        throw new McpError('UNAUTHORIZED', 'The upload ticket is invalid or has been replaced.');
    }
    if (new Date(row.ticket_expires_at).getTime() <= Date.now()) throw new McpError('UPLOAD_TICKET_EXPIRED', 'Renew this session with upload_ticket and continue from its confirmed nextOffset.');
    const ctx = await resolveMcpTarget(await getMcpPrincipal(row.client_id), row.storage_id, 'files:upload');
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new McpError('UPLOAD_EXPIRED', 'Prepare a new upload session.');
    return { ctx, row };
}

function requestTicket(req: Request) {
    return typeof req.headers['x-mcp-upload-ticket'] === 'string' ? req.headers['x-mcp-upload-ticket'] : '';
}

function requestRange(req: Request, size: number) {
    if (req.headers['content-encoding']) throw new McpError('INVALID_ARGUMENT', 'Encoded request bodies are not accepted.');
    const raw = req.headers['content-range'];
    if (raw === undefined) {
        if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== size) throw new McpError('SIZE_MISMATCH', 'Content-Length must equal the declared file size.');
        return null;
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(raw));
    if (!match) throw new McpError('INVALID_ARGUMENT', 'Use Content-Range: bytes start-end/total.');
    const [start, end, total] = match.slice(1).map(Number);
    if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total || total !== size) throw new McpError('INVALID_ARGUMENT', 'The byte range must fit the declared file size.');
    const length = end - start + 1;
    if (length > CHUNK_MAX_BYTES) throw new McpError('CHUNK_TOO_LARGE', 'A chunk may contain at most 8388608 bytes.');
    if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== length) throw new McpError('SIZE_MISMATCH', 'Content-Length must equal the declared byte range.');
    const sha256 = req.headers['x-content-sha256'];
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new McpError('INVALID_ARGUMENT', 'Each chunk requires its lowercase SHA-256 in X-Content-SHA256.');
    return { start, end, length, sha256 };
}

async function receiveChunk(client: PoolClient, ctx: McpContext, row: Record<string, any>, source: Readable, range: { start: number; end: number; length: number; sha256: string }) {
    const confirmed = Number(row.received_bytes);
    if (!['open', 'ready'].includes(row.status)) throw new McpError('INVALID_STATE', 'Bytes can only be received before the upload is submitted.');
    if (range.end < confirmed) {
        const existingHash = await fileSha256(row.id, range.start, range.end);
        if (existingHash !== range.sha256) throw new McpError('UPLOAD_OFFSET_CONFLICT', 'This chunk conflicts with already confirmed bytes.', { nextOffset: confirmed });
        return replayUploadBytes(ctx, row, source, range.length, existingHash);
    }
    if (row.status === 'ready' || range.start !== confirmed) throw new McpError('UPLOAD_OFFSET_CONFLICT', 'Send the next chunk at the confirmed nextOffset.', { nextOffset: confirmed });
    await fs.promises.mkdir(UPLOAD_DIRECTORY, { recursive: true });
    const existing = await fs.promises.stat(uploadPath(row.id)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if ((!existing && confirmed > 0) || (existing && existing.size < confirmed)) throw new McpError('SOURCE_REQUIRED', 'Previously confirmed upload bytes are missing. Prepare a new upload session.');
    if (!existing) await fs.promises.writeFile(uploadPath(row.id), Buffer.alloc(0), { mode: 0o600 });
    await fs.promises.truncate(uploadPath(row.id), confirmed);
    await client.query("UPDATE mcp_uploads SET status='receiving_chunk',content_sha256=NULL,updated_at=NOW() WHERE id=$1", [row.id]);
    let persistingOffset = false;
    try {
        let received = 0;
        const hash = createHash('sha256');
        const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > range.length) return callback(new McpError('SIZE_MISMATCH', 'Body exceeds the declared byte range.'));
            hash.update(chunk);
            callback(null, chunk);
        } });
        await pipeline(source, limiter, fs.createWriteStream(uploadPath(row.id), { flags: 'r+', start: confirmed }));
        if (received !== range.length) throw new McpError('SIZE_MISMATCH', 'Body does not match the declared byte range.');
        if (hash.digest('hex') !== range.sha256) throw new McpError('CHUNK_HASH_MISMATCH', 'Chunk SHA-256 does not match. Resend this chunk at the confirmed nextOffset.', { nextOffset: confirmed });
        const nextOffset = range.end + 1;
        const complete = nextOffset === Number(row.size);
        const sha256 = complete ? await fileSha256(row.id) : null;
        if (sha256) assertFileHash(row, sha256);
        await syncUploadFile(row.id);
        await resolveMcpTarget(ctx.client, ctx.storageId, 'files:upload');
        persistingOffset = true;
        const updated = (await client.query("UPDATE mcp_uploads SET status=$2,received_bytes=$3,content_sha256=$4,error_code=NULL,updated_at=NOW() WHERE id=$1 RETURNING *", [row.id, complete ? 'ready' : 'open', nextOffset, sha256])).rows[0];
        return receipt(updated);
    } catch (error) {
        if (!persistingOffset) {
            await fs.promises.truncate(uploadPath(row.id), confirmed);
            await syncUploadFile(row.id);
            await client.query("UPDATE mcp_uploads SET status='open',content_sha256=NULL,error_code=$2,updated_at=NOW() WHERE id=$1 AND status='receiving_chunk'", [row.id, error instanceof McpError ? error.code : 'UPLOAD_BODY_INCOMPLETE']);
        }
        throw error;
    }
}

function sendUploadError(res: Response, error: unknown, scheme = 'UploadTicket') {
    const known = error instanceof McpError;
    const result = safeMcpError(error instanceof z.ZodError ? new McpError('INVALID_ARGUMENT', 'Invalid upload parameters.') : error);
    const code = result.error.code;
    const status = ({ UNAUTHORIZED: 401, FORBIDDEN: 403, MCP_DISABLED: 503, UPLOAD_NOT_FOUND: 404,
        UPLOAD_EXPIRED: 410, UPLOAD_TICKET_EXPIRED: 410, UPLOAD_CANCELLED: 409, UPLOAD_BUSY: 409, INVALID_STATE: 409,
        RECONCILIATION_REQUIRED: 409, UPLOAD_OFFSET_CONFLICT: 409, SOURCE_REQUIRED: 409,
        INVALID_ARGUMENT: 400, SIZE_MISMATCH: 400, CHUNK_HASH_MISMATCH: 400, FILE_HASH_MISMATCH: 400, CHUNK_TOO_LARGE: 413 } as Record<string, number>)[code] ?? 500;
    if (!res.headersSent && !res.destroyed) {
        if (status === 401) res.set('WWW-Authenticate', `${scheme} realm="tg-vault-mcp-upload"`);
        res.status(status).set('Cache-Control', 'no-store').json(result);
    }
    return known ? error.code : code;
}

export async function handleMcpUploadContentGet(req: Request, res: Response) {
    try {
        const { row } = await ticketContext(pool, uploadIdSchema.parse(req.params.id), requestTicket(req));
        res.set('Cache-Control', 'no-store').json(receipt(row));
    } catch (error) { sendUploadError(res, error); }
}

export async function handleMcpUploadContentPut(req: Request, res: Response) {
    const started = Date.now();
    let ctx: McpContext | undefined;
    try {
        const id = uploadIdSchema.parse(req.params.id);
        const result = await withUploadLock(id, async client => {
            const current = await ticketContext(client, id, requestTicket(req));
            ctx = current.ctx;
            const row = await recoverInterruptedReceive(client, current.row);
            assertUploadReceivable(row);
            const range = requestRange(req, Number(row.size));
            if (range) return receiveChunk(client, current.ctx, row, req, range);
            if (row.status === 'ready') return replayUploadBytes(current.ctx, row, req, Number(row.size), row.content_sha256 || await fileSha256(row.id));
            if (row.status !== 'open') throw new McpError('INVALID_STATE', 'Bytes can only be received before the upload is submitted.');
            return receiveUploadBytes(client, current.ctx, row, req);
        });
        await recordMcpAudit(ctx!.client.id, 'upload.content', ctx!.storageId, 'success', null, Date.now() - started);
        res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
        const code = sendUploadError(res, error);
        await recordMcpAudit(ctx?.client.id ?? null, 'upload.content', ctx?.storageId ?? null, 'error', code, Date.now() - started);
    }
}

async function renewUploadTicket(ctx: McpContext, input: { uploadId: string }) {
    return withUploadLock(input.uploadId, async client => {
        const row = await recoverInterruptedReceive(client, await findUpload(ctx, input.uploadId));
        assertUploadReceivable(row);
        if (!['open', 'ready'].includes(row.status) || row.stored_name !== null) throw new McpError('INVALID_STATE', 'Only an unsubmitted upload can receive a new ticket.');
        await resolveMcpTarget(ctx.client, ctx.storageId, 'files:upload');
        const ticket = randomBytes(32).toString('base64url');
        const expiresAt = ticketDeadline(ctx, row.expires_at);
        const updated = (await client.query('UPDATE mcp_uploads SET token_hash=$2,ticket_expires_at=$3,updated_at=NOW() WHERE id=$1 RETURNING *', [row.id, hashMcpSecret(ticket), expiresAt])).rows[0];
        return { ...preparedUploadView(updated, ticket), ...receipt(updated) };
    });
}

export async function handleMcpUploadPut(req: Request, res: Response) {
    const started = Date.now();
    let ctx: McpContext | undefined;
    try {
        const id = uploadIdSchema.parse(req.params.id);
        const principal = await authenticateMcpToken(/^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1] || '');
        const result = await withUploadLock(id, async client => {
            const row = (await client.query('SELECT * FROM mcp_uploads WHERE id=$1 AND client_id=$2', [id, principal.id])).rows[0];
            if (!row) throw new McpError('UPLOAD_NOT_FOUND', 'Upload not found.');
            const ticket = requestTicket(req);
            if (!timingSafeEqual(Buffer.from(hashMcpSecret(ticket), 'hex'), Buffer.from(row.token_hash, 'hex'))) throw new McpError('UNAUTHORIZED', 'Invalid upload ticket.');
            if (row.ticket_expires_at && new Date(row.ticket_expires_at).getTime() <= Date.now()) throw new McpError('UPLOAD_TICKET_EXPIRED', 'Renew this session with upload_ticket.');
            ctx = await resolveMcpTarget(principal, row.storage_id, 'files:upload');
            assertUploadReceivable(row);
            if (req.headers['content-range'] !== undefined) throw new McpError('INVALID_ARGUMENT', 'Use the ticket content endpoint for resumable chunks.');
            requestRange(req, Number(row.size));
            const current = await recoverInterruptedReceive(client, row);
            return receiveUploadBytes(client, ctx, current, req);
        });
        await recordMcpAudit(ctx!.client.id, 'upload.put', ctx!.storageId, 'success', null, Date.now() - started);
        res.json(result);
    } catch (error) {
        const code = sendUploadError(res, error, 'Bearer');
        await recordMcpAudit(ctx?.client.id ?? null, 'upload.put', ctx?.storageId ?? null, 'error', code, Date.now() - started);
    }
}

async function processUpload(id: string) {
    if (activeWorkers.has(id)) return;
    activeWorkers.add(id);
    const client = await transferLockPool.connect().catch(error => { activeWorkers.delete(id); throw error; });
    let locked = false;
    let claimed = false;
    try {
        const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`mcp-upload:${id}`]);
        if (!lock.rows[0].locked) return;
        locked = true;
        const claim = await client.query("UPDATE mcp_uploads SET status='running',error_code=NULL,updated_at=NOW() WHERE id=$1 AND status='queued' AND expires_at>NOW() RETURNING *", [id]);
        if (!claim.rows[0]) return;
        claimed = true;
        const row = claim.rows[0];
        const principal = await getMcpPrincipal(row.client_id);
        const ctx = await resolveMcpTarget(principal, row.storage_id, 'files:upload');
        let progressWrite: Promise<unknown> = Promise.resolve();
        let lastProgressAt = 0;
        const result = await uploadIndexedFile({ target: ctx.target, source: 'api', originalName: row.filename,
            mimeType: row.mime_type, size: Number(row.size), tempPath: uploadPath(id), folder: row.folder,
            fileId: id, retainSourceOnFailure: true, options: {
                beforeSave: async (storedName, storedPath, resolvedFolder) => {
                    await resolveMcpTarget(principal, row.storage_id, 'files:upload');
                    await client.query('UPDATE mcp_uploads SET stored_name=$2,stored_path=$3,resolved_folder=$4,updated_at=NOW() WHERE id=$1', [id, storedName, storedPath,resolvedFolder]);
                },
                onCompensated: async () => {
                    await client.query('UPDATE mcp_uploads SET stored_name=NULL,stored_path=NULL,updated_at=NOW() WHERE id=$1', [id]);
                },
                onProgress: transferred => {
                    if (Date.now() - lastProgressAt < 500) return;
                    lastProgressAt = Date.now();
                    progressWrite = client.query("UPDATE mcp_uploads SET transferred_bytes=$2,updated_at=NOW() WHERE id=$1 AND status='running'", [id, Math.min(Number(row.size), transferred)])
                        .catch(() => console.error('[MCP] Upload progress persistence failed.'));
                },
            } });
        await progressWrite;
        await client.query("UPDATE mcp_uploads SET status='completed',result=$2::jsonb,transferred_bytes=size,error_code=NULL,updated_at=NOW() WHERE id=$1", [id, JSON.stringify(result)]);
    } catch (error) {
        if (claimed) {
            if(await completeIndexedUpload(client,id)) return;
            // A recorded write intent can mean the provider accepted bytes before a crash.
            // Never retry such a write automatically without authoritative reconciliation.
            const source=await fs.promises.stat(uploadPath(id)).catch((sourceError:NodeJS.ErrnoException)=>{if(sourceError.code==='ENOENT')return null;throw sourceError;});
            const failure=safeMcpError(error);
            await client.query(`UPDATE mcp_uploads SET status=CASE WHEN stored_name IS NULL THEN 'failed' ELSE 'reconciliation_required' END,
                error_code=CASE WHEN stored_name IS NULL AND $3::boolean THEN 'SOURCE_REQUIRED' ELSE $2 END,result=$4::jsonb,updated_at=NOW() WHERE id=$1`,
            [id, error instanceof McpError ? error.code : 'UPLOAD_FAILED',!source,JSON.stringify({error:failure.error})]);
        }
    } finally {
        try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`mcp-upload:${id}`]); }
        finally { client.release(); activeWorkers.delete(id); }
    }
}

function scheduleUpload(id: string) {
    void processUpload(id).catch(() => console.error('[MCP] Upload worker database operation failed.'));
}

async function controlUploadLocked(ctx: McpContext, id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') {
    const row = await findUpload(ctx, id);
    const reason = (await uploadActions(ctx, row)).blockedActions[action];
    if (reason) throw new McpError(reason, 'This upload cannot perform the requested action. Refresh the task and follow its blockedActions reason.');
    if (action === 'cancel') {
        const result = await query("UPDATE mcp_uploads SET status='cancelled',updated_at=NOW() WHERE id=$1 AND status IN ('open','ready','queued','paused','failed') AND stored_name IS NULL RETURNING *", [id]);
        if (!result.rows[0]) throw new McpError('INVALID_STATE', 'Only uploads without a storage write intent can be cancelled.');
        await fs.promises.rm(uploadPath(id), { force: true });
        return taskView(result.rows[0]);
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new McpError('UPLOAD_EXPIRED', 'Prepare a new upload session.');
    if (action === 'pause') {
        const result = await query("UPDATE mcp_uploads SET status='paused',updated_at=NOW() WHERE id=$1 AND status IN ('ready','queued') RETURNING *", [id]);
        if (!result.rows[0]) throw new McpError('INVALID_STATE', 'Only a staged or queued upload can be paused.');
        return taskView(result.rows[0]);
    }
    await resolveMcpTarget(ctx.client, ctx.storageId, 'files:upload');
    const source = await fs.promises.stat(uploadPath(id)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!source || source.size !== Number(row.size)) throw new McpError('SOURCE_REQUIRED', 'The staged file is missing. Prepare a new upload and resend the bytes.');
    const expected = action === 'resume' ? 'paused' : 'failed';
    const result = await query("UPDATE mcp_uploads SET status='queued',error_code=NULL,updated_at=NOW() WHERE id=$1 AND status=$2 AND stored_name IS NULL RETURNING *", [id, expected]);
    if (!result.rows[0]) throw new McpError('INVALID_STATE', 'This upload cannot be retried automatically; reconcile any previous storage write first.');
    return taskView(result.rows[0]);
}

export async function controlMcpUpload(ctx: McpContext, id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') {
    const result = await withUploadLock(id, () => controlUploadLocked(ctx, id, action));
    if (result.status === 'queued') scheduleUpload(id);
    return result;
}

async function sweepUploads() {
    const result = await query(`SELECT * FROM mcp_uploads
        WHERE status IN ('running','receiving','receiving_chunk')
        OR (status='reconciliation_required' AND EXISTS (SELECT 1 FROM files WHERE files.id=mcp_uploads.id))
        OR (expires_at<=NOW() AND status IN ('open','ready','queued','paused','failed')) ORDER BY updated_at,id`);
    for (const row of result.rows) {
        if (activeWorkers.has(row.id)) continue;
        // Recovery only uses this connection and filesystem metadata; it does not
        // perform provider I/O or acquire another business-pool connection.
        const client = await pool.connect();
        let locked = false;
        try {
            const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`mcp-upload:${row.id}`]);
            if (!lock.rows[0].locked) continue;
            locked = true;
            if (row.status === 'running' || row.status === 'reconciliation_required') {
                const current = await client.query("SELECT stored_name FROM mcp_uploads WHERE id=$1 AND status IN ('running','reconciliation_required')", [row.id]);
                if (!current.rows[0]) continue;
                if(!await completeIndexedUpload(client,row.id) && row.status==='running') {
                    await client.query("UPDATE mcp_uploads SET status=CASE WHEN stored_name IS NULL THEN 'failed' ELSE 'reconciliation_required' END,error_code='PROCESS_INTERRUPTED',updated_at=NOW() WHERE id=$1 AND status='running'", [row.id]);
                }
            } else if (row.status === 'receiving_chunk') {
                const current = (await client.query('SELECT * FROM mcp_uploads WHERE id=$1', [row.id])).rows[0];
                if (current?.status === 'receiving_chunk') {
                    if (new Date(current.expires_at).getTime() <= Date.now()) {
                        const expired = await client.query("UPDATE mcp_uploads SET status='cancelled',error_code='UPLOAD_EXPIRED',updated_at=NOW() WHERE id=$1 AND status='receiving_chunk' AND stored_name IS NULL RETURNING id", [row.id]);
                        if (expired.rowCount) await fs.promises.rm(uploadPath(row.id), { force: true });
                    } else await recoverInterruptedReceive(client, current);
                }
            } else if (row.status === 'receiving') {
                const interrupted = await client.query("UPDATE mcp_uploads SET status='open',received_bytes=0,content_sha256=NULL,error_code='UPLOAD_BODY_INCOMPLETE',updated_at=NOW() WHERE id=$1 AND status='receiving' RETURNING id", [row.id]);
                if (interrupted.rowCount) await fs.promises.rm(uploadPath(row.id), { force: true });
            } else {
                const expired = await client.query("UPDATE mcp_uploads SET status='cancelled',error_code='UPLOAD_EXPIRED',updated_at=NOW() WHERE id=$1 AND expires_at<=NOW() AND status IN ('open','ready','queued','paused','failed') AND stored_name IS NULL RETURNING id", [row.id]);
                if (expired.rowCount) await fs.promises.rm(uploadPath(row.id), { force: true });
            }
        } finally {
            try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`mcp-upload:${row.id}`]); }
            finally { client.release(); }
        }
    }
    const queued=await query("SELECT id FROM mcp_uploads WHERE status='queued' AND expires_at>NOW() ORDER BY created_at,id LIMIT 100");
    for(const row of queued.rows) scheduleUpload(row.id);
}

export async function recoverMcpUploads() {
    await fs.promises.mkdir(UPLOAD_DIRECTORY, { recursive: true });
    await sweepUploads();
    if (!maintenanceTimer) {
        maintenanceTimer = setInterval(() => { void sweepUploads().catch(() => console.error('[MCP] Upload recovery database operation failed.')); }, 15_000);
        maintenanceTimer.unref();
    }
}

export function stopMcpUploads() { if (maintenanceTimer) clearInterval(maintenanceTimer); maintenanceTimer = null; }

async function reconciliationPreview(ctx: McpContext, input: { uploadId: string }) {
    const row=await findUpload(ctx,input.uploadId);
    if(row.status!=='reconciliation_required') throw new McpError('INVALID_STATE','This upload does not require storage reconciliation.');
    if(await committedUploadFile(pool,row.id)) return {uploadId:row.id,filename:row.filename,status:row.status,indexed:true,committed:true,
        objectPresent:null,canDeleteKnownObject:false,updatedAt:new Date(row.updated_at).toISOString(),
        action:'The exact file index committed successfully. Confirm to record completion without deleting any object.'};
    const indexed=await query(`SELECT id FROM files WHERE id=$1 OR
        ((storage_account_id::text=$2 OR ($2='local' AND source='local'))
         AND (path=$3 OR (stored_name=$4 AND folder IS NOT DISTINCT FROM $5))) LIMIT 1`,
    [row.id,row.storage_id,row.stored_path,row.stored_name,row.resolved_folder]);
    const objectPresent=await ctx.target.provider.fileExists(row.stored_name,row.resolved_folder);
    return { uploadId:row.id,filename:row.filename,status:row.status,indexed:!!indexed.rowCount,
        objectPresent,canDeleteKnownObject:!!row.stored_path,updatedAt:new Date(row.updated_at).toISOString(),
        action:indexed.rowCount ? 'Inspect the indexed file before cleanup; indexed objects will not be deleted.'
            : objectPresent && !row.stored_path ? 'Inspect and remove the unindexed object in the provider console, then preview again. Its immutable object identity is unavailable.'
                : objectPresent ? 'Delete the recorded unindexed storage object, then allow retry or cancellation.'
                    : 'Confirm that no storage object exists, then allow retry or cancellation.' };
}

async function reconcileUpload(ctx: McpContext, input: { uploadId: string }) {
    const client=await transferLockPool.connect().catch(()=>{throw new McpError('UPLOAD_BUSY','Could not acquire an upload recovery connection. Retry shortly.');});
    let locked=false;
    let nameLocked=false;
    let nameKey:string|undefined;
    try {
        const lock=await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[`mcp-upload:${input.uploadId}`]);
        if(!lock.rows[0].locked) throw new McpError('UPLOAD_BUSY','An upload operation is already running.');
        locked=true;
        const row=await findUpload(ctx,input.uploadId);
        if(row.status!=='reconciliation_required') throw new McpError('INVALID_STATE','This upload does not require reconciliation.');
        const completed=await completeIndexedUpload(client,row.id);
        if(completed) return {task:taskView(completed),nextStep:'The committed file has been recovered; no object was deleted.'};
        nameKey=JSON.stringify(['stored-name',ctx.target.accountId,row.resolved_folder,row.stored_name]);
        nameLocked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[nameKey])).rows[0].locked;
        if(!nameLocked) throw new McpError('UPLOAD_BUSY','A write to this destination is running; retry reconciliation after it finishes.');
        const preview=await reconciliationPreview(ctx,input);
        if(preview.indexed) throw new McpError('OBJECT_INDEXED','A file index references this object. Inspect that file before recovery; no indexed object was deleted.');
        if(preview.objectPresent) {
            if(!row.stored_path) throw new McpError('MANUAL_RECONCILIATION_REQUIRED','The provider did not supply an immutable write identity. Inspect/remove the unindexed object in the provider console, then preview reconciliation again.');
            try { await ctx.target.provider.deleteFile(row.stored_path); }
            catch(error) { if(!isPhysicalFileNotFound(error)) throw new McpError('RECONCILIATION_FAILED','The storage object could not be removed; the write intent remains protected.'); }
        }
        const source=await fs.promises.stat(uploadPath(row.id)).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
        const result=await client.query(`UPDATE mcp_uploads SET status='failed',stored_name=NULL,stored_path=NULL,error_code=$2,updated_at=NOW()
            WHERE id=$1 AND status='reconciliation_required' RETURNING *`,[row.id,source&&source.size===Number(row.size)?'RECONCILED_RETRY_READY':'SOURCE_REQUIRED']);
        return { task:taskView(result.rows[0]),nextStep:source ? 'Retry the upload through task controls, or cancel it.' : 'The staged source is unavailable. Cancel this task and prepare a new upload.' };
    } finally {
        try {
            if(nameLocked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[nameKey]);
            if(locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`mcp-upload:${input.uploadId}`]);
        } finally {client.release();}
    }
}

export const uploadTools: McpTool[] = [
    {
        name: 'upload_prepare', permission: 'files:upload', mutation: true,
        description: 'Prepare a client-bound upload up to 2 GiB. For files up to 1 MiB, use upload_write through MCP with no separate Bearer handling. Larger files use ticketUpload without a long-lived Bearer token, with sequential Content-Range chunks for resume. Renew short-lived tickets automatically using upload_ticket. Then call upload_commit. Existing storage naming, duplicate and cooldown rules apply.',
        inputSchema: { filename: z.string().min(1).max(255), mimeType: z.string().regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/).max(100),
            sha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Optional SHA-256 of the complete file; ready is withheld until it matches.'),
            sizeBytes: z.number().int().min(0).max(SIMPLE_UPLOAD_MAX_BYTES), folder: z.string().max(255).nullable().optional() },
        run: prepareUpload,
        recover: async ctx => {
            const existing = await query('SELECT * FROM mcp_uploads WHERE client_id=$1 AND request_id=$2', [ctx.client.id, ctx.requestId]);
            const row = existing.rows[0];
            if (!row) return null;
            if (['open', 'ready', 'receiving_chunk'].includes(row.status) && new Date(row.expires_at).getTime() > Date.now()) return renewUploadTicket(ctx, { uploadId: row.id });
            return { uploadId: row.id, jobId: row.id, task: taskView(row) };
        },
    },
    {
        name: 'upload_ticket', permission: 'files:upload', mutation: true,
        description: 'Renew or rotate this unsubmitted upload’s short-lived single-file HTTP ticket. Preserves confirmed chunks and nextOffset. The ticket content endpoint needs no long-lived Bearer token and cannot submit a storage write. Use automatically on ticket expiry; no additional user approval is required.',
        inputSchema: { uploadId: uploadIdSchema }, run: renewUploadTicket,
    },
    {
        name: 'upload_write', permission: 'files:upload', mutation: true,
        description: 'Stage all bytes of a prepared upload through the authenticated MCP connection, without exposing or forwarding a Bearer token. Accepts at most 1 MiB decoded bytes as UTF-8 text or canonical padded base64. Byte count must match upload_prepare. Then call upload_commit; this tool only stages bytes and does not write to the selected storage yet.',
        inputSchema: { uploadId: uploadIdSchema, content: z.string().max(Math.ceil(MCP_WRITE_MAX_BYTES / 3) * 4),
            encoding: z.enum(['utf8', 'base64']).default('utf8') },
        run: writeUpload,
    },
    {
        name: 'upload_commit', permission: 'files:upload', mutation: true,
        description: 'Queue a staged upload and immediately return its task ID. Poll upload_status or tasks_get (mcp_upload). Repeated commits never start another write.',
        inputSchema: { uploadId: uploadIdSchema }, run: async (ctx, input) => {
            const task = await withUploadLock(input.uploadId, async client => {
                const row = await recoverInterruptedReceive(client, await findUpload(ctx, input.uploadId));
                if (['queued', 'running', 'completed'].includes(row.status)) return taskView(row);
                assertUploadReceivable(row);
                if (['paused', 'failed'].includes(row.status)) throw new McpError('INVALID_STATE', 'Inspect upload_status and use the currently allowed resume or retry action.', { uploadId: row.id, status: row.status });
                const result = await client.query("UPDATE mcp_uploads SET status='queued',updated_at=NOW() WHERE id=$1 AND status='ready' RETURNING *", [row.id]);
                if (!result.rows[0]) throw new McpError('UPLOAD_NOT_READY', `This upload is ${row.status}. Upload all declared bytes before committing; use upload_status for its current state.`, { uploadId: row.id, status: row.status });
                return taskView(result.rows[0]);
            });
            if (task.status === 'queued') scheduleUpload(input.uploadId);
            return { jobId: input.uploadId, task };
        },
        recover: async (ctx, input) => {
            const row = await findUpload(ctx,input.uploadId);
            return ['queued','running','completed','failed','reconciliation_required'].includes(row.status)
                ? { jobId: row.id, task: taskView(row) } : null;
        },
    },
    {
        name: 'upload_status', permission: 'files:upload', description: 'Query this client’s upload task, including durable result, failure code and recovery state. Does not expose tickets or paths.',
        inputSchema: { uploadId: uploadIdSchema }, run: async (ctx, input) => ({ task: await getMcpUpload(ctx, input.uploadId) }),
    },
    {
        name:'upload_reconcile',permission:'files:upload',mutation:true,destructive:true,
        description:'Recover an interrupted upload with an uncertain storage write. Preview and confirm cleanup of the recorded unindexed object. Indexed objects are never deleted. Providers without a recorded object identity require manual provider cleanup before this tool can prove absence. Afterwards retry when staged bytes remain, or cancel and re-upload.',
        inputSchema:{uploadId:uploadIdSchema},preview:reconciliationPreview,run:reconcileUpload,
    },
];
