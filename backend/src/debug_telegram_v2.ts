
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load env explicitly
const envPath = path.resolve(process.cwd(), '.env');
console.log(`Loading .env from: ${envPath}`);
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    console.log('⚠️ .env file NOT found at expected path!');
}

const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
const apiHash = process.env.TELEGRAM_API_HASH || '';
const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

console.log(`API ID: ${apiId}`);
console.log(`API Hash Length: ${apiHash.length}`);
console.log(`Bot Token Length: ${botToken.length}`);

async function run() {
    console.log('Starting client...');
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
        connectionRetries: 1,
        // useWSS: true, // Try toggling this if TCP fails
    });

    try {
        console.log('Connecting...');
        await client.connect();
        console.log('✅ Connected to Telegram servers.');

        console.log('Logging in with bot token...');
        await client.start({
            botAuthToken: botToken,
        });
        console.log('✅ Bot Login Successful!');

        const me = await client.getMe();
        console.log(`Bot Info: ${(me as any).username} (ID: ${(me as any).id})`);

    } catch (e) {
        console.error('❌ Error occurred:', e);
    } finally {
        await client.disconnect();
        console.log('Disconnected.');
    }
}

run().catch(err => console.error('Unhandled:', err));
