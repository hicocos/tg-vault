import { BinaryReader } from 'telegram/extensions/BinaryReader.js';
import { Api, type TelegramClient } from 'telegram';
import { query, pool } from '../db/index.js';
import type { StorageTargetSnapshot } from './storage.js';

export class TelegramQueueCapacityError extends Error {
    constructor() { super('Telegram 下载等待队列已满'); }
}

export interface OrdinaryFileRef {
    messageId: number;
    peer: string;
    fileName: string;
    mimeType: string;
    generatedName: boolean;
    groupedId?: string;
    status: 'pending' | 'downloading' | 'saving' | 'success' | 'failed' | 'cancelled';
    fileId?: string;
    error?: string;
    storedPath?: string;
    storedName?: string;
}
export interface RecoverableOrdinaryTask {
    id: string;
    owner_user_id: string;
    chat_id: string;
    target_provider: string;
    target_account_id: string | null;
    target_folder: string | null;
    status: string;
    payload: { ordinaryFiles: Record<string, OrdinaryFileRef> };
}

export async function rememberOrdinaryFile(groupId: string, message: Api.Message, target: StorageTargetSnapshot, info: { fileName: string; mimeType: string; generatedName?: boolean }, folder?: string | null): Promise<boolean> {
    const peer = await message.getInputChat();
    if (!(peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerChat || peer instanceof Api.InputPeerChannel || peer instanceof Api.InputPeerSelf)) {
        throw new Error('无法持久化 Telegram 文件来源聊天');
    }
    const groupedId = message.groupedId?.toString();
    const ref: OrdinaryFileRef = { messageId: message.id, peer: peer.getBytes().toString('base64'),
        fileName: info.fileName, mimeType: info.mimeType, generatedName: info.generatedName !== false, groupedId, status: 'pending' };
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(1413957171)');
        const duplicate = await client.query(`SELECT 1 FROM transfer_tasks WHERE source_type='telegram_bot' AND id=$1
            AND payload->'ordinaryFiles' ? $2::text`, [groupId, String(message.id)]);
        if (duplicate.rowCount) { await client.query('COMMIT'); return false; }
        const capacity = await client.query(`SELECT COUNT(*)::int AS count FROM transfer_tasks t,
            LATERAL jsonb_each(COALESCE(t.payload->'ordinaryFiles','{}'::jsonb)) f
            WHERE t.source_type='telegram_bot' AND t.status NOT IN ('completed','failed','cancelled')
              AND f.value->>'status' IN ('pending','downloading','saving')`);
        if (Number(capacity.rows[0].count) >= Number(process.env.TG_MAX_PENDING_FILES || 500)) throw new TelegramQueueCapacityError();
        const result = await client.query(`INSERT INTO transfer_tasks
        (source_type,id,kind,title,status,stage,owner_user_id,chat_id,target_provider,target_account_id,target_folder,total_items,payload)
        VALUES ('telegram_bot',$1,$2,$3,'pending','waiting',$4,$5,$6,$7,$8,1,jsonb_build_object('ordinaryFiles',jsonb_build_object($9::text,$10::jsonb)))
        ON CONFLICT (source_type,id) DO UPDATE SET
          payload=jsonb_set(transfer_tasks.payload,'{ordinaryFiles}',COALESCE(transfer_tasks.payload->'ordinaryFiles','{}'::jsonb)||(EXCLUDED.payload->'ordinaryFiles')),
          total_items=transfer_tasks.total_items+1,updated_at=NOW()
        WHERE NOT (COALESCE(transfer_tasks.payload->'ordinaryFiles','{}'::jsonb) ? $9::text)
        RETURNING id`, [groupId, groupedId ? 'album' : 'single', info.fileName, message.senderId?.toString(), message.chatId?.toString(), target.provider.name, target.accountId, folder ?? null, String(message.id), JSON.stringify(ref)]);
        await client.query('COMMIT');
        return result.rowCount === 1;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}

export async function updateOrdinaryFile(groupId: string, messageId: number, patch: Partial<OrdinaryFileRef>): Promise<void> {
    const result = await query(`UPDATE transfer_tasks SET payload=jsonb_set(payload,ARRAY['ordinaryFiles',$2::text],
        CASE WHEN payload->'ordinaryFiles'->$2::text->>'status'='success' AND $3::jsonb->>'status' NOT IN ('success','cancelled')
          THEN payload->'ordinaryFiles'->$2::text ELSE (payload->'ordinaryFiles'->$2::text)||$3::jsonb END),updated_at=NOW()
        WHERE source_type='telegram_bot' AND id=$1 AND payload->'ordinaryFiles' ? $2::text`, [groupId, String(messageId), JSON.stringify(patch)]);
    if (result.rowCount !== 1) throw new Error('普通 Telegram 文件恢复记录不存在');
}

export async function indexOrdinaryFile(groupId: string, messageId: number, sql: string, values: unknown[]): Promise<string> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const inserted = await client.query(sql, values);
        const fileId = String(inserted.rows[0].id);
        const settled = await client.query(`UPDATE transfer_tasks SET payload=jsonb_set(payload,ARRAY['ordinaryFiles',$2::text],
            (payload->'ordinaryFiles'->$2::text)||jsonb_build_object('status','success','fileId',$3::text)),updated_at=NOW(),error=NULL
            WHERE source_type='telegram_bot' AND id=$1 AND payload->'ordinaryFiles' ? $2::text`, [groupId, String(messageId), fileId]);
        if (settled.rowCount !== 1) throw new Error('普通 Telegram 文件结算记录不存在');
        await client.query('COMMIT');
        return fileId;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}
export async function readRecoverableOrdinaryTasks(): Promise<RecoverableOrdinaryTask[]> {
    const result = await query(`SELECT id,owner_user_id,chat_id,target_provider,target_account_id,target_folder,status,payload
        FROM transfer_tasks WHERE source_type='telegram_bot' AND payload ? 'ordinaryFiles'
        AND status IN ('pending','running','paused','interrupted') AND cancel_requested=FALSE ORDER BY created_at`);
    return result.rows;
}

export async function rereadOrdinaryFile(client: TelegramClient, ref: OrdinaryFileRef): Promise<Api.Message> {
    const peer = new BinaryReader(Buffer.from(ref.peer, 'base64')).tgReadObject() as Api.TypeInputPeer;
    const message = (await client.getMessages(peer, { ids: [ref.messageId] }))[0];
    if (!message?.media) throw new Error('原始 Telegram 文件消息已删除或无法访问');
    return message;
}
