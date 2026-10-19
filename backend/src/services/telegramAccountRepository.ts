import { query } from '../db/index.js';
import { encryptCredential } from '../utils/credentialCrypto.js';
import type { TelegramAccountHealthState, TelegramSourceAccessState } from './telegramAccountScheduler.js';
import { normalizeTelegramAccountSourceKey } from './telegramAccountScheduler.js';
import { loadFileDownloadConcurrencySetting } from './telegramFileConcurrency.js';
import { isTelegramEntityResolutionError } from './telegramEntityResolution.js';

export type TelegramAccountSourceScope = 'download' | 'scan' | 'metadata';
export type TelegramDownloadAttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface TelegramAccountQueryResult {
    rows: any[];
    rowCount?: number | null;
}

export interface TelegramAccountQueryClient {
    query(text: string, params?: readonly unknown[]): Promise<TelegramAccountQueryResult>;
}

export interface TelegramUserAccountRecord {
    id: string;
    telegramUserId: string;
    username: string | null;
    displayName: string | null;
    session: string;
    enabled: boolean;
    healthState: TelegramAccountHealthState;
    cooldownUntil: Date | null;
    weight: number;
    priority: number;
    maxConnections: number;
    lastError: string | null;
    isLegacy: boolean;
}

export interface TelegramAccountSourceAccessRecord {
    accountId: string;
    sourceKey: string;
    scope: TelegramAccountSourceScope;
    accessState: TelegramSourceAccessState;
    lastError: string | null;
    checkedAt: Date | null;
}

// Read legacy aliases too; the latest probe wins until all keys are rewritten.
const canonicalSourceKeySql = `CASE
    WHEN BTRIM(source_key) ~ '^-100[0-9]+$' THEN SUBSTRING(BTRIM(source_key) FROM 5)
    WHEN BTRIM(source_key) ~* '^(?:https?://)?t[.]me/c/([0-9]+)(?:/[0-9]+)?/?$'
        THEN SUBSTRING(LOWER(BTRIM(source_key)) FROM '^(?:https?://)?t[.]me/c/([0-9]+)(?:/[0-9]+)?/?$')
    WHEN BTRIM(source_key) ~* '^(?:https?://)?t[.]me/(?:s/)?(?!joinchat(?:/|$))([a-z][a-z0-9_]*)(?:/[0-9]+)?/?$'
        THEN SUBSTRING(LOWER(BTRIM(source_key)) FROM '^(?:https?://)?t[.]me/(?:s/)?(?!joinchat(?:/|$))([a-z][a-z0-9_]*)(?:/[0-9]+)?/?$')
    WHEN BTRIM(source_key) ~ '^@?[A-Za-z0-9_]+$' THEN LOWER(LTRIM(BTRIM(source_key), '@'))
    ELSE BTRIM(source_key) END`;

function mapAccount(row: any): TelegramUserAccountRecord {
    return {
        id: String(row.id),
        telegramUserId: String(row.telegram_user_id || ''),
        username: row.username || null,
        displayName: row.display_name || null,
        session: String(row.session_ciphertext || ''),
        enabled: Boolean(row.enabled),
        healthState: row.health_state,
        cooldownUntil: row.cooldown_until || null,
        weight: Number(row.weight || 1),
        priority: Number(row.priority || 0),
        maxConnections: Number(row.max_connections || 1),
        lastError: row.last_error || null,
        isLegacy: Boolean(row.is_legacy),
    };
}

function mapAccess(row: {
    account_id: string;
    source_key: string;
    scope: TelegramAccountSourceScope;
    access_state: TelegramSourceAccessState;
    last_error?: string | null;
    checked_at?: Date | string | null;
}, now: number): TelegramAccountSourceAccessRecord {
    const checkedAt = row.checked_at ? new Date(row.checked_at) : null;
    const recent = checkedAt !== null && now - checkedAt.getTime() <= 15 * 60 * 1000;
    return {
        accountId: String(row.account_id),
        sourceKey: String(row.source_key),
        scope: row.scope,
        accessState: recent && !isTelegramEntityResolutionError(row.last_error) ? row.access_state : 'unknown',
        lastError: row.last_error || null,
        checkedAt,
    };
}

export class TelegramAccountRepository {
    constructor(
        private readonly db: TelegramAccountQueryClient = { query },
        private readonly now: () => Date = () => new Date(),
    ) {}

    async migrateLegacySystemSettings(): Promise<string | null> {
        const result = await this.db.query(`
            INSERT INTO telegram_user_accounts
                (telegram_user_id, username, session_ciphertext, enabled, health_state, is_legacy)
            SELECT
                COALESCE(NULLIF(user_id.value, ''), 'legacy'),
                NULLIF(username.value, ''),
                session.value,
                COALESCE(enabled.value, 'false') = 'true',
                CASE WHEN COALESCE(enabled.value, 'false') = 'true' THEN 'degraded' ELSE 'healthy' END,
                TRUE
            FROM system_settings session
            LEFT JOIN system_settings user_id ON user_id.key = 'telegram_user_id'
            LEFT JOIN system_settings username ON username.key = 'telegram_user_username'
            LEFT JOIN system_settings enabled ON enabled.key = 'telegram_user_download_enabled'
            WHERE session.key = 'telegram_user_session' AND session.value <> ''
              AND NOT EXISTS (
                  SELECT 1 FROM telegram_user_accounts
                  WHERE is_legacy = TRUE AND deleted_at IS NULL
              )
            ON CONFLICT (telegram_user_id) DO NOTHING
            RETURNING id
        `);
        return result.rows[0]?.id ? String(result.rows[0].id) : null;
    }

    async upsertAccount(input: {
        telegramUserId: string;
        username?: string | null;
        displayName?: string | null;
        session: string;
        enabled?: boolean;
        weight?: number;
        priority?: number;
        maxConnections?: number;
        isLegacy?: boolean;
    }): Promise<TelegramUserAccountRecord> {
        const result = await this.db.query(`
            INSERT INTO telegram_user_accounts
                (telegram_user_id, username, display_name, session_ciphertext, enabled, health_state, weight, priority, max_connections, is_legacy, last_error, session_expired_at)
            VALUES ($1, $2, $3, $4, $5, 'healthy', $6, $7, $8, $9, NULL, NULL)
            ON CONFLICT (telegram_user_id) DO UPDATE SET
                username = EXCLUDED.username, display_name = EXCLUDED.display_name,
                session_ciphertext = EXCLUDED.session_ciphertext, enabled = EXCLUDED.enabled,
                health_state = 'healthy', weight = EXCLUDED.weight, priority = EXCLUDED.priority,
                max_connections = EXCLUDED.max_connections, is_legacy = EXCLUDED.is_legacy, last_error = NULL,
                session_expired_at = NULL, deleted_at = NULL, updated_at = NOW()
            RETURNING *
        `, [
            input.telegramUserId, input.username || null, input.displayName || null,
            encryptCredential(input.session), input.enabled ?? true, Math.max(0.01, input.weight ?? 1),
            input.priority ?? 0, Math.max(1, input.maxConnections ?? 4), input.isLegacy ?? false,
        ]);
        if (input.enabled === false) await loadFileDownloadConcurrencySetting();
        return mapAccount(result.rows[0]);
    }

    async listEnabledAccounts(): Promise<TelegramUserAccountRecord[]> {
        const result = await this.db.query(`
            SELECT * FROM telegram_user_accounts
            WHERE enabled = TRUE AND deleted_at IS NULL
            ORDER BY priority DESC, created_at, id
        `);
        return result.rows.map(mapAccount);
    }

    async listAccounts(): Promise<TelegramUserAccountRecord[]> {
        const result = await this.db.query(`
            SELECT * FROM telegram_user_accounts WHERE deleted_at IS NULL
            ORDER BY priority DESC, created_at, id
        `);
        return result.rows.map(mapAccount);
    }

    async getAccount(accountId: string): Promise<TelegramUserAccountRecord | null> {
        const result = await this.db.query('SELECT * FROM telegram_user_accounts WHERE id = $1 AND deleted_at IS NULL', [accountId]);
        return result.rows[0] ? mapAccount(result.rows[0]) : null;
    }

    async setEnabled(accountId: string, enabled: boolean): Promise<boolean> {
        const result = await this.db.query(
            `UPDATE telegram_user_accounts SET enabled = $2, updated_at = NOW()
             WHERE id = $1 AND deleted_at IS NULL`, [accountId, enabled],
        );
        if (result.rowCount === 1 && !enabled) await loadFileDownloadConcurrencySetting();
        return result.rowCount === 1;
    }

    async deleteAccount(accountId: string): Promise<boolean> {
        await this.db.query('DELETE FROM telegram_account_source_access WHERE account_id = $1', [accountId]);
        const result = await this.db.query(
            `UPDATE telegram_user_accounts
             SET enabled = FALSE, session_ciphertext = '', health_state = 'session_expired',
                 cooldown_until = NULL, deleted_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND deleted_at IS NULL`,
            [accountId],
        );
        if (result.rowCount === 1) await loadFileDownloadConcurrencySetting();
        return result.rowCount === 1;
    }

    async reauthenticateAccount(input: {
        accountId: string;
        telegramUserId: string;
        username: string | null;
        displayName: string | null;
        session: string;
    }): Promise<TelegramUserAccountRecord | null> {
        const result = await this.db.query(`
            UPDATE telegram_user_accounts SET session_ciphertext = $3,
                username = $4, display_name = $5,
                health_state = CASE WHEN cooldown_until > NOW() THEN 'degraded' ELSE 'healthy' END,
                session_expired_at = NULL,
                last_error = CASE WHEN cooldown_until > NOW() THEN last_error ELSE NULL END,
                updated_at = NOW()
            WHERE id = $1 AND telegram_user_id = $2 AND deleted_at IS NULL
            RETURNING *
        `, [input.accountId, input.telegramUserId, encryptCredential(input.session), input.username, input.displayName]);
        return result.rows[0] ? mapAccount(result.rows[0]) : null;
    }

    async updateSession(accountId: string, session: string): Promise<boolean> {
        const result = await this.db.query(`
            UPDATE telegram_user_accounts SET session_ciphertext = $2,
                health_state = CASE WHEN cooldown_until > NOW() THEN 'degraded' ELSE 'healthy' END,
                session_expired_at = NULL,
                last_error = CASE WHEN cooldown_until > NOW() THEN last_error ELSE NULL END, updated_at = NOW()
            WHERE id = $1 AND deleted_at IS NULL
        `, [accountId, encryptCredential(session)]);
        return result.rowCount === 1;
    }

    async recordHealthy(accountId: string): Promise<boolean> {
        const result = await this.db.query(`
            UPDATE telegram_user_accounts SET
                health_state = CASE WHEN cooldown_until > NOW() THEN 'degraded' ELSE 'healthy' END,
                last_error = CASE WHEN cooldown_until > NOW() THEN last_error ELSE NULL END,
                last_connected_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL
        `, [accountId]);
        return result.rowCount === 1;
    }

    async recordFailure(accountId: string, error: string): Promise<boolean> {
        const result = await this.db.query(`
            UPDATE telegram_user_accounts SET health_state = 'degraded', last_error = $2,
                last_failure_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL
        `, [accountId, error]);
        return result.rowCount === 1;
    }

    async markCooldown(accountId: string, seconds: number, error: string | null = null, until?: Date): Promise<boolean> {
        const cooldownSeconds = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60;
        const result = await this.db.query(`
            UPDATE telegram_user_accounts SET cooldown_until = GREATEST(cooldown_until,
                COALESCE($4::timestamptz, NOW() + ($2::double precision * INTERVAL '1 second'))),
                health_state = 'degraded', last_error = $3, last_failure_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND deleted_at IS NULL
        `, [accountId, cooldownSeconds, error, until || null]);
        return result.rowCount === 1;
    }

    async markSessionExpired(accountId: string, error: string | null = null): Promise<boolean> {
        const result = await this.db.query(`
            UPDATE telegram_user_accounts SET health_state = 'session_expired', session_expired_at = NOW(),
                cooldown_until = NULL, last_error = $2, last_failure_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND deleted_at IS NULL
        `, [accountId, error]);
        return result.rowCount === 1;
    }

    async markSourceAccess(
        accountId: string,
        sourceKey: string,
        scope: TelegramAccountSourceScope,
        accessState: TelegramSourceAccessState,
        error: string | null = null,
    ): Promise<TelegramAccountSourceAccessRecord> {
        const result = await this.db.query(`
            INSERT INTO telegram_account_source_access
                (account_id, source_key, scope, access_state, last_error, checked_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (account_id, source_key, scope) DO UPDATE SET
                access_state = EXCLUDED.access_state, last_error = EXCLUDED.last_error,
                checked_at = NOW(), updated_at = NOW()
            RETURNING *
        `, [accountId, normalizeTelegramAccountSourceKey(sourceKey), scope, accessState, error]);
        return mapAccess(result.rows[0], this.now().getTime());
    }

    async probeSourceAccess(
        accountId: string,
        sourceKey: string,
        scope: TelegramAccountSourceScope,
        accessState: TelegramSourceAccessState,
        error: string | null = null,
    ): Promise<TelegramAccountSourceAccessRecord> {
        return this.markSourceAccess(accountId, sourceKey, scope, accessState, error);
    }

    async getSourceAccess(accountId: string, sourceKey: string, scope: TelegramAccountSourceScope): Promise<TelegramAccountSourceAccessRecord | null> {
        const result = await this.db.query(`
            SELECT * FROM telegram_account_source_access
            WHERE account_id = $1 AND ${canonicalSourceKeySql} = $2 AND scope = $3
            ORDER BY checked_at DESC NULLS LAST, (source_key = $2) DESC LIMIT 1
        `, [accountId, normalizeTelegramAccountSourceKey(sourceKey), scope]);
        return result.rows[0] ? mapAccess(result.rows[0], this.now().getTime()) : null;
    }

    async listSourceAccess(sourceKey: string, scope: TelegramAccountSourceScope): Promise<TelegramAccountSourceAccessRecord[]> {
        const result = await this.db.query(`
            SELECT DISTINCT ON (account_id) * FROM telegram_account_source_access
            WHERE ${canonicalSourceKeySql} = $1 AND scope = $2
            ORDER BY account_id, checked_at DESC NULLS LAST, (source_key = $1) DESC
        `, [normalizeTelegramAccountSourceKey(sourceKey), scope]);
        const now = this.now().getTime();
        return result.rows.map(row => mapAccess(row, now));
    }

    async getLatestAccessCheckForAccount(accountId: string): Promise<Date | null> {
        const result = await this.db.query(
            'SELECT MAX(checked_at) AS checked_at FROM telegram_account_source_access WHERE account_id = $1',
            [accountId],
        );
        return result.rows[0]?.checked_at || null;
    }

    async startDownloadAttempt(input: {
        accountId: string;
        sourceKey: string;
        scope?: TelegramAccountSourceScope;
        jobId?: string | null;
        itemId?: string | null;
        leaseToken?: string | null;
    }): Promise<string> {
        const result = await this.db.query(`
            INSERT INTO telegram_download_attempts
                (account_id, source_key, scope, job_id, item_id, lease_token, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING id
        `, [input.accountId, input.sourceKey, input.scope || 'download', input.jobId || null, input.itemId || null, input.leaseToken || null]);
        return String(result.rows[0].id);
    }

    async finishDownloadAttempt(attemptId: string, status: Exclude<TelegramDownloadAttemptStatus, 'running'>, error: string | null = null): Promise<boolean> {
        const result = await this.db.query(`
            UPDATE telegram_download_attempts SET status = $2, error = $3, finished_at = NOW()
            WHERE id = $1 AND status = 'running'
        `, [attemptId, status, error]);
        return result.rowCount === 1;
    }
}

export const telegramAccountRepository = new TelegramAccountRepository();
