import assert from 'node:assert/strict';
import { settleTelegramDownloadRefWithQuery } from './telegramChannelJobs.js';

const calls: Array<{ text: string; params?: unknown[] }> = [];
const result = await settleTelegramDownloadRefWithQuery(async (text, params) => {
    calls.push({ text, params });
    return { rows: [], rowCount: 0 } as any;
}, 'job-1', { id: 42, source: '@source', origin: 'channel', leaseToken: 'lease-a' }, 'success');
assert.equal(result, 'lease-lost');
assert.match(calls[0].text, /lease_token =/);
assert.ok(calls[0].params?.includes('lease-a'));
console.log('telegram settlement lease token ok');
