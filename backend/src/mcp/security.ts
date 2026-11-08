import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query } from '../db/index.js';
import { storageManager } from '../services/storage.js';
import { STORAGE_COOLDOWN_REASON_DAILY_UPLOAD_LIMIT } from '../services/storageCooldown.js';
import { buildStorageCapabilities } from '../utils/storageProductContract.js';
import { McpError, MCP_PERMISSIONS, type McpContext, type McpPermission, type McpPrincipal } from './contracts.js';

export const storageIdSchema = z.union([z.literal('local'), z.uuid()]);
export const clientSchema = z.object({
    name: z.string().trim().min(1).max(100),
    permissions: z.array(z.enum(MCP_PERMISSIONS)).min(1).max(MCP_PERMISSIONS.length),
    storageIds: z.array(storageIdSchema).min(1).max(100),
    expiresAt: z.iso.datetime({ offset: true }).refine(value => Date.parse(value) > Date.now(), 'Expiry must be in the future'),
}).strict();

export function hashMcpSecret(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function mcpEndpoint(): string {
    const url = new URL(process.env.MCP_PUBLIC_URL || `http://localhost:${process.env.PORT || 51947}/mcp`);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/mcp')) {
        throw new McpError('CONFIGURATION_ERROR', 'MCP_PUBLIC_URL must be an HTTPS URL ending in /mcp (HTTP is allowed on loopback).');
    }
    return url.href;
}

export async function isMcpEnabled(): Promise<boolean> {
    const result = await query("SELECT value FROM system_settings WHERE key = 'mcp_enabled'");
    return result.rows[0]?.value === 'true';
}

function principal(row: Record<string, any>): McpPrincipal {
    return { id: row.id, name: row.name, permissions: row.permissions, storageIds: row.storage_ids, expiresAt: new Date(row.expires_at).toISOString() };
}

export async function getMcpPrincipal(id: string): Promise<McpPrincipal> {
    if (!await isMcpEnabled()) throw new McpError('MCP_DISABLED', 'MCP access is disabled.');
    const result = await query('SELECT * FROM mcp_clients WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW()', [id]);
    if (!result.rows[0]) throw new McpError('UNAUTHORIZED', 'The MCP client credential has expired or been revoked.');
    return principal(result.rows[0]);
}

export async function authenticateMcpToken(token: string): Promise<McpPrincipal> {
    if (!/^tgv_mcp_[A-Za-z0-9_-]{43}$/.test(token)) throw new McpError('UNAUTHORIZED', 'A dedicated MCP Bearer token is required.');
    if (!await isMcpEnabled()) throw new McpError('MCP_DISABLED', 'MCP access is disabled.');
    const result = await query(
        'UPDATE mcp_clients SET last_used_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW() RETURNING *',
        [hashMcpSecret(token)],
    );
    if (!result.rows[0]) throw new McpError('UNAUTHORIZED', 'The MCP client credential is invalid, expired or revoked.');
    return principal(result.rows[0]);
}

export async function resolveMcpTarget(client: McpPrincipal, storageId: string, permission: McpPermission): Promise<McpContext> {
    const current = await getMcpPrincipal(client.id);
    if (!current.permissions.includes(permission)) throw new McpError('FORBIDDEN', `Required permission: ${permission}`);
    if (!current.storageIds.includes(storageId)) throw new McpError('FORBIDDEN', 'This storage account is outside the client grant.');
    const parsed = storageIdSchema.safeParse(storageId);
    if (!parsed.success) throw new McpError('INVALID_ARGUMENT', 'storageAccountId must be local or an account UUID.');
    let provider = 'local';
    if (storageId !== 'local') {
        const result = await query('SELECT type FROM storage_accounts WHERE id = $1', [storageId]);
        if (!result.rows[0]) throw new McpError('NOT_FOUND', 'Storage account not found.');
        provider = result.rows[0].type;
    }
    return { client: current, storageId, target: storageManager.getTarget(provider, storageId === 'local' ? null : storageId) };
}

export async function listMcpStorages(client?: McpPrincipal) {
    const probeMaxAgeSeconds = 15 * 60;
    const now = Date.now();
    const result = await query(`SELECT s.id::text, s.name, s.type AS provider, s.last_probe_status, s.last_probed_at,
            c.reason AS cooldown_reason, c.cooldown_until
        FROM storage_accounts s
        LEFT JOIN storage_account_cooldowns c ON c.storage_account_id=s.id AND c.provider=s.type
            AND s.type='google_drive' AND c.reason=$1 AND c.cooldown_until>NOW()
        WHERE ($2::text[] IS NULL OR s.id::text=ANY($2::text[]))
        ORDER BY s.created_at, s.id`, [STORAGE_COOLDOWN_REASON_DAILY_UPLOAD_LIMIT, client?.storageIds ?? null]);
    const items = [
        ...(client && !client.storageIds.includes('local') ? [] : [{ id: 'local', name: 'Local storage', provider: 'local',
            last_probe_status: null, last_probed_at: null, cooldown_reason: null, cooldown_until: null }]),
        ...result.rows,
    ];
    const actionPermissions: Record<string, McpPermission> = {
        read: 'files:read', download: 'files:download', upload: 'files:upload',
        write: 'files:write', delete: 'files:delete', share: 'files:share',
    };
    return items.map(row => {
        const lastProbedAt = row.last_probed_at ? new Date(row.last_probed_at) : null;
        const capabilities = buildStorageCapabilities(row.provider);
        const providerCapabilities = { read: true, download: true, upload: true, write: true,
            delete: capabilities.userDelete, share: capabilities.share, sharePassword: capabilities.sharePassword,
            shareExpiration: capabilities.shareExpiration, quota: capabilities.quota };
        const allowedActions: string[] = [];
        const blockedActions: Record<string, string> = {};
        for (const [action, permission] of Object.entries(actionPermissions)) {
            if (client && !client.permissions.includes(permission)) blockedActions[action] = 'PERMISSION_REQUIRED';
            else if (action === 'delete' && !capabilities.userDelete) blockedActions[action] = 'USER_DELETE_UNSUPPORTED';
            else if (action === 'share' && !capabilities.share) blockedActions[action] = 'SHARE_UNSUPPORTED';
            else if (action === 'upload' && row.cooldown_until) blockedActions[action] = 'STORAGE_COOLDOWN';
            else allowedActions.push(action);
        }
        return { id: row.id, name: row.name, provider: row.provider, providerCapabilities, allowedActions, blockedActions,
            health: { source: 'cached' as const, probeStatus: row.last_probe_status,
                lastProbedAt: lastProbedAt?.toISOString() ?? null,
                stale: lastProbedAt === null || now - lastProbedAt.getTime() >= probeMaxAgeSeconds * 1000,
                maxAgeSeconds: probeMaxAgeSeconds,
                cooldownUntil: row.cooldown_until ? new Date(row.cooldown_until).toISOString() : null,
                cooldownReason: row.cooldown_reason } };
    });
}

function publicClient(row: Record<string, any>) {
    return { ...principal(row), createdAt: row.created_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at };
}

export async function listMcpClients() {
    const result = await query('SELECT id, name, permissions, storage_ids, expires_at, created_at, revoked_at, last_used_at FROM mcp_clients ORDER BY created_at DESC');
    return result.rows.map(publicClient);
}

export async function saveMcpClient(input: z.infer<typeof clientSchema>, id?: string) {
    const available = new Set((await listMcpStorages()).map(row => row.id));
    if (input.storageIds.some(value => !available.has(value))) throw new McpError('INVALID_ARGUMENT', 'A selected storage account no longer exists.');
    const values = [input.name, [...new Set(input.permissions)], [...new Set(input.storageIds)], input.expiresAt];
    if (id) {
        const result = await query(`UPDATE mcp_clients SET name=$1, permissions=$2, storage_ids=$3, expires_at=$4, updated_at=NOW()
            WHERE id=$5 AND revoked_at IS NULL RETURNING *`, [...values, id]);
        if (!result.rows[0]) throw new McpError('NOT_FOUND', 'Client not found or already revoked.');
        return { client: publicClient(result.rows[0]) };
    }
    const token = `tgv_mcp_${randomBytes(32).toString('base64url')}`;
    const result = await query(`INSERT INTO mcp_clients (name,permissions,storage_ids,expires_at,token_hash)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`, [...values, hashMcpSecret(token)]);
    return { client: publicClient(result.rows[0]), token };
}

export async function revokeMcpClient(id: string): Promise<void> {
    const result = await query('UPDATE mcp_clients SET revoked_at=COALESCE(revoked_at,NOW()), updated_at=NOW() WHERE id=$1', [id]);
    if (!result.rowCount) throw new McpError('NOT_FOUND', 'Client not found.');
}
