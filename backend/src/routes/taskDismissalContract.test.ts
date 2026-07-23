import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const routes = fs.readFileSync(new URL('./tasks.ts', import.meta.url), 'utf8');
const confirmations = fs.readFileSync(new URL('../services/webDestructiveConfirmation.ts', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

test('task dismissal uses a frozen session-bound prepare/confirm snapshot', () => {
    assert.match(routes, /dismissals\/prepare/);
    assert.match(routes, /dismissals\/confirm/);
    assert.match(routes, /action: 'dismiss_tasks'/);
    assert.match(routes, /task\.updatedAt/);
    assert.match(routes, /webDestructiveConfirmationStore\.consume/);
    assert.match(confirmations, /dismiss_tasks/);
    assert.match(confirmations, /context: value\.context/);
});

test('task dismissal is exact-version soft removal and never deletes source rows or files', () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS task_center_dismissals/);
    assert.match(routes, /saveTaskCenterDismissals/);
    assert.doesNotMatch(routes, /DELETE FROM (?:files|transfer_tasks|telegram_background_jobs|telegram_channel_subscriptions)/);
    assert.match(routes, /filesDeleted: false/);
    assert.match(routes, /cloudObjectsDeleted: false/);
});

test('unprepared or replayed task dismissal confirmation fails closed', () => {
    assert.match(routes, /CONFIRMATION_REQUIRED/);
    assert.match(routes, /status !== 'ok'/);
    assert.match(routes, /res\.status\(409\)/);
});
