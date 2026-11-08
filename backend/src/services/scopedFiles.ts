import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, query } from '../db/index.js';
import type { StorageTargetSnapshot } from './storage/contracts.js';
import { buildStorageCapabilities, buildStorageScopeForTarget } from '../utils/storageProductContract.js';
import { nextParam, removePhysicalFile } from '../utils/fileScope.js';
import { normalizeFolderPath } from '../utils/folderPath.js';
import { createFileDeletionService } from './fileDeletion.js';
import { buildFilePageQuery, cursorForFile, decodeFileQueryCursor, FILE_TIMESTAMP_PROJECTION, normalizeFileQuery } from './fileQuery.js';
import { withStorageAccountOperationLease } from './storageAccountOperation.js';

export class FileOperationError extends Error {
    constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) { super(message); }
}

export function fileScope(target: StorageTargetSnapshot) {
    return buildStorageScopeForTarget({ providerName: target.provider.name, accountId: target.accountId });
}

export async function findTargetFile(target: StorageTargetSnapshot, id: string, db: Pick<PoolClient, 'query'> = pool) {
    const scope = fileScope(target);
    const result = await db.query(`SELECT *, ${FILE_TIMESTAMP_PROJECTION} FROM files WHERE ${scope.clause} AND id = ${nextParam(scope, 1)}::uuid`, [...scope.params, id]);
    return result.rows[0] ?? null;
}

export async function requireTargetFile(target: StorageTargetSnapshot, id: string, db: Pick<PoolClient, 'query'> = pool) {
    const file = await findTargetFile(target, id, db);
    if (!file) throw new FileOperationError('FILE_NOT_FOUND', 'File not found in the specified storage account.');
    return file;
}

export function publicFile(file: Record<string, any>) {
    return {
        id: String(file.id), kind: file.name === '.folder' || file.mime_type === 'application/x-directory' ? 'folder' : 'file', name: file.name, type: file.type, mimeType: file.mime_type,
        sizeBytes: String(file.size), folder: file.folder, isFavorite: !!file.is_favorite,
        source: file.source, storageAccountId: file.storage_account_id ?? 'local',
        width: file.width ?? null, height: file.height ?? null,
        hasThumbnail: !!file.thumbnail_path, hasPreview: !!file.preview_path,
        derivativeStatus: file.derivative_status ?? null, createdAt: file.created_at_iso ?? file.created_at, updatedAt: file.updated_at_iso ?? file.updated_at,
    };
}

export async function queryTargetFiles(target: StorageTargetSnapshot, raw: Record<string, unknown>) {
    let options;
    try { options = normalizeFileQuery({ ...raw, type: raw.type === 'non_media' ? 'document' : raw.type === 'document' ? undefined : raw.type }); }
    catch (error) { throw new FileOperationError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid file query.'); }
    if (options.cursor && !decodeFileQueryCursor(options.cursor, options.sort, options.direction)) {
        throw new FileOperationError('INVALID_CURSOR', 'Cursor is invalid or does not match the requested sort.');
    }
    const built = buildFilePageQuery(target.provider.name === 'local'
        ? { kind: 'local' } : { kind: 'account', accountId: target.accountId! }, options,
    ["name <> '.folder'", "mime_type IS DISTINCT FROM 'application/x-directory'", ...(raw.type === 'document' ? ["type = 'document'"] : [])]);
    const result = await query(built.text, built.params);
    const rows = result.rows.slice(0, options.limit);
    return { rows, nextCursor: result.rows.length > options.limit
        ? cursorForFile(rows[rows.length - 1], options.sort, options.direction) : null,
    hasMore: result.rows.length > options.limit };
}

export function normalizeFileName(name: string) {
    const normalized = name.trim();
    if (!normalized || normalized.length > 255 || normalized === '.' || normalized === '..' || normalized === '.folder'
        || /[\/\\:*?"<>|\x00-\x1f\x7f]/.test(normalized)) {
        throw new FileOperationError('INVALID_FILENAME', 'Filename must be 1–255 characters without path separators or control characters.');
    }
    return normalized;
}

export async function requireTargetFolder(target: StorageTargetSnapshot, folder: string, db: Pick<PoolClient, 'query'> = pool) {
    const scope = fileScope(target);
    const param = nextParam(scope, 1);
    const result = await db.query(`SELECT 1 FROM files WHERE ${scope.clause}
        AND (folder = ${param} OR LEFT(folder, LENGTH(${param}) + 1) = ${param} || '/') LIMIT 1`, [...scope.params, folder]);
    if (!result.rowCount) throw new FileOperationError('FOLDER_NOT_FOUND', 'Destination folder does not exist in this storage account.');
}

export async function renameTargetFile(target: StorageTargetSnapshot, id: string, name: string, db: Pick<PoolClient, 'query'> = pool) {
    const normalized = normalizeFileName(name);
    const file = await requireTargetFile(target, id, db);
    if (file.name === '.folder') throw new FileOperationError('DIRECTORY_PLACEHOLDER', 'Use folder tools to rename directories.');
    if (path.extname(file.name).toLowerCase() !== path.extname(normalized).toLowerCase()) {
        throw new FileOperationError('EXTENSION_CHANGE_FORBIDDEN', 'Renaming must preserve the file extension.');
    }
    if (file.name === normalized) return file;
    const scope = fileScope(target);
    const result = await db.query(`UPDATE files SET name = ${nextParam(scope, 2)}, updated_at = NOW()
        WHERE ${scope.clause} AND id = ${nextParam(scope, 1)}::uuid RETURNING *, ${FILE_TIMESTAMP_PROJECTION}`, [...scope.params, id, normalized]);
    if (!result.rowCount) throw new FileOperationError('FILE_NOT_FOUND', 'File no longer exists.');
    return result.rows[0];
}

export async function moveTargetFile(target: StorageTargetSnapshot, id: string, folder: string | null, db: Pick<PoolClient, 'query'> = pool) {
    const destination = folder === null ? null : normalizeFolderPath(folder);
    if (destination) await requireTargetFolder(target, destination, db);
    const file = await requireTargetFile(target, id, db);
    if (file.name === '.folder') throw new FileOperationError('DIRECTORY_PLACEHOLDER', 'Use folder tools to move directories.');
    if (file.folder === destination) return file;
    const scope = fileScope(target);
    const result = await db.query(`UPDATE files SET folder = ${nextParam(scope, 2)}, updated_at = NOW()
        WHERE ${scope.clause} AND id = ${nextParam(scope, 1)}::uuid RETURNING *, ${FILE_TIMESTAMP_PROJECTION}`, [...scope.params, id, destination]);
    if (!result.rowCount) throw new FileOperationError('FILE_NOT_FOUND', 'File no longer exists.');
    return result.rows[0];
}

export async function favoriteTargetFile(target: StorageTargetSnapshot, id: string, favorite: boolean, db: Pick<PoolClient, 'query'> = pool) {
    const file = await requireTargetFile(target, id, db);
    if (!!file.is_favorite === favorite) return file;
    const scope = fileScope(target);
    const result = await db.query(`UPDATE files SET is_favorite = ${nextParam(scope, 2)}, updated_at = NOW()
        WHERE ${scope.clause} AND id = ${nextParam(scope, 1)}::uuid RETURNING *, ${FILE_TIMESTAMP_PROJECTION}`, [...scope.params, id, favorite]);
    if (!result.rowCount) throw new FileOperationError('FILE_NOT_FOUND', 'File not found in the specified storage account.');
    return result.rows[0];
}

export async function shareTargetFile(target: StorageTargetSnapshot, id: string, password?: string, expiration?: string) {
    const file = await requireTargetFile(target, id);
    const capabilities = buildStorageCapabilities(target.provider.name);
    if (!capabilities.share || !target.provider.createShareLink) throw new FileOperationError('SHARE_UNSUPPORTED', 'This storage provider does not support sharing.');
    if (password && !capabilities.sharePassword) throw new FileOperationError('SHARE_PASSWORD_UNSUPPORTED', 'This provider does not support share passwords.');
    if (expiration && !capabilities.shareExpiration) throw new FileOperationError('SHARE_EXPIRATION_UNSUPPORTED', 'This provider does not support share expiration.');
    if (expiration && Date.parse(expiration) <= Date.now()) throw new FileOperationError('INVALID_EXPIRATION', 'Share expiration must be in the future.');
    const result = await target.provider.createShareLink(file.path, password, expiration);
    if (result.error) throw new FileOperationError('SHARE_FAILED', 'Storage provider could not create the share.');
    return { url: result.link, expiration: expiration ?? null, providerManaged: true };
}

export async function deleteTargetFile(target: StorageTargetSnapshot, id: string) {
    if (!buildStorageCapabilities(target.provider.name).userDelete) {
        throw new FileOperationError('USER_DELETE_UNSUPPORTED', 'This storage provider does not permit user deletion.');
    }
    return withStorageAccountOperationLease(pool, target.accountId, 'file_delete', async () => {
        const file = await requireTargetFile(target, id);
        const scope = fileScope(target);
        const diagnosticId = randomUUID();
        let physicalFailureCode: string | undefined;
        const deletion = createFileDeletionService({
            onFailure: (error, stage) => {
                const code = (error as { code?: unknown } | null)?.code;
                if (stage === 'physical' && (code === 'DELETE_FORBIDDEN' || code === 'DELETE_NOT_CONFIRMED')) physicalFailureCode = code;
                console.error(JSON.stringify({ event: 'file.deletion_failed', diagnosticId, stage,
                    code: typeof code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(code) ? code : undefined }));
            },
            // Logical folder markers have no separately uploaded object. Deleting a
            // WebDAV collection here would also delete unconfirmed descendants.
            removePhysicalFile: file.name === '.folder' && file.mime_type === 'application/x-directory'
                ? async () => undefined : removePhysicalFile,
            deleteIndex: async fileId => {
            const result = await query(`DELETE FROM files WHERE ${scope.clause} AND id = ${nextParam(scope, 1)}::uuid`, [...scope.params, fileId]);
            return result.rowCount === 1;
        } });
        const result = await deletion.deleteIndexedFile(file);
        if (result.status === 'failed') throw new FileOperationError(physicalFailureCode || 'DELETE_FAILED',
            physicalFailureCode === 'DELETE_FORBIDDEN'
                ? 'The storage account does not permit deleting this file. The file index is retained.'
                : physicalFailureCode === 'DELETE_NOT_CONFIRMED'
                    ? 'The provider did not confirm deletion. The file index is retained.'
                    : 'Physical deletion or index removal failed; the remaining index is retained for retry.', { diagnosticId });
        return { id, status: result.status };
    });
}
