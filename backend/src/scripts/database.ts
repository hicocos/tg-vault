import 'dotenv/config';
import pg from 'pg';
import { databaseStatus, migrateDatabase, checkDatabaseCurrent } from '../db/migrations.js';

const [command = 'status', ...extra] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// The bundled CLI is in dist/scripts; database assets live alongside dist/index.js.
const assets = new URL('../', import.meta.url);
try {
    if (extra.length || !['status', 'plan', 'migrate', 'check'].includes(command)) {
        throw new Error('Usage: database.js status|plan|migrate|check');
    }
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    if (command === 'check') {
        await checkDatabaseCurrent(pool, assets);
        console.log('Database schema is current');
    } else {
        const status = command === 'migrate'
            ? await migrateDatabase(pool, { assets, onApplied: version => console.log(`Applied ${version}`) })
            : await databaseStatus(pool, assets);
        console.log(JSON.stringify({ command, ...status }, null, 2));
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally { await pool.end(); }
