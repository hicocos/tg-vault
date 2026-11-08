import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pool, query } from '../db/index.js';
import type { StorageTargetSnapshot, StorageWriteOptions } from './storage/contracts.js';
import { acquireStorageAccountOperationLease } from './storageAccountOperation.js';
import { assertStorageTargetWritable } from './storageCooldownGuard.js';
import { saveAndIndexWithCompensation } from './storageWrite.js';
import { reserveStoredName, type StoredNameReservation } from '../utils/fileUtils.js';
import { normalizeFolderPath } from '../utils/folderPath.js';
import { buildStorageFolderWithRules, getStoragePathRules } from '../utils/storagePath.js';
import { findDuplicateFile, getDuplicateMode } from '../utils/duplicatePolicy.js';
import { getFileType } from '../utils/fileMetadata.js';
import { enqueueMediaDerivatives } from './mediaDerivatives.js';

export interface IndexedUploadInput {
    target: StorageTargetSnapshot;
    source: 'web' | 'api';
    originalName: string;
    mimeType: string;
    size: number;
    tempPath: string;
    folder: string | null;
    fileId?: string;
    retainSourceOnFailure?: boolean;
    options?: StorageWriteOptions & {
        beforeSave?: (storedName: string, storedPath: string | null, resolvedFolder: string | null) => Promise<void>;
        onCompensated?: () => Promise<void>;
    };
}

export async function uploadIndexedFile(input: IndexedUploadInput) {
    const { target, originalName, mimeType, size, tempPath } = input;
    const { provider, accountId } = target;
    const requestedFolder = input.folder ? normalizeFolderPath(input.folder) : null;
    const storageFolder = buildStorageFolderWithRules({ source: input.source, folder: requestedFolder, mimeType, fileName: originalName }, await getStoragePathRules());
    const lease = await acquireStorageAccountOperationLease(pool, accountId, 'file_upload');
    let reservation: StoredNameReservation | undefined;
    let preserveDerivativeSource = false;
    let completed = false;
    try {
        input.options?.signal?.throwIfAborted();
        await assertStorageTargetWritable(target);
        if (await getDuplicateMode() === 'skip') {
            const duplicate = await findDuplicateFile(originalName, storageFolder, size, accountId);
            if (duplicate) { completed = true; return { success: true, skipped: true, reason: 'duplicate', file: {
                id: duplicate.id, name: duplicate.name, size: duplicate.size, folder: duplicate.folder, date: duplicate.created_at,
            } }; }
        }
        reservation = await reserveStoredName(provider, originalName, storageFolder, accountId);
        const { storedName } = reservation;
        const type = getFileType(mimeType);
        const derivativeStatus = type === 'image' || type === 'video' ? 'queued' : 'not_required';
        const fileId = input.fileId ?? randomUUID();
        let createdAt: Date;
        const storedPath = await saveAndIndexWithCompensation(provider, tempPath, storedName, mimeType, storageFolder, async savedPath => {
            const result = await query(`INSERT INTO files
                (id, name, stored_name, type, mime_type, size, path, source, folder, storage_account_id,
                 derivative_status, derivative_source_path, derivative_cleanup_source)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING created_at`,
            [fileId, originalName, storedName, type, mimeType, size, savedPath, provider.name, storageFolder, accountId,
                derivativeStatus, derivativeStatus === 'queued' ? (provider.name === 'local' ? savedPath : tempPath) : null,
                derivativeStatus === 'queued' && provider.name !== 'local']);
            createdAt = result.rows[0].created_at;
        }, { ...input.options, beforeSave: storedPath => input.options?.beforeSave?.(storedName, storedPath ?? null, storageFolder) ?? Promise.resolve() });
        preserveDerivativeSource = derivativeStatus === 'queued' && provider.name !== 'local';
        completed = true;
        if (derivativeStatus === 'queued') enqueueMediaDerivatives({ fileId, sourcePath: provider.name === 'local' ? storedPath : tempPath,
            storedName, mimeType, cleanupSource: provider.name !== 'local' });
        return { success: true, file: { id: fileId, name: originalName, type, size, derivativeStatus, date: createdAt!,
            source: provider.name, folder: storageFolder, storageAccountId: accountId,
            target: { provider: provider.name, accountId, folder: storageFolder } } };
    } finally {
        try { await reservation?.release(); }
        finally {
            await lease.release();
            if (!preserveDerivativeSource && (completed || !input.retainSourceOnFailure)) await fs.promises.rm(tempPath, { force: true });
        }
    }
}
