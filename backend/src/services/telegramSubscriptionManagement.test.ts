import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildTelegramSubscriptionPage,
    parseTelegramSubscriptionCallback,
    TELEGRAM_SUBSCRIPTION_PAGE_SIZE,
} from './telegramSubscriptionManagement.js';

const rows = Array.from({ length: TELEGRAM_SUBSCRIPTION_PAGE_SIZE + 2 }, (_, index) => ({
    id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    title: `订阅 ${index + 1}`,
}));

test('subscription page keeps displayed rows and actionable rows aligned', () => {
    const first = buildTelegramSubscriptionPage(rows, 0);
    assert.equal(first.visibleRows.length, TELEGRAM_SUBSCRIPTION_PAGE_SIZE);
    assert.equal(first.totalPages, 2);
    assert.deepEqual(first.visibleRows.map(row => row.title), rows.slice(0, TELEGRAM_SUBSCRIPTION_PAGE_SIZE).map(row => row.title));
    assert.equal(first.startIndex, 0);

    const second = buildTelegramSubscriptionPage(rows, 1);
    assert.deepEqual(second.visibleRows.map(row => row.title), rows.slice(TELEGRAM_SUBSCRIPTION_PAGE_SIZE).map(row => row.title));
    assert.equal(second.startIndex, TELEGRAM_SUBSCRIPTION_PAGE_SIZE);
});

test('subscription callbacks preserve page and separate request from confirmation', () => {
    const id = rows[0].id;
    assert.deepEqual(parseTelegramSubscriptionCallback(`tsub_cancel_${id}_1`), { kind: 'action', action: 'cancel', id, page: 1 });
    assert.deepEqual(parseTelegramSubscriptionCallback(`tsub_cancel_${id}`), { kind: 'action', action: 'cancel', id, page: 0 });
    assert.deepEqual(parseTelegramSubscriptionCallback('tsub_page_2'), { kind: 'page', page: 2 });
    assert.deepEqual(parseTelegramSubscriptionCallback('tsub_confirm_token-123'), { kind: 'confirm', token: 'token-123' });
    assert.deepEqual(parseTelegramSubscriptionCallback('tsub_back_token-123'), { kind: 'back', token: 'token-123' });
});

test('live bot routes cancellation through a confirmation before unsubscribe', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
    assert.match(source, /pendingSubscriptionCancels/);
    assert.match(source, /buildSubscriptionCancelConfirm/);
    const callback = source.slice(
        source.indexOf('async function handleTelegramSubscriptionCallback'),
        source.indexOf('export async function initTelegramBot'),
    );
    assert.match(callback, /if \(parsed\.action === 'cancel'\) \{\s*await editSubscriptionCancelConfirmation/);
    assert.match(callback, /parsed\.kind === 'confirm'[\s\S]*unsubscribeTelegramChannel/);
});
