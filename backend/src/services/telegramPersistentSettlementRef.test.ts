import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settleTelegramDownloadRefWithQuery } from './telegramChannelJobs.js';

const source = fs.readFileSync(new URL('./telegramUpload.ts', import.meta.url), 'utf8');
assert.match(source, /persistentRef: TelegramDownloadMessageRef/);
assert.match(source, /persistentRef: ref/);
assert.match(source, /onItemSettled\?\.\(item\.persistentRef, 'success'\)/);
assert.doesNotMatch(source, /onItemSettled\?\.\(item, '(?:success|failed|skipped)'/);

const calls: Array<{ text: string; params?: unknown[] }> = [];
const settled = await settleTelegramDownloadRefWithQuery(
    async (text, params) => {
        calls.push({ text, params });
        return { rows: [{ status: 'success' }], rowCount: 1 } as any;
    },
    'job-1',
    { id: 42, source: '@source', origin: 'channel' } as any,
    'success',
);
assert.equal(settled, 'settled');
assert.equal(calls.length, 1);
assert.match(calls[0].text, /i\.status = 'downloading'/);
assert.doesNotMatch(calls[0].text, /j\.paused_at IS NULL/);
assert.doesNotMatch(calls[0].text, /j\.status NOT IN/);
assert.match(calls[0].text, /RETURNING i\.status/);

const alreadyTerminal = await settleTelegramDownloadRefWithQuery(
    async () => ({ rows: [{ status: 'skipped' }], rowCount: 1 }) as any,
    'job-1',
    { id: 42, source: '@source', origin: 'channel' } as any,
    'success',
);
assert.equal(alreadyTerminal, 'already-terminal');

await assert.rejects(
    () => settleTelegramDownloadRefWithQuery(
        async () => ({ rows: [], rowCount: 0 }) as any,
        'job-1',
        { id: 42, source: '@source', origin: 'channel' } as any,
        'success',
    ),
    /结算影响 0 行/,
);

console.log('telegram persistent settlement reference ok');
