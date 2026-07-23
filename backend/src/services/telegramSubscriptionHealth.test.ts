import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const bot = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
const jobs = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

test('subscription health records scan, success, failure and next-scan visibility', () => {
    for (const field of ['last_scan_at', 'last_success_at', 'last_error', 'last_result']) assert.match(schema, new RegExp(field));
    assert.match(jobs, /last_scan_at = NOW\(\)/);
    assert.match(jobs, /last_success_at = NOW\(\)/);
    assert.match(jobs, /next_scan_at/);
    assert.match(bot, /上次扫描/);
    assert.match(bot, /下次扫描约/);
    assert.match(bot, /最近结果/);
});
