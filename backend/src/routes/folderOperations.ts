import { Router, Request, Response } from 'express';
import { pool, query } from '../db/index.js';
import type { PoolClient } from 'pg';
import { getCurrentStorageScope, nextParam, removePhysicalFile } from '../utils/fileScope.js';
import { getAuthToken, requireAuth } from './auth.js';
import { createFileDeletionService, type FileDeletionResult, type IndexedFile } from '../services/fileDeletion.js';
import { logOperationalEvent } from '../services/operationalEvents.js';
import {
    batchDeleteConfirmationStore,
    type BatchDeleteStorageScope,
} from '../services/batchDeleteConfirmation.js';
import {
    folderBaseName,
    folderParent,
    isFolderWithin,
    joinFolderPath,
    normalizeFolderName,
    normalizeFolderPath,
} from '../utils/folderPath.js';

const router = Router({ strict: true });

type QueryClient = Pick<PoolClient, 'query'>;

interface FolderMovePreview {
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

async function buildFolderMovePreview(
    db: QueryClient,
    oldPath: string,
    destinationParent: string | null,
    finalPath = joinFolderPath(destinationParent, folderBaseName(oldPath)),
    requireDestination = true,
): Promise<FolderMovePreview | null> {
    const scope = await getCurrentStorageScope();
    const sourceParam = nextParam(scope, 1);
    const source = await db.query(
        `SELECT COUNT(*) FILTER (WHERE name <> '.folder')::int AS file_count,
                COUNT(DISTINCT folder)::int AS folder_count,
                COALESCE(SUM(size) FILTER (WHERE name <> '.folder'), 0)::bigint AS total_size,
                MAX(LENGTH(folder) - LENGTH(${sourceParam}))::int AS max_suffix_length
         FROM files WHERE ${scope.clause}
           AND (folder = ${sourceParam} OR LEFT(folder, LENGTH(${sourceParam}) + 1) = ${sourceParam} || '/')`,
        [...scope.params, oldPath],
    );
    if (Number(source.rows[0]?.folder_count || 0) === 0) return null;

    let conflictReason: string | undefined;
    const noChange = finalPath === oldPath;
    if (destinationParent && isFolderWithin(destinationParent, oldPath)) {
        conflictReason = '不能把文件夹移动到自身或其子文件夹中';
    } else if (noChange) {
        conflictReason = '文件夹已经位于该位置';
    } else if (finalPath.length + Number(source.rows[0]?.max_suffix_length || 0) > 255) {
        conflictReason = '移动后的子文件夹路径超过 255 个字符';
    }

    if (!conflictReason && requireDestination && destinationParent) {
        const destinationParam = nextParam(scope, 1);
        const destination = await db.query(
            `SELECT 1 FROM files WHERE ${scope.clause}
             AND (folder = ${destinationParam} OR LEFT(folder, LENGTH(${destinationParam}) + 1) = ${destinationParam} || '/') LIMIT 1`,
            [...scope.params, destinationParent],
        );
        if (!destination.rows[0]) conflictReason = '目标文件夹不存在';
    }

    if (!conflictReason) {
        const targetParam = nextParam(scope, 1);
        const oldParam = nextParam(scope, 2);
        const existingTarget = await db.query(
            `SELECT 1 FROM files WHERE ${scope.clause}
             AND (folder = ${targetParam} OR LEFT(folder, LENGTH(${targetParam}) + 1) = ${targetParam} || '/')
             AND NOT (folder = ${oldParam} OR LEFT(folder, LENGTH(${oldParam}) + 1) = ${oldParam} || '/') LIMIT 1`,
            [...scope.params, finalPath, oldPath],
        );
        if (existingTarget.rows[0]) conflictReason = `目标路径 ${finalPath} 已存在`;
    }

    return {
        sourcePath: oldPath,
        destinationParent,
        finalPath,
        fileCount: Number(source.rows[0]?.file_count || 0),
        folderCount: Number(source.rows[0]?.folder_count || 0),
        totalSizeBytes: Number(source.rows[0]?.total_size || 0),
        conflict: !!conflictReason,
        conflictReason,
        noChange,
    };
}

async function updateFolderTree(db: QueryClient, oldPath: string, finalPath: string): Promise<number> {
    const scope = await getCurrentStorageScope();
    const oldParam = nextParam(scope, 1);
    const finalParam = nextParam(scope, 2);
    const result = await db.query(
        `UPDATE files
         SET folder = ${finalParam} || SUBSTRING(folder FROM LENGTH(${oldParam}) + 1), updated_at = NOW()
         WHERE ${scope.clause}
           AND (folder = ${oldParam} OR LEFT(folder, LENGTH(${oldParam}) + 1) = ${oldParam} || '/')`,
        [...scope.params, oldPath, finalPath],
    );
    return result.rowCount || 0;
}

async function getBatchDeleteScope(): Promise<BatchDeleteStorageScope> {
    const { storageManager } = await import('../services/storage.js');
    const target = storageManager.getActiveTarget();
    return { provider: target.provider.name, accountId: target.accountId };
}

function getAuthenticatedSessionToken(req: Request): string {
    const token = getAuthToken(req);
    if (!token) throw new Error('Authenticated session token is missing');
    return token;
}

async function deleteFileIndex(id: string): Promise<boolean> {
    const result = await query('DELETE FROM files WHERE id = $1', [id]);
    return result.rowCount === 1;
}

const deletionService = createFileDeletionService({
    removePhysicalFile,
    deleteIndex: deleteFileIndex,
});

function failedFile(file: IndexedFile, result: Extract<FileDeletionResult, { status: 'failed' }>) {
    return { id: file.id, name: file.name, error: result.error };
}

router.post('/batch-delete/preview', requireAuth, async (req: Request, res: Response) => {
    try {
        const { fileIds = [], folderNames = [] } = req.body;
        if (!Array.isArray(fileIds) || !Array.isArray(folderNames)) {
            return res.status(400).json({ error: '参数格式错误' });
        }
        if (fileIds.length === 0 && folderNames.length === 0) {
            return res.status(400).json({ error: '请提供要删除的文件或文件夹' });
        }

        const storageScope = await getCurrentStorageScope();
        const fileIdsParam = nextParam(storageScope, 1);
        const folderNamesParam = nextParam(storageScope, 2);
        const folderMatch = `EXISTS (
            SELECT 1 FROM UNNEST(${folderNamesParam}::text[]) selected_folder
            WHERE files.folder = selected_folder
               OR LEFT(files.folder, LENGTH(selected_folder) + 1) = selected_folder || '/'
        )`;
        const result = await query(
            `SELECT COUNT(DISTINCT id)::int AS file_count,
                    COUNT(DISTINCT id) FILTER (WHERE name <> '.folder')::int AS data_file_count,
                    COUNT(DISTINCT id) FILTER (WHERE name = '.folder')::int AS placeholder_count,
                    COUNT(DISTINCT folder) FILTER (WHERE ${folderMatch})::int AS folder_count,
                    COALESCE(SUM(size) FILTER (WHERE name <> '.folder'), 0)::bigint AS total_size,
                    COALESCE(ARRAY_AGG(DISTINCT id), ARRAY[]::uuid[]) AS file_ids
             FROM files
             WHERE ${storageScope.clause}
               AND (id = ANY(${fileIdsParam}::uuid[]) OR ${folderMatch})`,
            [...storageScope.params, fileIds, folderNames],
        );
        const row = result.rows[0] || {};
        const immutableFileIds: string[] = row.file_ids || [];
        if (immutableFileIds.length === 0) {
            return res.status(404).json({ error: '当前存储范围内没有找到待删除项目' });
        }

        const issued = batchDeleteConfirmationStore.issue({
            authToken: getAuthenticatedSessionToken(req),
            scope: await getBatchDeleteScope(),
            fileIds: immutableFileIds,
        });
        res.json({
            confirmationToken: issued.confirmationToken,
            fileCount: Number(row.file_count || 0),
            dataFileCount: Number(row.data_file_count || 0),
            placeholderCount: Number(row.placeholder_count || 0),
            folderCount: Number(row.folder_count || 0),
            totalSizeBytes: Number(row.total_size || 0),
            expiresAt: new Date(issued.expiresAt).toISOString(),
        });
    } catch (error) {
        console.error('获取批量删除影响范围失败:', error);
        res.status(500).json({ error: '获取删除影响范围失败' });
    }
});

router.post('/batch-delete', requireAuth, async (req: Request, res: Response) => {
    try {
        const { confirmationToken } = req.body;
        if (!confirmationToken || typeof confirmationToken !== 'string') {
            return res.status(400).json({ error: '缺少删除确认令牌', code: 'CONFIRMATION_REQUIRED' });
        }

        const consumed = batchDeleteConfirmationStore.consume(confirmationToken, {
            authToken: getAuthenticatedSessionToken(req),
            scope: await getBatchDeleteScope(),
        });
        if (consumed.status === 'expired') {
            return res.status(410).json({ error: '删除确认已过期，请重新预览', code: 'CONFIRMATION_EXPIRED' });
        }
        if (consumed.status === 'mismatch') {
            return res.status(409).json({ error: '删除确认与当前会话或存储范围不匹配', code: 'CONFIRMATION_MISMATCH' });
        }
        if (consumed.status === 'missing' || !consumed.confirmation) {
            return res.status(409).json({ error: '删除确认不存在或已使用', code: 'CONFIRMATION_REPLAYED' });
        }

        const fileIds = consumed.confirmation.fileIds;
        const storageScope = await getCurrentStorageScope();
        const selected = await query(
            `SELECT * FROM files WHERE ${storageScope.clause} AND id = ANY(${nextParam(storageScope, 1)}::uuid[])`,
            [...storageScope.params, fileIds],
        );
        const filesById = new Map<string, IndexedFile>(selected.rows.map((file: IndexedFile) => [file.id, file]));
        const deletedIds: string[] = [];
        const failedFiles: Array<{ id: string; name: string; error: string }> = [];

        for (const id of fileIds) {
            const file = filesById.get(id);
            if (!file) {
                // The object/index was deleted after preview. Treat that snapshot entry as idempotently complete.
                deletedIds.push(id);
                continue;
            }
            const outcome = await deletionService.deleteIndexedFile(file);
            if (outcome.status === 'failed') {
                console.error(`删除文件失败，保留数据库索引 (ID: ${file.id}):`, outcome.error);
                failedFiles.push(failedFile(file, outcome));
            } else {
                deletedIds.push(file.id);
            }
        }

        if (failedFiles.length > 0) {
            logOperationalEvent('files.batch-delete.partial', res.locals.requestId || null, {
                deletedCount: deletedIds.length,
                failedCount: failedFiles.length,
                storageScope: consumed.confirmation.scope,
            });
            return res.status(207).json({
                status: 'partial',
                deletedIds,
                failedFiles,
                message: `已删除 ${deletedIds.length} 个项目，${failedFiles.length} 个项目失败并保留索引`,
            });
        }
        res.json({
            status: 'complete',
            deletedIds,
            failedFiles: [],
            message: `成功删除 ${deletedIds.length} 个项目`,
        });
    } catch (error) {
        console.error('批量删除失败:', error);
        res.status(500).json({ error: '批量删除失败' });
    }
});

router.patch('/rename-folder', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
        const { oldName, newName } = req.body;

        if (!oldName || !newName || typeof oldName !== 'string' || typeof newName !== 'string') {
            return res.status(400).json({ error: '参数错误' });
        }

        let oldPath: string;
        let newSegment: string;
        try {
            oldPath = normalizeFolderPath(oldName);
            newSegment = normalizeFolderName(newName);
        } catch (error) {
            return res.status(400).json({ error: error instanceof Error ? error.message : '文件夹路径无效' });
        }
        const finalPath = joinFolderPath(folderParent(oldPath), newSegment);

        await client.query('BEGIN');
        const preview = await buildFolderMovePreview(client, oldPath, folderParent(oldPath), finalPath, false);
        if (!preview) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: '文件夹不存在' });
        }
        if (preview.conflict) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: preview.conflictReason, preview });
        }
        const updatedCount = await updateFolderTree(client, oldPath, finalPath);
        await client.query('COMMIT');

        res.json({ success: true, name: finalPath, updatedCount, preview });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error('重命名文件夹失败:', error);
        res.status(500).json({ error: '重命名文件夹失败' });
    } finally {
        client.release();
    }
});

router.post('/move-folder/preview', requireAuth, async (req: Request, res: Response) => {
    try {
        let oldPath: string;
        let destinationParent: string | null;
        try {
            oldPath = normalizeFolderPath(req.body?.oldName);
            destinationParent = req.body?.newName == null ? null : normalizeFolderPath(req.body.newName);
        } catch (error) {
            return res.status(400).json({ error: error instanceof Error ? error.message : '文件夹路径无效' });
        }
        const preview = await buildFolderMovePreview(pool, oldPath, destinationParent);
        if (!preview) return res.status(404).json({ error: '原文件夹不存在' });
        res.json(preview);
    } catch (error) {
        console.error('预览移动文件夹失败:', error);
        res.status(500).json({ error: '预览移动文件夹失败' });
    }
});

router.patch('/move-folder', requireAuth, async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
        const { oldName, newName } = req.body;

        if (!oldName || typeof oldName !== 'string') {
            return res.status(400).json({ error: '原文件夹名称不能为空' });
        }

        if (newName !== null && typeof newName !== 'string') {
            return res.status(400).json({ error: '目标文件夹名称格式错误' });
        }

        let oldPath: string;
        let destinationParent: string | null;
        try {
            oldPath = normalizeFolderPath(oldName);
            destinationParent = newName == null ? null : normalizeFolderPath(newName);
        } catch (error) {
            return res.status(400).json({ error: error instanceof Error ? error.message : '文件夹路径无效' });
        }

        await client.query('BEGIN');
        const preview = await buildFolderMovePreview(client, oldPath, destinationParent);
        if (!preview) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: '原文件夹不存在' });
        }
        if (preview.conflict) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: preview.conflictReason, preview });
        }
        const updatedCount = await updateFolderTree(client, oldPath, preview.finalPath);
        await client.query('COMMIT');

        res.json({ success: true, folder: preview.finalPath, updatedCount, preview });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error('移动文件夹失败:', error);
        res.status(500).json({ error: '移动文件夹失败' });
    } finally {
        client.release();
    }
});

export default router;
