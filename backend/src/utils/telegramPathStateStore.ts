import { query } from '../db/index.js';

export type TelegramPathMode = 'once' | 'session';
type QueryLike = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
const defaultQuery: QueryLike = (sql, params) => query(sql, params) as any;

export async function setTelegramPathStateRow(
    runQuery: QueryLike = defaultQuery,
    chatId: string,
    mode: TelegramPathMode,
    folder: string,
    expiresAt: Date,
): Promise<void> {
    await runQuery(
        `INSERT INTO telegram_path_states (chat_id, mode, folder, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chat_id, mode)
         DO UPDATE SET folder = EXCLUDED.folder, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
        [chatId, mode, folder, expiresAt],
    );
}

export async function consumeTelegramOncePath(runQuery: QueryLike = defaultQuery, chatId: string): Promise<string | null> {
    const result = await runQuery(
        `DELETE FROM telegram_path_states
         WHERE chat_id = $1 AND mode = 'once' AND expires_at > NOW()
         RETURNING folder`,
        [chatId],
    );
    return result.rows[0]?.folder || null;
}

export async function getTelegramSessionPath(runQuery: QueryLike = defaultQuery, chatId: string): Promise<string | null> {
    const result = await runQuery(
        `SELECT folder FROM telegram_path_states
         WHERE chat_id = $1 AND mode = 'session' AND expires_at > NOW()`,
        [chatId],
    );
    return result.rows[0]?.folder || null;
}

export async function previewTelegramPersistentPath(chatId: string): Promise<{ once: string | null; session: string | null }> {
    const result = await defaultQuery(
        `SELECT mode, folder FROM telegram_path_states
         WHERE chat_id = $1 AND expires_at > NOW()`,
        [chatId],
    );
    return {
        once: result.rows.find(row => row.mode === 'once')?.folder || null,
        session: result.rows.find(row => row.mode === 'session')?.folder || null,
    };
}

export async function clearTelegramPathStateRows(runQuery: QueryLike = defaultQuery, chatId: string): Promise<void> {
    await runQuery('DELETE FROM telegram_path_states WHERE chat_id = $1', [chatId]);
}
