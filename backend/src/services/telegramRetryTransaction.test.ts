import assert from 'node:assert/strict';
import { retryTelegramBackgroundJobWithQuery } from './telegramChannelJobs.js';

async function testRetryIsAtomicAndResetsAttempts() {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const result = await retryTelegramBackgroundJobWithQuery(async (text, params) => {
        calls.push({ text, params });
        return { rows: [{ id: 'job-1', retried: 2 }], rowCount: 1 } as any;
    }, 7, 'abcd1234', '99');

    assert.deepEqual(result, { id: 'job-1', retried: 2 });
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /attempts = 0/);
    assert.match(calls[0].text, /locked_job AS/);
    assert.match(calls[0].text, /FOR UPDATE OF j/);
    assert.match(calls[0].text, /FROM locked_job u/);
    assert.match(calls[0].text, /status IN \('failed', 'completed_with_errors'\)/);
    assert.match(calls[0].text, /paused_at IS NULL/);
    assert.match(calls[0].text, /EXISTS \(SELECT 1 FROM retried\)/);
    assert.match(calls[0].text, /HAVING COUNT\(\*\) = 1/);
}

async function testRetryWithNoFailuresDoesNotReportJob() {
    const result = await retryTelegramBackgroundJobWithQuery(async () => ({ rows: [], rowCount: 0 }) as any, 7, 'abcd1234', '99');
    assert.equal(result, null);
}

await testRetryIsAtomicAndResetsAttempts();
await testRetryWithNoFailuresDoesNotReportJob();
console.log('telegram retry transaction ok');
