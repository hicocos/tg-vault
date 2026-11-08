import path from 'node:path';
import pg from 'pg';
import { pool } from '../db/index.js';
import type { IStorageProvider } from '../services/storage/contracts.js';
import { sanitizeFilename } from './telegramUtils.js';

export interface StoredNameReservation {
    storedName: string;
    release(): Promise<void>;
}

/** Keep the selected account/folder/name locked until the write and index settle. */
export async function reserveStoredName(
    provider: IStorageProvider,
    originalName: string,
    folder: string | null = null,
    storageAccountId: string | null = null,
): Promise<StoredNameReservation> {
    const sanitizedName = sanitizeFilename(originalName);
    const ext = path.extname(sanitizedName);
    const baseName = ext ? sanitizedName.slice(0, -ext.length) : sanitizedName;
    const normalizedFolder = folder?.replace(/^\/+|\/+$/g, '') || null;
    // Uploads hold these locks across network I/O. Do not occupy the query pool:
    // writers still need pooled connections to commit their file indexes.
    const client = new pg.Client(pool.options);
    let connectionError: Error | undefined;
    client.on('error', error => { connectionError = error; });
    let lockKey: string | undefined;
    try {
        await client.connect();
        for (let number = 0; ; number++) {
            if (connectionError) throw connectionError;
            const storedName = number === 0 ? sanitizedName : `${baseName}（${number}）${ext}`;
            const key = JSON.stringify(['stored-name', storageAccountId, normalizedFolder, storedName]);
            const locked = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [key]);
            if (!locked.rows[0].acquired) continue;
            lockKey = key;
            const indexed = await client.query(
                `SELECT 1 FROM files WHERE stored_name = $1
                 AND folder IS NOT DISTINCT FROM $2
                 AND storage_account_id IS NOT DISTINCT FROM $3::uuid LIMIT 1`,
                [storedName, normalizedFolder, storageAccountId],
            );
            if (!indexed.rowCount && !await provider.fileExists(storedName, normalizedFolder)) {
                let released: Promise<void> | undefined;
                return { storedName, release: () => released ??= (async () => {
                    try {
                        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
                    } finally {
                        await client.end();
                    }
                })() };
            }
            await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
            lockKey = undefined;
        }
    } catch (error) {
        if (lockKey) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
        await client.end().catch(() => undefined);
        throw error;
    }
}
