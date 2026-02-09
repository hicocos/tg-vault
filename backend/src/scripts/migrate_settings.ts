
import dotenv from 'dotenv';
import path from 'path';

// 加载环境变量
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { query } from '../db/index.js';

async function migrate() {
    console.log('Starting migration...');
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR(255) PRIMARY KEY,
                value TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );

            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'system_settings_updated_at') THEN
                    CREATE TRIGGER system_settings_updated_at
                    BEFORE UPDATE ON system_settings
                    FOR EACH ROW
                    EXECUTE FUNCTION update_updated_at();
                END IF;
            END $$;
            
            -- Insert default storage provider setting if not exists
            INSERT INTO system_settings (key, value)
            VALUES ('storage_provider', 'local')
            ON CONFLICT (key) DO NOTHING;
        `);
        console.log('Migration completed successfully.');
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
    process.exit(0);
}

migrate();
