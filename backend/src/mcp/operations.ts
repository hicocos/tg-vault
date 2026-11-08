import { randomBytes, randomUUID } from 'node:crypto';
import { query } from '../db/index.js';
import { mutationLockPool } from './lockPool.js';
import { encryptCredential, decryptCredential } from '../utils/credentialCrypto.js';
import { McpError, type McpContext, type McpPrincipal, type McpTool } from './contracts.js';
import { hashMcpSecret, resolveMcpTarget } from './security.js';

export type McpOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string; retryable?: boolean; recovery?: string; details?: Record<string, unknown> } };

const recoveryHints: Record<string, { retryable: boolean; recovery: string }> = {
    UNAUTHORIZED: { retryable: false, recovery: 'Use a valid, unexpired dedicated MCP client token.' },
    FORBIDDEN: { retryable: false, recovery: 'Check the client permissions and storage scope in AI access settings.' },
    MCP_DISABLED: { retryable: false, recovery: 'Enable MCP in AI access settings before reconnecting.' },
    RATE_LIMITED: { retryable: true, recovery: 'Wait for the indicated cooldown before retrying.' },
    REQUEST_IN_PROGRESS: { retryable: true, recovery: 'Poll requests_status or retry identical arguments with the same requestId.' },
    UPLOAD_BUSY: { retryable: true, recovery: 'Wait for the current upload operation to finish, then inspect upload_status before retrying.' },
    UPLOAD_CANCELLED: { retryable: false, recovery: 'This upload session was cancelled. Prepare a new upload session and send its bytes before committing.' },
    UPLOAD_NOT_READY: { retryable: false, recovery: 'Send all declared bytes using upload_write or the ticket upload channel, continue at its confirmed nextOffset, then commit with a new requestId.' },
    UPLOAD_TICKET_EXPIRED: { retryable: false, recovery: 'Call upload_ticket with the same uploadId and a fresh requestId to renew automatically, then query its statusUrl and continue at nextOffset. No new user confirmation or long-lived Bearer token is needed.' },
    UPLOAD_OFFSET_CONFLICT: { retryable: false, recovery: 'Query the ticket statusUrl for the confirmed nextOffset. Retry identical confirmed chunks only, or continue at that offset; do not append conflicting bytes.' },
    CHUNK_HASH_MISMATCH: { retryable: true, recovery: 'The current chunk was not confirmed. Query nextOffset and resend that exact source range with its correct SHA-256.' },
    FILE_HASH_MISMATCH: { retryable: false, recovery: 'Verify the original file and its declared SHA-256. Resend the complete correct file using the same ticket URL without Content-Range, or prepare a new upload; do not commit the mismatched content.' },
    CHUNK_TOO_LARGE: { retryable: false, recovery: 'Split the source into chunks no larger than ticketUpload.chunkMaxBytes, compute each chunk SHA-256 and continue at the confirmed nextOffset.' },
    RECONCILIATION_REQUIRED: { retryable: false, recovery: 'Inspect upload_status, then preview and confirm upload_reconcile to check the uncertain storage write. Do not resend bytes or create a duplicate upload before reconciliation.' },
    REQUEST_INTERRUPTED: { retryable: false, recovery: 'Inspect requests_status and the affected files or tasks before deciding whether a new request is needed.' },
    IDEMPOTENCY_CONFLICT: { retryable: false, recovery: 'Use the original arguments for this requestId, or a new requestId for a different operation.' },
    CONFIRMATION_REQUIRED: { retryable: false, recovery: 'Preview with dryRun=true, then execute the authorized operation with its confirmationToken and a requestId.' },
    CONFIRMATION_INVALID: { retryable: false, recovery: 'Generate a fresh preview and check its changed scope before executing.' },
    INVALID_STATE: { retryable: false, recovery: 'Refresh the object or task and choose one of its currently allowedActions.' },
    TASK_FINISHED: { retryable: false, recovery: 'This task has finished. Refresh its details and use its allowedActions; adding source information will not make pause or resume available.' },
    VERSION_CONFLICT: { retryable: false, recovery: 'Read the current object version, review the changes and submit updated arguments.' },
    FILE_NOT_FOUND: { retryable: false, recovery: 'Check that storageAccountId and fileId refer to the same authorized storage account. Run files_search in that account and use a returned fileId.' },
    DELETE_FORBIDDEN: { retryable: false, recovery: 'Check the storage account deletion permissions. Google Drive deletion uses the trash and does not require permanent deletion permission. The file index is retained.' },
    DELETE_NOT_CONFIRMED: { retryable: false, recovery: 'Inspect the exact provider object before retrying. Google Drive must confirm that the file is in trash; its index has been retained.' },
    FOLDER_NOT_FOUND: { retryable: false, recovery: 'List folders in the selected storage account and use an existing destination path.' },
    NOT_FOUND: { retryable: false, recovery: 'Refresh the relevant list in the authorized storage scope and use the returned object identifier.' },
    NOT_A_FILE: { retryable: false, recovery: 'Select a regular file from files_search; use folder tools for directory records.' },
    UNSUPPORTED_TEXT_TYPE: { retryable: false, recovery: 'Use files_link to download this document; native text reading supports UTF-8 text files.' },
    UNSUPPORTED_ENCODING: { retryable: false, recovery: 'Use files_link to download the file and decode its original encoding; native text reading supports UTF-8 only.' },
    BINARY_CONTENT: { retryable: false, recovery: 'Use files_link to download this binary file instead of reading it as text.' },
    MEDIA_UNAVAILABLE: { retryable: false, recovery: 'Refresh files_get in the selected storage account and check that its source file is still available.' },
    READ_FAILED: { retryable: true, recovery: 'Retry the same text page. If reading still fails, check the selected storage and use files_link to download the file.' },
    READ_TIMEOUT: { retryable: true, recovery: 'Retry the same text page with its offset and expectedVersion. Read-only calls do not need a requestId.' },
    FILE_CHANGED: { retryable: false, recovery: 'Restart text reading at offset 0 without expectedVersion, then use the returned version for subsequent pages.' },
    INVALID_OFFSET: { retryable: false, recovery: 'Use nextOffset from the preceding text page so the offset starts at a UTF-8 character boundary.' },
    OFFSET_OUT_OF_RANGE: { retryable: false, recovery: 'Use nextOffset from the preceding text page, or restart at offset 0. An offset equal to the current file length returns an empty final page.' },
    RANGE_UNSUPPORTED: { retryable: false, recovery: 'Use files_link to download the complete file; this storage cannot provide reliable text pagination.' },
    INVALID_RANGE_RESPONSE: { retryable: true, recovery: 'Retry this read-only page; if the storage keeps returning inconsistent ranges, use files_link.' },
};

export function safeMcpError(error: unknown, recordedMutation = false): McpOutcome & { ok: false } {
    const requestRecovery = recordedMutation
        ? ' This failed mutation is recorded. Inspect requests_status and the affected object before retrying; a corrected mutation requires a new requestId.' : '';
    if (error instanceof McpError) {
        const hint = recoveryHints[error.code] || { retryable: false, recovery: 'Resolve the reported condition and refresh the affected object before submitting again.' };
        return { ok: false, error: { code: error.code, message: error.message,
            retryable: hint.retryable, recovery: hint.recovery + requestRecovery,
            ...(error.details ? { details: error.details } : {}) } };
    }
    // Provider/database exception messages may contain URLs, paths or credentials.
    const diagnosticId = randomUUID();
    const candidate = error as { name?: unknown; code?: unknown } | null;
    const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(value) ? value : undefined;
    console.error(JSON.stringify({ event: 'mcp.operation_failed', diagnosticId, name: safeCode(candidate?.name), code: safeCode(candidate?.code) }));
    return { ok: false, error: { code: 'OPERATION_FAILED', message: 'The operation failed. Find diagnosticId in the server log.',
        retryable: false, recovery: 'Inspect the affected storage or object and use diagnosticId to locate the failure in the server log.' + requestRecovery, details: { diagnosticId } } };
}

function canonical(value: unknown): string {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    return JSON.stringify(value);
}

function operationHash(input: Record<string, unknown>): string {
    const { requestId: _request, dryRun: _dry, confirmationToken: _confirmation, ...args } = input;
    return hashMcpSecret(canonical(args));
}

export async function recordMcpAudit(clientId: string | null, tool: string, storageId: string | null, status: string, code: string | null, durationMs: number) {
    await query('INSERT INTO mcp_audit (client_id,tool,storage_id,status,code,duration_ms) VALUES ($1,$2,$3,$4,$5,$6)',
        [clientId, tool, storageId, status, code, durationMs]);
}

async function confirmed(tool: McpTool, context: McpContext, input: Record<string, any>, inputHash: string): Promise<void> {
    if (!tool.destructive) return;
    if (!input.confirmationToken || !tool.preview) throw new McpError('CONFIRMATION_REQUIRED', 'Call this tool with dryRun=true, show the preview to the user, then pass its confirmationToken.');
    const preview = await tool.preview(context, input);
    const result = await query(`DELETE FROM mcp_confirmations WHERE token_hash=$1 AND client_id=$2 AND tool=$3
        AND storage_id=$4 AND input_hash=$5 AND preview_hash=$6 AND expires_at>NOW() RETURNING token_hash`,
    [hashMcpSecret(input.confirmationToken), context.client.id, tool.name, context.storageId, inputHash, hashMcpSecret(canonical(preview))]);
    if (!result.rowCount) throw new McpError('CONFIRMATION_INVALID', 'Confirmation expired, was consumed, or the requested operation/preview changed. Generate a new preview.');
    context.confirmedPreview = preview;
}

async function mutate(tool: McpTool, context: McpContext, input: Record<string, any>): Promise<McpOutcome> {
    if (!input.requestId) throw new McpError('REQUEST_ID_REQUIRED', 'Every mutation requires a unique requestId. Reuse it only when retrying the identical request.');
    const inputHash = operationHash(input);
    const client = await mutationLockPool.connect();
    const lockKey = `mcp:${context.client.id}:${input.requestId}`;
    let locked = false;
    try {
        locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [lockKey])).rows[0].acquired;
        if (!locked) throw new McpError('REQUEST_IN_PROGRESS', 'This request is already running. Retry with the same requestId.');
        const previous = (await client.query('SELECT * FROM mcp_requests WHERE client_id=$1 AND request_id=$2', [context.client.id, input.requestId])).rows[0];
        if (previous) {
            if (previous.tool !== tool.name || previous.input_hash !== inputHash) throw new McpError('IDEMPOTENCY_CONFLICT', 'requestId was already used for different arguments or another tool.');
            if (previous.result) return JSON.parse(decryptCredential(previous.result.encrypted)) as McpOutcome;
            if (tool.recover) {
                const recovered = await tool.recover(context, input);
                if (recovered) {
                    const outcome: McpOutcome = { ok: true, data: recovered };
                    await client.query("UPDATE mcp_requests SET status='completed',result=$3,updated_at=NOW() WHERE client_id=$1 AND request_id=$2",
                        [context.client.id, input.requestId, { encrypted: encryptCredential(JSON.stringify(outcome)) }]);
                    return outcome;
                }
            }
            await client.query("UPDATE mcp_requests SET status='interrupted',updated_at=NOW() WHERE client_id=$1 AND request_id=$2", [context.client.id, input.requestId]);
            throw new McpError('REQUEST_INTERRUPTED', 'The earlier operation stopped before recording its result. Inspect tasks/files before starting a new request; it will not be repeated automatically.');
        }
        await confirmed(tool, context, input, inputHash);
        await client.query(`INSERT INTO mcp_requests (client_id,request_id,tool,storage_id,input_hash,status)
            VALUES ($1,$2,$3,$4,$5,'running')`, [context.client.id, input.requestId, tool.name, context.storageId, inputHash]);
        let outcome: McpOutcome;
        try {
            outcome = { ok: true, data: await tool.run(context, input) };
        } catch (error) {
            outcome = safeMcpError(error, true);
        }
        await client.query('UPDATE mcp_requests SET status=$3,result=$4,updated_at=NOW() WHERE client_id=$1 AND request_id=$2',
            [context.client.id, input.requestId, outcome.ok ? 'completed' : 'failed', { encrypted: encryptCredential(JSON.stringify(outcome)) }]);
        return outcome;
    } finally {
        try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]); }
        finally { client.release(); }
    }
}

export async function executeMcpTool(tool: McpTool, principal: McpPrincipal, input: Record<string, any>): Promise<McpOutcome> {
    const started = Date.now();
    let outcome: McpOutcome;
    try {
        const context = await resolveMcpTarget(principal, input.storageAccountId, tool.permission);
        context.requestId = input.requestId;
        if (input.dryRun) {
            if (!tool.preview) throw new McpError('PREVIEW_UNSUPPORTED', 'This tool does not have a preview.');
            const preview = await tool.preview(context, input);
            let confirmation: Record<string, unknown> = {};
            if (tool.destructive) {
                const token = randomBytes(32).toString('base64url');
                const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
                await query(`INSERT INTO mcp_confirmations (token_hash,client_id,tool,storage_id,input_hash,preview_hash,expires_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [hashMcpSecret(token), principal.id, tool.name, context.storageId, operationHash(input), hashMcpSecret(canonical(preview)), expiresAt]);
                confirmation = { confirmationToken: token, confirmationExpiresAt: expiresAt };
            }
            outcome = { ok: true, data: { ...preview, dryRun: true, ...confirmation } };
        } else {
            outcome = tool.mutation ? await mutate(tool, context, input) : { ok: true, data: await tool.run(context, input) };
        }
    } catch (error) {
        outcome = safeMcpError(error);
    }
    await recordMcpAudit(principal.id, tool.name, input.storageAccountId, outcome.ok ? (input.dryRun ? 'preview' : 'success') : 'error', outcome.ok ? null : outcome.error.code, Date.now() - started);
    return outcome;
}

export async function cleanupMcpRecords(): Promise<void> {
    await query('DELETE FROM mcp_confirmations WHERE expires_at <= NOW()');
    await query('DELETE FROM mcp_media_links WHERE expires_at <= NOW()');
    await query("DELETE FROM mcp_audit WHERE created_at < NOW() - INTERVAL '90 days'");
    // Request identities remain durable: expiring them could replay old side effects.
}
