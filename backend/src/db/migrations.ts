import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

export const DATABASE_ASSETS = new URL('./', import.meta.url);
export const MIGRATION_LOCK_KEY = 0x54475641;
const LEGACY_HISTORY: Record<string, { name: string; checksum: string }> = {
    '2026082401': { name: 'canonical-expand-schema', checksum: '5bfbbb54513df64463707868885c4ffd2e8a5678bac4c3ab40ebe1237d74f203' },
    '2026090102': { name: 'remove_ytdlp', checksum: 'ad718c63dabb8b82b2b055fc669c087113484c4588f2ac12047dd20e864347dd' },
};
export interface MigrationFile { version: string; name: string; checksum: string; sql: string; }
interface LedgerRow { version: string; name: string; checksum: string | null; }
export interface DatabaseStatus {
    bootstrap: 'empty' | 'legacy' | null;
    applied: LedgerRow[];
    pending: Array<Omit<MigrationFile, 'sql'>>;
    current: boolean;
}
export interface MigrationInputs { baseline: string; migrations: MigrationFile[]; }
export function checksum(sql: string): string { return createHash('sha256').update(sql).digest('hex'); }

export async function loadMigrationInputs(assets = DATABASE_ASSETS): Promise<MigrationInputs> {
    const baseline = await readFile(new URL('baseline.sql', assets), 'utf8');
    const names = (await readdir(new URL('migrations/', assets))).filter(name => name.endsWith('.sql')).sort();
    const migrations: MigrationFile[] = [];
    const versions = new Set<string>();
    for (const filename of names) {
        const match = filename.match(/^(\d{10})_([a-z0-9_]+)\.sql$/);
        if (!match || versions.has(match[1])) throw new Error(`Invalid or duplicate migration: ${filename}`);
        versions.add(match[1]);
        const sql = await readFile(new URL(`migrations/${filename}`, assets), 'utf8');
        migrations.push({ version: match[1], name: match[2], checksum: checksum(sql), sql });
    }
    if (!migrations.length) throw new Error('Database migration assets are missing');
    return { baseline, migrations };
}

async function inspect(client: PoolClient, inputs: MigrationInputs): Promise<DatabaseStatus> {
    const exists = await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger");
    let applied: LedgerRow[] = [];
    let bootstrap: DatabaseStatus['bootstrap'] = null;
    if (exists.rows[0].ledger) {
        applied = (await client.query('SELECT version::text, name, checksum FROM public.schema_migrations ORDER BY version')).rows;
    } else {
        const tables = await client.query("SELECT COUNT(*)::int AS count FROM pg_tables WHERE schemaname = 'public'");
        bootstrap = tables.rows[0].count ? 'legacy' : 'empty';
    }
    const expected = new Map(inputs.migrations.map(migration => [migration.version, migration]));
    for (const row of applied) {
        const entry = row.version === '0' ? { name: 'legacy_bootstrap', checksum: checksum(inputs.baseline) }
            : expected.get(row.version) || LEGACY_HISTORY[row.version];
        if (!entry) throw new Error(`Database contains unknown/newer migration ${row.version}; use its matching release, not an older image`);
        if (entry.name !== row.name || entry.checksum !== row.checksum) throw new Error(`Migration ${row.version} name/checksum mismatch; do not edit applied SQL`);
    }
    const appliedVersions = new Set(applied.map(row => row.version));
    const pending = inputs.migrations.filter(migration => !appliedVersions.has(migration.version))
        .map(({ sql: _sql, ...migration }) => migration);
    return { bootstrap, applied, pending, current: bootstrap === null && pending.length === 0 };
}

export async function databaseStatus(pool: Pool, assets = DATABASE_ASSETS): Promise<DatabaseStatus> {
    const inputs = await loadMigrationInputs(assets);
    const client = await pool.connect();
    try {
        await client.query('BEGIN READ ONLY');
        const status = await inspect(client, inputs);
        await client.query('COMMIT');
        return status;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
}

function timeoutValue(name: string, fallback: number): number {
    const value = process.env[name];
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 3_600_000) {
        throw new Error(`${name} must be an integer from 1 to 3600000 milliseconds`);
    }
    return Number(value);
}
async function transaction(client: PoolClient, operation: () => Promise<void>): Promise<void> {
    await client.query('BEGIN');
    try { await operation(); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}
async function record(client: PoolClient, migration: Pick<MigrationFile, 'version' | 'name' | 'checksum'>) {
    await client.query('INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum]);
}

export async function migrateDatabase(pool: Pool, options: { assets?: URL; replay?: boolean; through?: string; onApplied?: (version: string) => void } = {}): Promise<DatabaseStatus> {
    const assets = options.assets || DATABASE_ASSETS;
    const inputs = await loadMigrationInputs(assets);
    if (options.through && !inputs.migrations.some(row => row.version === options.through)) throw new Error(`Unknown target migration ${options.through}`);
    const lockTimeout = timeoutValue('DB_MIGRATION_LOCK_TIMEOUT_MS', 10_000);
    const statementTimeout = timeoutValue('DB_MIGRATION_STATEMENT_TIMEOUT_MS', 300_000);
    const client = await pool.connect();
    let locked = false;
    try {
        await client.query("SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)", [`${lockTimeout}ms`, `${statementTimeout}ms`]);
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
        locked = true;
        let status = await inspect(client, inputs);
        if (status.bootstrap === 'empty' && !options.replay && !options.through) {
            const manifest = JSON.parse(await readFile(new URL('snapshot.json', assets), 'utf8')) as { baselineChecksum: string; schemaChecksum: string; migrations: Array<{ version: string; checksum: string; name: string }> };
            const schema = await readFile(new URL('schema.sql', assets), 'utf8');
            const expected = inputs.migrations.map(({ version, name, checksum }) => ({ version, name, checksum }));
            if (manifest.baselineChecksum !== checksum(inputs.baseline) || manifest.schemaChecksum !== checksum(schema)
                || JSON.stringify(manifest.migrations) !== JSON.stringify(expected)) throw new Error('Generated database snapshot is stale; run npm run schema:generate');
            await transaction(client, async () => {
                await client.query(schema);
                await record(client, { version: '0', name: 'legacy_bootstrap', checksum: checksum(inputs.baseline) });
                for (const migration of inputs.migrations) await record(client, migration);
            });
            options.onApplied?.('snapshot');
            return await inspect(client, inputs);
        }
        if (status.bootstrap) {
            await transaction(client, async () => {
                await client.query(inputs.baseline);
                await record(client, { version: '0', name: 'legacy_bootstrap', checksum: checksum(inputs.baseline) });
            });
            options.onApplied?.('baseline');
            status = await inspect(client, inputs);
        }
        const pending = new Set(status.pending.map(row => row.version));
        for (const migration of inputs.migrations) {
            if (!pending.has(migration.version) || (options.through && migration.version > options.through)) continue;
            await transaction(client, async () => { await client.query(migration.sql); await record(client, migration); });
            options.onApplied?.(migration.version);
        }
        return await inspect(client, inputs);
    } finally {
        if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
        await client.query('RESET lock_timeout; RESET statement_timeout').catch(() => undefined);
        client.release();
    }
}

export async function checkDatabaseCurrent(pool: Pool, assets = DATABASE_ASSETS): Promise<void> {
    const status = await databaseStatus(pool, assets);
    if (!status.current) throw new Error(`Database upgrade required (${status.bootstrap || `${status.pending.length} pending migrations`}); run npm run db:migrate before starting the application`);
}
