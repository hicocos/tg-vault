import assert from 'node:assert/strict';
import fs from 'node:fs';
import { waitForStorageCooldownRetry } from './telegramUpload.js';

const channelJobSource = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const subscriptionBody = channelJobSource.slice(
    channelJobSource.indexOf('async function runSubscriptionScan'),
    channelJobSource.indexOf('async function recoverTelegramJob'),
);
assert.match(subscriptionBody, /downloadPendingForJob\([\s\S]*botClient,[\s\S]*requestMessage,[\s\S]*jobId/);
assert.doesNotMatch(subscriptionBody, /markDownloadRefsDownloading\(jobId, subscriptionRefs\)/);
assert.doesNotMatch(subscriptionBody, /downloadTelegramChannelRange\(botClient, requestMessage/);

async function testRetriesUntilCooldownClears() {
    const signal = new AbortController().signal;
    const waits: string[] = [];
    let attempts = 0;
    const result = await waitForStorageCooldownRetry(
        new Date(0),
        signal,
        async () => {
            attempts += 1;
            return attempts === 1 ? new Date(0) : undefined;
        },
        retryAt => { waits.push(retryAt.toISOString()); },
        () => 1,
    );
    assert.equal(result, 'success');
    assert.equal(attempts, 2);
    assert.equal(waits.length, 2);
}

async function testCancelStopsWithoutRetry() {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    const result = await waitForStorageCooldownRetry(
        new Date(Date.now() + 60_000),
        controller.signal,
        async () => {
            attempts += 1;
            return undefined;
        },
    );
    assert.equal(result, 'cancelled');
    assert.equal(attempts, 0);
}

await testRetriesUntilCooldownClears();
await testCancelStopsWithoutRetry();
console.log('telegram storage cooldown retry ok');
