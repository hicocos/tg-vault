import { Router, type Request, type Response, type NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, hostHeaderValidation } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { requireAuth } from './auth.js';
import { query } from '../db/index.js';
import { setSetting } from '../utils/settings.js';
import { McpError, MCP_PERMISSIONS } from '../mcp/contracts.js';
import { authenticateMcpToken, clientSchema, isMcpEnabled, listMcpClients, listMcpStorages, mcpEndpoint, revokeMcpClient, saveMcpClient } from '../mcp/security.js';
import { createMcpServer, mcpTools } from '../mcp/server.js';
import { recordMcpAudit, safeMcpError } from '../mcp/operations.js';
import { handleMcpMedia } from '../mcp/media.js';
import { handleMcpUploadPut, handleMcpUploadContentPut, handleMcpUploadContentGet } from '../mcp/uploads.js';

function sendError(res: Response, error: unknown): void {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid parameters.', code: 'INVALID_ARGUMENT', fields: error.issues.map(issue => issue.path.join('.')) });
        return;
    }
    const result = safeMcpError(error);
    const code = result.error.code;
    const status = code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'MCP_DISABLED' ? 503 : code === 'NOT_FOUND' ? 404 : code === 'INVALID_ARGUMENT' ? 400 : 500;
    if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="tg-vault-mcp", error="invalid_token"');
    res.status(status).json({ error: result.error.message, code });
}

function browserAndHostGuard(req: Request, res: Response, next: NextFunction): void {
    try {
        const endpoint = new URL(mcpEndpoint());
        if (!hostHeaderValidation([endpoint.hostname, 'localhost', '127.0.0.1', '[::1]'])(req, res)) return;
        const allowedOrigins = [endpoint.origin, ...(process.env.CORS_ORIGIN || '').split(',').map(origin => origin.trim()).filter(origin => origin && origin !== '*')];
        if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
            res.status(403).json({ error: 'Origin not allowed', code: 'FORBIDDEN' });
            return;
        }
        res.set('Cache-Control', 'no-store');
        next();
    } catch (error) { sendError(res, error); }
}

export const mcpRouter = Router();
mcpRouter.use(browserAndHostGuard);
mcpRouter.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'MCP request rate exceeded. Retry after the indicated delay.', code: 'RATE_LIMITED' } }));
mcpRouter.get('/media/:fileId/:purpose', (req, res, next) => { void handleMcpMedia(req, res).catch(next); });
mcpRouter.put('/uploads/:id', (req, res, next) => { void handleMcpUploadPut(req, res).catch(next); });
mcpRouter.put('/uploads/:id/content', (req, res, next) => { void handleMcpUploadContentPut(req, res).catch(next); });
mcpRouter.get('/uploads/:id/content', (req, res, next) => { void handleMcpUploadContentGet(req, res).catch(next); });
mcpRouter.all('/', async (req, res) => {
    try {
        const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || '');
        if (!match) throw new McpError('UNAUTHORIZED', 'A dedicated MCP Bearer token is required.');
        const principal = await authenticateMcpToken(match[1]);
        const toolName = req.body?.method === 'tools/call' ? req.body?.params?.name : undefined;
        const tool = typeof toolName === 'string' ? mcpTools.find(item => item.name === toolName) : undefined;
        if (tool && !principal.permissions.includes(tool.permission)) {
            await recordMcpAudit(principal.id, tool.name, null, 'error', 'FORBIDDEN', 0);
            res.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${tool.permission}"`);
            throw new McpError('FORBIDDEN', `Required permission: ${tool.permission}`);
        }
        const handler = createMcpHandler(() => createMcpServer(principal));
        res.once('close', () => { void handler.close(); });
        await toNodeHandler(handler)(req, res, req.body);
    } catch (error) { sendError(res, error); }
});

export const mcpAdminRouter = Router();
mcpAdminRouter.use(requireAuth);
mcpAdminRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
mcpAdminRouter.get('/', async (_req, res) => {
    try {
        const [enabled, clients, storages] = await Promise.all([isMcpEnabled(), listMcpClients(), listMcpStorages()]);
        res.json({ enabled, clients, storages, permissions: MCP_PERMISSIONS, endpoint: mcpEndpoint(), authMode: 'bearer' });
    } catch (error) { sendError(res, error); }
});
mcpAdminRouter.patch('/', async (req, res) => {
    try {
        const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
        if (enabled) mcpEndpoint();
        await setSetting('mcp_enabled', String(enabled));
        res.json({ enabled });
    } catch (error) { sendError(res, error); }
});
mcpAdminRouter.post('/clients', async (req, res) => {
    try { res.status(201).json(await saveMcpClient(clientSchema.parse(req.body))); }
    catch (error) { sendError(res, error); }
});
mcpAdminRouter.patch('/clients/:id', async (req, res) => {
    try { res.json(await saveMcpClient(clientSchema.parse(req.body), z.uuid().parse(req.params.id))); }
    catch (error) { sendError(res, error); }
});
mcpAdminRouter.delete('/clients/:id', async (req, res) => {
    try { await revokeMcpClient(z.uuid().parse(req.params.id)); res.json({ success: true }); }
    catch (error) { sendError(res, error); }
});
mcpAdminRouter.get('/audit', async (req, res) => {
    try {
        const { limit, offset } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) }).parse(req.query);
        const [rows, count] = await Promise.all([
            query(`SELECT a.id::text,a.tool,a.storage_id AS "storageId",a.status,a.code,a.duration_ms AS "durationMs",a.created_at AS "createdAt", c.name AS "clientName"
                FROM mcp_audit a LEFT JOIN mcp_clients c ON c.id=a.client_id ORDER BY a.created_at DESC,a.id DESC LIMIT $1 OFFSET $2`, [limit, offset]),
            query('SELECT COUNT(*)::int AS count FROM mcp_audit'),
        ]);
        res.json({ items: rows.rows, total: count.rows[0].count });
    } catch (error) { sendError(res, error); }
});
mcpAdminRouter.delete('/audit/:id', async (req, res) => {
    try {
        const id = z.string().regex(/^[1-9]\d{0,18}$/).pipe(z.coerce.bigint<string>().max(9_223_372_036_854_775_807n)).parse(req.params.id);
        const result = await query('DELETE FROM mcp_audit WHERE id = $1', [id.toString()]);
        res.json({ deletedCount: result.rowCount });
    } catch (error) { sendError(res, error); }
});
mcpAdminRouter.delete('/audit', async (_req, res) => {
    try {
        const result = await query('DELETE FROM mcp_audit');
        res.json({ deletedCount: result.rowCount });
    } catch (error) { sendError(res, error); }
});
mcpAdminRouter.post('/verify', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }), async (req, res) => {
    const client = new Client({ name: 'tg-vault-settings-check', version: '1.0.0' });
    try {
        const { token } = z.object({ token: z.string().min(1).max(200) }).strict().parse(req.body);
        const principal = await authenticateMcpToken(token);
        // Fixed loopback endpoint avoids SSRF through user-supplied URLs or proxy headers.
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${process.env.PORT || 51947}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }), { timeout: 10_000 });
        const tools = await client.listTools();
        res.json({ server: client.getServerVersion(), toolCount: tools.tools.length, storages: await listMcpStorages(principal) });
    } catch (error) {
        // The Web session is already authenticated; this error belongs to the
        // credential being tested and must not sign the administrator out.
        if (error instanceof McpError && error.code === 'UNAUTHORIZED') {
            res.status(400).json({ error: error.message, code: error.code });
        } else sendError(res, error);
    }
    finally { await client.close(); }
});
