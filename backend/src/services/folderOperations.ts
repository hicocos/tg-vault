import type { PoolClient } from 'pg';
import { nextParam, type StorageScope } from '../utils/fileScope.js';
import { folderBaseName, isFolderWithin, joinFolderPath } from '../utils/folderPath.js';

type QueryClient = Pick<PoolClient, 'query'>;

export interface FolderMovePreview {
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

export async function buildFolderMovePreview(
    db: QueryClient,
    scope: StorageScope,
    oldPath: string,
    destinationParent: string | null,
    finalPath = joinFolderPath(destinationParent, folderBaseName(oldPath)),
    requireDestination = true,
): Promise<FolderMovePreview | null> {
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

export async function updateFolderTree(db: QueryClient, scope: StorageScope, oldPath: string, finalPath: string): Promise<number> {
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
