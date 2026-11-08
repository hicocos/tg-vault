import pg from 'pg';
import { pool } from '../db/index.js';

// Session advisory locks live outside the business-query pool. A request can
// control a transfer while holding its own idempotency lock, so these pools
// must also remain separate from each other.
export const mutationLockPool = new pg.Pool({ ...pool.options, max: 4, application_name: 'tg-vault-mcp-requests' });
export const transferLockPool = new pg.Pool({ ...pool.options, max: 4, connectionTimeoutMillis: 5_000, application_name: 'tg-vault-mcp-transfers' });
for (const locks of [mutationLockPool, transferLockPool]) {
    locks.on('error', () => console.error('[MCP] Advisory lock database connection failed.'));
}

export async function closeMcpLockPools(): Promise<void> {
    await Promise.all([mutationLockPool.end(), transferLockPool.end()]);
}
