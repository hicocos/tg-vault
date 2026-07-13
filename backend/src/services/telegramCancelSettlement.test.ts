import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const cancelOne = source.slice(
    source.indexOf('export async function cancelTelegramBackgroundJob'),
    source.indexOf('export async function cancelAllTelegramBackgroundJobs'),
);
assert.match(cancelOne, /status = 'pending'/);
assert.doesNotMatch(cancelOne, /status IN \('pending', 'downloading'\)/);

const cancelAll = source.slice(
    source.indexOf('export async function cancelAllTelegramBackgroundJobs'),
    source.indexOf('export async function retryTelegramBackgroundJobWithQuery'),
);
assert.match(cancelAll, /status = 'pending'/);
assert.doesNotMatch(cancelAll, /status IN \('pending', 'downloading'\)/);

const settlement = source.slice(
    source.indexOf('export async function settleTelegramDownloadRefWithQuery'),
    source.indexOf('async function markDownloadRefStatus'),
);
assert.match(settlement, /WHEN i\.status = 'downloading' THEN \$3::varchar/);

console.log('telegram cancel preserves active settlement ok');
