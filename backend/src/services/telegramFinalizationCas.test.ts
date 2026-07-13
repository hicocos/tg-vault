import assert from 'node:assert/strict';
import { finalizeSubscriptionJobWithQuery, type TelegramJobQuery } from './telegramChannelJobs.js';

async function runScenario(parentRows: number) {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const runQuery: TelegramJobQuery = async (text, params) => {
        calls.push({ text, params });
        if (/UPDATE telegram_background_jobs/.test(text)) return { rows: parentRows ? [{ id: 'job-1' }] : [], rowCount: parentRows };
        return { rows: [], rowCount: 1 };
    };
    const result = await finalizeSubscriptionJobWithQuery(runQuery, {
        jobId: 'job-1', subscriptionId: 'sub-1', status: 'completed', safeAdvanceId: 42,
        enqueuedCount: 3, skippedCount: 0, error: null,
    });
    return { result, calls };
}

const lostRace = await runScenario(0);
assert.equal(lostRace.result, false);
assert.equal(lostRace.calls.length, 1, 'cursor must not advance after losing parent CAS');

const won = await runScenario(1);
assert.equal(won.result, true);
assert.equal(won.calls.length, 2);
assert.match(won.calls[1].text, /UPDATE telegram_channel_subscriptions/);
console.log('telegram finalization CAS controls cursor ok');
