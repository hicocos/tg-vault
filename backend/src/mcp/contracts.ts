import type { ZodRawShape } from 'zod';
import type { StorageTargetSnapshot } from '../services/storage/contracts.js';

export const MCP_PERMISSIONS = [
    'files:read', 'files:download', 'files:upload', 'files:write', 'files:delete', 'files:share',
    'tasks:read', 'tasks:control', 'subscriptions:read', 'subscriptions:write', 'subscriptions:delete', 'archive:write',
] as const;
export type McpPermission = typeof MCP_PERMISSIONS[number];

export interface McpPrincipal {
    id: string;
    name: string;
    permissions: McpPermission[];
    storageIds: string[];
    expiresAt: string;
}

export interface McpContext {
    client: McpPrincipal;
    storageId: string;
    target: StorageTargetSnapshot;
    requestId?: string;
    confirmedPreview?: Record<string, unknown>;
}

export class McpError extends Error {
    constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
        super(message);
        this.name = 'McpError';
    }
}

export interface McpTool {
    name: string;
    description: string;
    permission: McpPermission;
    inputSchema: ZodRawShape;
    mutation?: boolean;
    destructive?: boolean;
    // SDK validation is the external boundary; each tool owns the fields in its schema.
    run(context: McpContext, input: any): Promise<Record<string, unknown>>;
    preview?(context: McpContext, input: any): Promise<Record<string, unknown>>;
    recover?(context: McpContext, input: any): Promise<Record<string, unknown> | null>;
}
