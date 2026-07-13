import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function runSubscriptionScan'), source.indexOf('async function recoverTelegramJob'));
assert.match(body, /let lockClient: PoolClient \| null = null/);
assert.match(body, /try {[\s\S]*await pool\.connect\(\)/);
assert.match(body, /finally {[\s\S]*subscriptionScanRunning = false/);
assert.match(body, /lockClient\?\.release\(\)/);
console.log('subscription scan connect failure releases guard ok');
