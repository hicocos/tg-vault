import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db/index.js';
import { isPathInside } from '../utils/localPath.js';
import { buildCloudMediaResponse } from '../services/cloudMediaResponse.js';
import { streamMediaResponse } from '../services/mediaStreamResponse.js';
import { McpError, type McpContext } from './contracts.js';
import { getMcpPrincipal, hashMcpSecret, mcpEndpoint, resolveMcpTarget } from './security.js';
import { safeMcpError, recordMcpAudit } from './operations.js';

type MediaPurpose = 'download' | 'preview' | 'thumbnail';

async function scopedFile(context: McpContext, fileId: string) {
    const result = await query(`SELECT * FROM files WHERE id=$1 AND
        (($2='local' AND source='local') OR (storage_account_id::text=$2 AND source=$3))`,
    [fileId, context.storageId, context.target.provider.name]);
    if (!result.rows[0] || result.rows[0].name === '.folder') throw new McpError('NOT_FOUND', 'File not found in this storage account.');
    return result.rows[0];
}

export async function issueMediaLink(context: McpContext, fileId: string, purpose: MediaPurpose, expiresIn = 300) {
    await scopedFile(context, fileId);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.min(Date.now() + Math.min(900, Math.max(1, expiresIn)) * 1000, Date.parse(context.client.expiresAt))).toISOString();
    await query(`INSERT INTO mcp_media_links (token_hash,client_id,file_id,storage_id,purpose,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, [hashMcpSecret(token), context.client.id, fileId, context.storageId, purpose, expiresAt]);
    return { url: `${mcpEndpoint()}/media/${fileId}/${purpose}?token=${token}`, expiresAt };
}

async function localMediaPath(root: string, candidate: string): Promise<string> {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(candidate);
    if (!isPathInside(resolvedRoot, resolved)) throw new McpError('MEDIA_UNAVAILABLE', 'Media source is unavailable.');
    const real = await fs.realpath(resolved);
    if (!isPathInside(await fs.realpath(resolvedRoot), real)) throw new McpError('MEDIA_UNAVAILABLE', 'Media source is unavailable.');
    if (!(await fs.stat(real)).isFile()) throw new McpError('MEDIA_UNAVAILABLE', 'Media source is unavailable.');
    return real;
}

async function cachedMediaPath(fileId: string, column: 'thumbnail_path' | 'preview_path', root: string, cachedPath: string): Promise<string | undefined> {
    try {
        return await localMediaPath(root, path.join(root, path.basename(cachedPath)));
    } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
        // Do not clear a replacement written by a concurrent derivative job.
        await query(`UPDATE files SET ${column}=NULL,
            derivative_status=CASE WHEN derivative_status IN ('queued','processing') THEN derivative_status ELSE 'failed' END,
            derivative_error=CASE WHEN derivative_status IN ('queued','processing') THEN derivative_error ELSE 'Cached media is missing.' END,
            updated_at=NOW() WHERE id=$1 AND ${column}=$2`, [fileId, cachedPath]);
        return undefined;
    }
}

export async function handleMcpMedia(req: Request, res: Response): Promise<void> {
    const started = Date.now();
    let clientId: string | null = null;
    let storageId: string | null = null;
    try {
        const fileId = z.uuid().parse(req.params.fileId);
        const purpose = z.enum(['download', 'preview', 'thumbnail']).parse(req.params.purpose);
        const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(req.query.token);
        const links = await query(`SELECT * FROM mcp_media_links WHERE token_hash=$1 AND file_id=$2 AND purpose=$3 AND expires_at>NOW()`, [hashMcpSecret(token), fileId, purpose]);
        const link = links.rows[0];
        if (!link) throw new McpError('UNAUTHORIZED', 'This media link is invalid or expired.');
        clientId = link.client_id;
        storageId = link.storage_id;
        const client = await getMcpPrincipal(link.client_id);
        const context = await resolveMcpTarget(client, link.storage_id, 'files:download');
        const file = await scopedFile(context, fileId);
        res.set({
            'Cache-Control': 'private, no-store',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'",
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `${purpose === 'download' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`,
        });
        const thumbnailRoot = process.env.THUMBNAIL_DIR || './data/thumbnails';
        const previewRoot = process.env.PREVIEW_DIR || './data/previews';
        const uploadRoot = process.env.UPLOAD_DIR || './data/uploads';
        let localPath: string | undefined;
        let mime = file.mime_type || 'application/octet-stream';
        if (purpose === 'thumbnail') {
            if (!file.thumbnail_path) throw new McpError('MEDIA_UNAVAILABLE', 'No thumbnail is available for this file.');
            localPath = await cachedMediaPath(fileId, 'thumbnail_path', thumbnailRoot, file.thumbnail_path);
            if (!localPath) throw new McpError('MEDIA_UNAVAILABLE', 'The cached thumbnail is no longer available. Refresh the file details.');
            mime = 'image/webp';
        } else if (purpose === 'preview' && file.preview_path) {
            localPath = await cachedMediaPath(fileId, 'preview_path', previewRoot, file.preview_path);
            // Evicted previews fall back to the same scoped original.
            if (localPath) mime = file.type === 'video' ? 'video/mp4' : 'image/webp';
        }
        if (!localPath && file.source === 'local') {
            localPath = await localMediaPath(uploadRoot, file.path || path.join(uploadRoot, file.stored_name));
        }
        res.type(mime);
        if (!/^(image\/(jpeg|png|gif|webp|avif)|video\/|audio\/|text\/plain)/i.test(mime)) res.attachment(file.name);
        if (localPath) {
            await new Promise<void>((resolve, reject) => res.sendFile(localPath!, { cacheControl: false, lastModified: false }, error => error ? reject(error) : resolve()));
        } else {
            const source = await context.target.provider.getFileStream(file.path, { range: req.headers.range }) as Readable & { upstreamStatus?: number; upstreamHeaders?: Record<string, string> };
            const response = buildCloudMediaResponse({ upstreamStatus: source.upstreamStatus, upstreamHeaders: source.upstreamHeaders, requestedRange: req.headers.range });
            res.status(response.status).set(response.headers);
            await streamMediaResponse(req, res, source);
        }
        await recordMcpAudit(clientId, `media.${purpose}`, storageId, 'success', null, Date.now() - started);
    } catch (error) {
        const result = safeMcpError((error as NodeJS.ErrnoException).code === 'EACCES'
            ? new McpError('MEDIA_UNAVAILABLE', 'The media source cannot be read.') : error);
        if (res.headersSent) res.destroy();
        else {
            for (const name of ['Content-Disposition', 'Content-Length', 'Content-Range', 'Content-Encoding', 'Accept-Ranges', 'ETag', 'Last-Modified']) res.removeHeader(name);
            res.status(result.error.code === 'UNAUTHORIZED' ? 401 : result.error.code === 'FORBIDDEN' ? 403 : 404).set('Cache-Control', 'no-store').type('application/json').json(result);
        }
        await recordMcpAudit(clientId, 'media', storageId, 'error', result.error.code, Date.now() - started);
    }
}
