import { Router, Request, Response } from 'express';
import { query } from '../db/index.js';
import { getCurrentStorageScope, nextParam, removePhysicalFile } from '../utils/fileScope.js';
import { getAuthToken, requireAuth } from './auth.js';
import { createFileDeletionService, type FileDeletionResult, type IndexedFile } from '../services/fileDeletion.js';
import { logOperationalEvent } from '../services/operationalEvents.js';
import {
    batchDeleteConfirmationStore,
    type BatchDeleteStorageScope,
} from '../services/batchDeleteConfirmation.js';

const router = Router({ strict: true });

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
        const result = await query(
            `SELECT COUNT(DISTINCT id)::int AS file_count,
                    COUNT(DISTINCT id) FILTER (WHERE name <> '.folder')::int AS data_file_count,
                    COUNT(DISTINCT id) FILTER (WHERE name = '.folder')::int AS placeholder_count,
                    COUNT(DISTINCT folder) FILTER (WHERE folder = ANY(${nextParam(storageScope, 2)}::text[]))::int AS folder_count,
                    COALESCE(SUM(size) FILTER (WHERE name <> '.folder'), 0)::bigint AS total_size,
                    COALESCE(ARRAY_AGG(DISTINCT id), ARRAY[]::uuid[]) AS file_ids
             FROM files
             WHERE ${storageScope.clause}
               AND (id = ANY(${nextParam(storageScope, 1)}::uuid[]) OR folder = ANY(${nextParam(storageScope, 2)}::text[]))`,
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
    try {
        const { oldName, newName } = req.body;

        if (!oldName || !newName || typeof oldName !== 'string' || typeof newName !== 'string') {
            return res.status(400).json({ error: '参数错误' });
        }

        const trimmedNew = newName.trim();
        if (trimmedNew.length === 0) {
            return res.status(400).json({ error: '文件夹名不能为空' });
        }

        if (/[\/\\:*?"<>|]/.test(trimmedNew)) {
            return res.status(400).json({ error: '文件夹名包含非法字符' });
        }

        const scope = await getCurrentStorageScope();
        const checkResult = await query(
            `SELECT COUNT(*) as cnt FROM files WHERE ${scope.clause} AND folder = ${nextParam(scope, 1)}`,
            [...scope.params, oldName]
        );
        if (parseInt(checkResult.rows[0].cnt) === 0) {
            return res.status(404).json({ error: '文件夹不存在' });
        }

        if (trimmedNew !== oldName) {
            const existResult = await query(
                `SELECT COUNT(*) as cnt FROM files WHERE ${scope.clause} AND folder = ${nextParam(scope, 1)}`,
                [...scope.params, trimmedNew]
            );
            if (parseInt(existResult.rows[0].cnt) > 0) {
                return res.status(400).json({ error: '该文件夹名已存在' });
            }
        }

        await query(
            `UPDATE files SET folder = ${nextParam(scope, 1)} WHERE ${scope.clause} AND folder = ${nextParam(scope, 2)}`,
            [...scope.params, trimmedNew, oldName]
        );

        res.json({ success: true, name: trimmedNew });
    } catch (error) {
        console.error('重命名文件夹失败:', error);
        res.status(500).json({ error: '重命名文件夹失败' });
    }
});

router.patch('/move-folder', requireAuth, async (req: Request, res: Response) => {
    try {
        const { oldName, newName } = req.body;

        if (!oldName || typeof oldName !== 'string') {
            return res.status(400).json({ error: '原文件夹名称不能为空' });
        }

        if (newName !== null && typeof newName !== 'string') {
            return res.status(400).json({ error: '目标文件夹名称格式错误' });
        }

        const trimmedOld = oldName.trim();
        const trimmedNew = newName ? newName.trim() : null;

        if (trimmedNew && /[\/\\:*?"<>|]/.test(trimmedNew)) {
            return res.status(400).json({ error: '目标文件夹名包含非法字符' });
        }

        const scope = await getCurrentStorageScope();
        const checkResult = await query(
            `SELECT COUNT(*) as cnt FROM files WHERE ${scope.clause} AND folder = ${nextParam(scope, 1)}`,
            [...scope.params, trimmedOld]
        );
        if (parseInt(checkResult.rows[0].cnt) === 0) {
            return res.status(404).json({ error: '原文件夹不存在' });
        }

        await query(
            `UPDATE files SET folder = ${nextParam(scope, 1)}, updated_at = NOW() WHERE ${scope.clause} AND folder = ${nextParam(scope, 2)}`,
            [...scope.params, trimmedNew, trimmedOld]
        );

        res.json({ success: true, folder: trimmedNew });
    } catch (error) {
        console.error('移动文件夹失败:', error);
        res.status(500).json({ error: '移动文件夹失败' });
    }
});

export default router;
