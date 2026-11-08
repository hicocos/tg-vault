import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// This process owns only the protocol bridge: no database, Bot, or worker imports.
async function main(): Promise<void> {
    const token = process.env.TG_VAULT_MCP_TOKEN;
    const endpoint = process.env.TG_VAULT_MCP_URL;
    if (!token || !endpoint) throw new Error('Set TG_VAULT_MCP_URL and TG_VAULT_MCP_TOKEN.');
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('TG_VAULT_MCP_URL must use HTTPS (loopback HTTP is allowed) and contain no credentials or query.');
    }
    const client = new Client({ name: 'tg-vault-stdio', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const handle = serveStdio(() => {
        const server = new Server(client.getServerVersion() || { name: 'tg-vault', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: client.getInstructions() });
        server.setRequestHandler('tools/list', request => client.listTools(request.params));
        server.setRequestHandler('tools/call', request => client.callTool(request.params));
        return server;
    }, { onerror: () => console.error('MCP stdio protocol error.') });
    const close = async () => { await handle.close(); await client.close(); };
    process.stdin.once('end', () => { void close(); });
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
}

main().catch(() => { console.error('TG Vault MCP connection failed. Check endpoint, dedicated MCP token, enabled state and backend availability.'); process.exitCode = 1; });
