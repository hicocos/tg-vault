import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { lockStorageAccountForUse } from './storageAccountLifecycle.js';

type LeaseClient = Pick<PoolClient, 'query'>;

export async function acquireStorageAccountLease(
    client: LeaseClient,
    accountId: string,
    purpose: string,
    ttlMs = 30 * 60 * 1000,
): Promise<string> {
    await lockStorageAccountForUse(client, accountId);
    const leaseId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ttlMs);
    const result = await client.query(
        `INSERT INTO storage_account_leases (id, storage_account_id, purpose, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [leaseId, accountId, purpose, expiresAt],
    );
    return String(result.rows[0]?.id || leaseId);
}

export async function releaseStorageAccountLease(client: LeaseClient, leaseId: string): Promise<void> {
    await client.query(
        'UPDATE storage_account_leases SET released_at = NOW() WHERE id = $1 AND released_at IS NULL',
        [leaseId],
    );
}
