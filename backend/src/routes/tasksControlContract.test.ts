import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./tasks.ts', import.meta.url), 'utf8');

test('Web task cancellation requires an actor/action/object-bound one-time confirmation', () => {
    assert.match(source, /cancel-confirmation/);
    assert.match(source, /action: 'cancel_task'/);
    assert.match(source, /objectId: `\$\{sourceType\}:\$\{id\}`/);
    assert.match(source, /x-confirmation-token/);
    assert.match(source, /CONFIRMATION_REQUIRED/);
});

test('ordinary Bot cancellation changes durable state only after runtime control succeeds', () => {
    const block = source.slice(source.indexOf("if (sourceType === 'telegram_bot')"), source.indexOf("if (sourceType === 'telegram_channel')"));
    assert.match(block, /cancelDownloadTaskGroup/);
    assert.match(block, /cancelled\.status !== 'ok'/);
    assert.ok(block.indexOf("cancelled.status !== 'ok'") < block.indexOf("status: 'cancelled'"));
});

test('open chunk sessions are not falsely reported as paused', () => {
    assert.match(source, /row\.status === 'open' \? 'waiting'/);
    assert.match(source, /row\.status === 'open' \? 'resumable'/);
    assert.doesNotMatch(source, /row\.status === 'open' \? 'paused'/);
});
