import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { pool, query } from '../db/index.js';
import { McpError, type McpContext, type McpTool } from './contracts.js';
import { transferLockPool } from './lockPool.js';
import { getMcpPrincipal, resolveMcpTarget } from './security.js';
import { FileOperationError, deleteTargetFile, findTargetFile } from '../services/scopedFiles.js';
import { lockStorageTargetForUse } from '../services/storageAccountLifecycle.js';
import { safeMcpError } from './operations.js';
import { taskActionAvailability, type TaskActionBlocks } from './taskActions.js';

const workers = new Set<string>();
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
interface BatchResult { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string; retryable?: boolean; recovery?: string; details?: Record<string,unknown> } }
interface BatchRow {
    id: string; client_id: string; storage_id: string; status: string; operation: string;
    items: { ids: string[]; preview: Record<string, unknown> }; results: BatchResult[];
    error_code: string | null; created_at: Date; updated_at: Date;
}

function view(row: BatchRow) {
    return { id: row.id, taskId: row.id, sourceType: 'mcp_file_batch', kind: 'mcp_file_batch',
        operation: row.operation, status: row.status, storageAccountId: row.storage_id,
        totalItems: row.items.ids.length, completedItems: row.results.filter(result => result.ok).length,
        failedItems: row.results.filter(result => !result.ok).length,
        progress: row.items.ids.length ? Math.floor(row.results.length / row.items.ids.length * 100) : 100,
        results: row.results, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function findBatch(ctx: McpContext, id: string): Promise<BatchRow> {
    if (!z.string().uuid().safeParse(id).success) throw new McpError('INVALID_ARGUMENT', 'Batch task ID must be a UUID.');
    const result = await query('SELECT * FROM mcp_file_batches WHERE id=$1 AND client_id=$2 AND storage_id=$3', [id,ctx.client.id,ctx.storageId]);
    if (!result.rows[0]) throw new McpError('BATCH_NOT_FOUND', 'Batch task not found for this client and storage account.');
    return result.rows[0];
}

function batchActions(ctx: McpContext, row: BatchRow) {
    const blocks: TaskActionBlocks = {};
    if (!['queued', 'running'].includes(row.status)) blocks.pause = 'INVALID_STATE';
    if (row.status !== 'paused') blocks.resume = 'TASK_NOT_PAUSED';
    if (!['partial', 'failed', 'blocked'].includes(row.status)) blocks.retry = 'INVALID_STATE';
    if (!['queued', 'running', 'paused', 'pause_requested', 'blocked', 'partial', 'failed'].includes(row.status)) blocks.cancel = 'INVALID_STATE';
    if (!ctx.client.permissions.includes('files:delete')) blocks.resume = blocks.retry = 'FORBIDDEN';
    return taskActionAvailability(ctx, blocks);
}

export async function getMcpFileBatch(ctx: McpContext, id: string) {
    const row = await findBatch(ctx, id);
    return { ...view(row), ...batchActions(ctx, row) };
}

export async function listMcpFileBatches(ctx: McpContext, input: { limit: number; offset: number }) {
    const result = await query('SELECT * FROM mcp_file_batches WHERE client_id=$1 AND storage_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4',
        [ctx.client.id,ctx.storageId,input.limit+1,input.offset]);
    return { tasks: result.rows.slice(0,input.limit).map(row => ({ ...view(row), ...batchActions(ctx, row) })), nextOffset: result.rows.length>input.limit ? input.offset+input.limit : null };
}

export async function enqueueFileDeletion(ctx: McpContext, requestedIds: string[] = []) {
    if (!ctx.confirmedPreview) throw new McpError('CONFIRMATION_REQUIRED', 'A confirmed deletion preview is required.');
    const files = ctx.confirmedPreview.files as Array<{ id: string }>;
    const ids = [...new Set([...requestedIds,...files.map(file=>file.id)])];
    if (!ids.length) throw new McpError('INVALID_ARGUMENT', 'There are no files to delete.');
    const client=await pool.connect();
    try {
        await client.query('BEGIN');
        await lockStorageTargetForUse(client,ctx.target.provider.name,ctx.target.accountId);
        const result = await client.query(`INSERT INTO mcp_file_batches (id,client_id,request_id,storage_id,operation,items,status)
            VALUES ($1,$2,$3,$4,'delete',$5::jsonb,'queued') RETURNING *`,
        [randomUUID(),ctx.client.id,ctx.requestId,ctx.storageId,JSON.stringify({ ids,preview:ctx.confirmedPreview })]);
        await client.query('COMMIT');
        schedule(result.rows[0].id);
        return view(result.rows[0]);
    } catch(error) { await client.query('ROLLBACK');throw error; }
    finally { client.release(); }
}

export async function recoverFileDeletion(ctx: McpContext) {
    const result = await query('SELECT * FROM mcp_file_batches WHERE client_id=$1 AND request_id=$2 AND storage_id=$3', [ctx.client.id,ctx.requestId,ctx.storageId]);
    return result.rows[0] ? view(result.rows[0]) : null;
}

async function processBatch(id: string) {
    if (workers.has(id)) return;
    workers.add(id);
    const lockClient = await transferLockPool.connect().catch(error=>{ workers.delete(id); throw error; });
    let locked = false;
    try {
        const lock = await lockClient.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`mcp-file-batch:${id}`]);
        if (!lock.rows[0].locked) return;
        locked = true;
        await query("UPDATE mcp_file_batches SET status='paused',updated_at=NOW() WHERE id=$1 AND status='pause_requested'", [id]);
        await query("UPDATE mcp_file_batches SET status='cancelled',updated_at=NOW() WHERE id=$1 AND status='cancel_requested'", [id]);
        const claim = await query("UPDATE mcp_file_batches SET status='running',error_code=NULL,updated_at=NOW() WHERE id=$1 AND status IN ('queued','running') RETURNING *", [id]);
        if (!claim.rows[0]) return;
        let row: BatchRow = claim.rows[0];
        const completed = new Set(row.results.map(result=>result.id));
        const confirmedIds=new Set((row.items.preview.files as Array<{id:string}>).map(file=>file.id));
        for (const fileId of row.items.ids) {
            if (completed.has(fileId)) continue;
            row = (await query('SELECT * FROM mcp_file_batches WHERE id=$1', [id])).rows[0];
            if (row.status !== 'running') break;
            let ctx: McpContext;
            try { ctx = await resolveMcpTarget(await getMcpPrincipal(row.client_id),row.storage_id,'files:delete'); }
            catch (error) {
                const code = error instanceof McpError ? error.code : 'AUTHORIZATION_CHECK_FAILED';
                await query('UPDATE mcp_file_batches SET status=$2,error_code=$3,updated_at=NOW() WHERE id=$1 AND status=\'running\'',
                    [id,code==='UNAUTHORIZED' ? 'cancelled' : 'blocked',code]);
                return;
            }
            let outcome: BatchResult;
            try {
                if(!confirmedIds.has(fileId)) throw new McpError('FILE_NOT_FOUND','File was not present in the confirmed storage scope.');
                const file = await findTargetFile(ctx.target,fileId);
                if (!file) {
                    const exists = await query('SELECT 1 FROM files WHERE id=$1', [fileId]);
                    if (exists.rowCount) throw new McpError('FILE_SCOPE_CHANGED', 'The file no longer belongs to the confirmed storage account.');
                    outcome = { id:fileId,ok:true,result:{ id:fileId,status:'already_deleted' } };
                } else outcome = { id:fileId,ok:true,result:await deleteTargetFile(ctx.target,fileId) };
            } catch (error) {
                const safe = safeMcpError(error instanceof FileOperationError ? new McpError(error.code,error.message,error.details) : error).error;
                outcome = { id:fileId,ok:false,error:error instanceof McpError || error instanceof FileOperationError ? safe : {...safe,code:'DELETE_FAILED'} };
            }
            await query('UPDATE mcp_file_batches SET results=results || $2::jsonb,updated_at=NOW() WHERE id=$1', [id,JSON.stringify([outcome])]);
        }
        await query("UPDATE mcp_file_batches SET status='paused',updated_at=NOW() WHERE id=$1 AND status='pause_requested'", [id]);
        await query("UPDATE mcp_file_batches SET status='cancelled',updated_at=NOW() WHERE id=$1 AND status='cancel_requested'", [id]);
        row = (await query('SELECT * FROM mcp_file_batches WHERE id=$1', [id])).rows[0];
        if (row.status === 'running') {
            const successes = row.results.filter(result=>result.ok).length;
            const status = successes===row.items.ids.length ? 'completed' : successes ? 'partial' : 'failed';
            await query('UPDATE mcp_file_batches SET status=$2,updated_at=NOW() WHERE id=$1 AND status=\'running\'', [id,status]);
        }
    } finally {
        try { if (locked) await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`mcp-file-batch:${id}`]); }
        finally {
            lockClient.release(); workers.delete(id);
            if(locked) {
                const pending=await query("SELECT 1 FROM mcp_file_batches WHERE id=$1 AND status='queued'",[id]);
                if(pending.rowCount) schedule(id);
            }
        }
    }
}

function schedule(id: string) { void processBatch(id).catch(()=>console.error('[MCP] File batch database operation failed; durable recovery will resume.')); }

export async function controlMcpFileBatch(ctx: McpContext, id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') {
    const row = await findBatch(ctx,id);
    const reason = batchActions(ctx, row).blockedActions[action];
    if (reason) throw new McpError(reason, 'This batch cannot perform the requested action. Refresh the task and follow its blockedActions reason.');
    let result;
    if (action === 'pause') result = await query(`UPDATE mcp_file_batches SET status=CASE WHEN status='queued' THEN 'paused' ELSE 'pause_requested' END,updated_at=NOW()
        WHERE id=$1 AND status IN ('queued','running') RETURNING *`, [id]);
    else if (action === 'cancel') result = await query(`UPDATE mcp_file_batches SET status=CASE WHEN status IN ('running','pause_requested') THEN 'cancel_requested' ELSE 'cancelled' END,updated_at=NOW()
        WHERE id=$1 AND status IN ('queued','running','paused','pause_requested','blocked','partial','failed') RETURNING *`, [id]);
    else {
        await resolveMcpTarget(ctx.client,ctx.storageId,'files:delete');
        if (action === 'resume') result = await query("UPDATE mcp_file_batches SET status='queued',error_code=NULL,updated_at=NOW() WHERE id=$1 AND status='paused' RETURNING *", [id]);
        else result = await query(`UPDATE mcp_file_batches SET status='queued',error_code=NULL,
            results=COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(results) item WHERE item->>'ok'='true'),'[]'::jsonb),updated_at=NOW()
            WHERE id=$1 AND status IN ('partial','failed','blocked') RETURNING *`, [id]);
    }
    if (!result.rows[0]) throw new McpError('INVALID_STATE', 'The requested action is not valid for this batch state.');
    if (result.rows[0].status==='queued') schedule(id);
    return view(result.rows[0]);
}

async function sweepBatches() {
    const result = await query("SELECT id FROM mcp_file_batches WHERE status IN ('queued','running','pause_requested','cancel_requested') ORDER BY updated_at,id LIMIT 100");
    for (const row of result.rows) schedule(row.id);
}

export async function recoverMcpFileBatches() {
    await sweepBatches();
    if (!recoveryTimer) {
        recoveryTimer=setInterval(()=>{ void sweepBatches().catch(()=>console.error('[MCP] File batch recovery query failed.')); },15_000);
        recoveryTimer.unref();
    }
}

export function stopMcpFileBatches() { if (recoveryTimer) clearInterval(recoveryTimer); recoveryTimer=null; }

export const fileBatchTools: McpTool[] = [{ name:'file_batch_status',permission:'files:delete',
    description:'Get durable progress and individual results for this client’s asynchronous file deletion batch. Partial failures retain failed files for an explicit retry through task controls.',
    inputSchema:{taskId:z.string().uuid()},run:async(ctx,input)=>({task:await getMcpFileBatch(ctx,input.taskId)}) }];
