import { apiJson } from '../httpClient';
import { getApiHeaders } from './clientHeaders';

export interface McpStorage { id: string; name: string; provider: string }
export interface McpClientInput { name: string; permissions: string[]; storageIds: string[]; expiresAt: string }
export interface McpClientRecord extends McpClientInput {
    id: string;
    revokedAt: string | null;
    createdAt: string;
    lastUsedAt: string | null;
}
export interface McpConfiguration {
    enabled: boolean;
    endpoint: string;
    authMode: 'bearer';
    permissions: string[];
    storages: McpStorage[];
    clients: McpClientRecord[];
}
export interface McpAuditEntry {
    id: string;
    clientName: string | null;
    tool: string;
    storageId: string | null;
    status: string;
    code: string | null;
    durationMs: number;
    createdAt: string;
}
export interface McpConnectionResult {
    server: { name: string; version: string };
    toolCount: number;
    storages: McpStorage[];
}

function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return apiJson<T>(`/api/mcp/admin${path}`, {
        method,
        credentials: 'include',
        cache: 'no-store',
        headers: getApiHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

export const mcpClient = {
    getConfiguration: () => request<McpConfiguration>(''),
    setEnabled: (enabled: boolean) => request<unknown>('', 'PATCH', { enabled }),
    createClient: (input: McpClientInput) => request<{ client: McpClientRecord; token: string }>('/clients', 'POST', input),
    updateClient: (id: string, input: McpClientInput) => request<unknown>(`/clients/${encodeURIComponent(id)}`, 'PATCH', input),
    revokeClient: (id: string) => request<unknown>(`/clients/${encodeURIComponent(id)}`, 'DELETE'),
    verify: (token: string) => request<McpConnectionResult>('/verify', 'POST', { token }),
    listAudit: (offset: number, limit: number) => request<{ items: McpAuditEntry[]; total: number }>(`/audit?offset=${offset}&limit=${limit}`),
};
