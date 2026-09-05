import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { withTelegramOperationDeadline } from './telegramOperationDeadline.js';

const source = fs.readFileSync(new URL('./telegramOperationDeadline.ts', import.meta.url), 'utf8');

test('Telegram operation deadline rejects a stalled operation without Promise.race', async () => {
    assert.doesNotMatch(source, /Promise\.race/);
    const pending = new Promise<void>(() => undefined);
    await assert.rejects(
        () => withTelegramOperationDeadline(pending, 5, 'Telegram operation timed out'),
        /Telegram operation timed out/,
    );
});

test('Telegram operation deadline clears its timer after completion', async () => {
    await assert.doesNotReject(() => withTelegramOperationDeadline(Promise.resolve('ok'), 100, 'timeout'));
});
