import assert from 'node:assert/strict';
import { repairTelegramJobInvariantsWithQuery } from './telegramChannelJobs.js';

const calls: string[] = [];
const result = await repairTelegramJobInvariantsWithQuery(async text => {
    calls.push(text);
    return { rows: [{ repaired_jobs: 2 }], rowCount: 1 } as any;
});
assert.equal(result, 2);
assert.equal(calls.length, 1);
assert.match(calls[0], /finished_at = NULL/);
assert.match(calls[0], /status = 'running'/);
assert.match(calls[0], /j.paused_at IS NULL/);
assert.doesNotMatch(calls[0], /SET status = 'running',[\s\S]*paused_at = NULL/);
assert.match(calls[0], /locked_at < NOW\(\) - INTERVAL '30 minutes'/);
assert.match(calls[0], /scan_status = CASE/);
assert.match(calls[0], /COUNT\(\*\) FILTER \(WHERE i.status IN \('pending', 'downloading'\)\)/);
assert.match(calls[0], /j.status IN \('completed', 'completed_with_errors', 'failed', 'running'\)/);
console.log('telegram job invariant repair ok');
