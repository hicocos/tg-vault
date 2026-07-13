import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./telegramCommands.ts', import.meta.url), 'utf8');
const legacy = source.slice(
    source.indexOf('export async function handleChannelTaskQueueCallback'),
    source.indexOf('export async function handleRetryFailedTasks'),
);
assert.match(legacy, /action === 'cancel'/);
assert.match(legacy, /旧版取消按钮已失效|请使用新版 \/tasks/);
assert.doesNotMatch(legacy, /action === 'cancel' \? 'cancel_confirm'/);
console.log('legacy channel cancel fails closed ok');
