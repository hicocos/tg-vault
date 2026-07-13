import assert from 'node:assert/strict';
import fs from 'node:fs';
import { contiguousProcessedMessageId } from './telegramChannelJobs.js';

assert.equal(contiguousProcessedMessageId(100, [101, 103], [104], [102]), 101);
assert.equal(contiguousProcessedMessageId(100, [101, 102], [103], []), 103);
assert.equal(contiguousProcessedMessageId(100, [102], [], [101]), 100);

const source = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const scanBody = source.slice(
    source.indexOf('async function runSubscriptionScan'),
    source.indexOf('async function recoverTelegramJob'),
);
assert.match(scanBody, /pg_try_advisory_lock/);
assert.match(scanBody, /pg_advisory_unlock/);
assert.match(scanBody, /subscriptionScanRunning/);
assert.match(scanBody, /contiguousProcessedMessageId\(/);
assert.match(scanBody, /nonDownloadableMessageIds/);
assert.doesNotMatch(scanBody, /maxProcessedMessageId\(downloadResult\)/);

console.log('telegram subscription lease and cursor ok');
