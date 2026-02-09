
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load env from one level up (since this is in src/)
const envPath = path.resolve(__dirname, '../.env');
console.log(`Loading .env from: ${envPath}`);
dotenv.config({ path: envPath });

async function testConnection() {
    const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

    console.log('--- Telegram Connection Diagnostics ---');
    console.log(`API ID: ${apiId}`);
    console.log(`API Hash: ${apiHash ? 'Present' : 'Missing'}`);
    console.log(`Bot Token: ${botToken ? 'Present' : 'Missing'}`);

    if (!apiId || !apiHash || !botToken) {
        console.error('❌ Missing credentials');
        return;
    }

    const session = new StringSession(''); // Start with empty session to test fresh login
    const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 1, // Fail fast
        useWSS: false, // Default is false for TCP, try changing if needed
    });

    console.log('Attempting to connect...');

    try {
        await client.connect();
        console.log('✅ Socket connected');
    } catch (err) {
        console.error('❌ Socket connection failed:', err);
        return;
    }

    console.log('Attempting to sign in with bot token...');
    try {
        await client.start({
            botAuthToken: botToken,
        });
        console.log('✅ Bot Authentication successful');

        const me = await client.getMe();
        console.log(`✅ Logged in as: ${(me as any).username}`);
    } catch (err) {
        console.error('❌ Authentication/Start failed:', err);
    } finally {
        await client.disconnect();
        console.log('Disconnected.');
    }
}

testConnection().catch(console.error);
