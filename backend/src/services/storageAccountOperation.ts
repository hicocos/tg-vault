import type { Pool } from 'pg';
import { acquireStorageAccountLease, releaseStorageAccountLease } from './storageAccountLease.js';

type OperationPool = Pick<Pool, 'query'>;
type OperationLeaseOptions = {
    ttlMs?: number;
    renewalIntervalMs?: number;
};

export interface StorageAccountOperationLease {
    readonly leaseId: string | null;
    release(): Promise<void>;
}

export async function withStorageAccountOperationLease<T>(
    pool: OperationPool,
    accountId: string | null,
    purpose: string,
    operation: () => Promise<T>,
    options: OperationLeaseOptions = {},
): Promise<T> {
    const lease = await acquireStorageAccountOperationLease(pool, accountId, purpose, options);
    try {
        return await operation();
    } finally {
        await lease.release();
    }
}

export async function acquireStorageAccountOperationLease(
    pool: OperationPool,
    accountId: string | null,
    purpose: string,
    options: OperationLeaseOptions = {},
): Promise<StorageAccountOperationLease> {
    if (!accountId) return { leaseId: null, release: async () => undefined };

    const ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    const renewalIntervalMs = options.renewalIntervalMs ?? Math.max(1_000, Math.floor(ttlMs / 3));
    const leaseId = await acquireStorageAccountLease(pool, accountId, purpose, ttlMs);

    let released = false;
    let renewalInFlight: Promise<void> | null = null;
    let renewalError: unknown = null;
    const renew = async () => {
        if (released) return;
        const expiresAt = new Date(Date.now() + ttlMs);
        const result = await pool.query(
            `UPDATE storage_account_leases
             SET expires_at = $2
             WHERE id = $1 AND released_at IS NULL
             RETURNING id`,
            [leaseId, expiresAt],
        );
        if ((result.rowCount || 0) !== 1) throw new Error(`storage account lease ${leaseId} was lost`);
    };
    const timer = setInterval(() => {
        renewalInFlight = renew().catch(error => {
            renewalError = error;
            console.error('[StorageLease] renewal failed:', error);
        });
    }, renewalIntervalMs);
    timer.unref();

    return {
        leaseId,
        release: async () => {
            if (released) return;
            released = true;
            clearInterval(timer);
            await renewalInFlight;
            try {
                await releaseStorageAccountLease(pool, leaseId);
            } catch (error) {
                // The external operation has already happened. Keep its result authoritative;
                // the durable lease expires naturally and this error remains observable.
                console.error('[StorageLease] release failed; durable lease will expire:', error);
            }
            if (renewalError) console.error('[StorageLease] operation completed after renewal failure:', renewalError);
        },
    };
}
