import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { resources } from '../i18n/telegram.js';

const presentation = fs.readFileSync(new URL('../bot/presentation/subscription.ts', import.meta.url), 'utf8');
const jobs = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

test('subscription health records scan, success, failure and next-scan visibility', () => {
    for (const field of ['last_scan_at', 'last_success_at', 'last_error', 'last_result']) assert.match(schema, new RegExp(field));
    assert.match(jobs, /last_scan_at = NOW\(\)/);
    assert.match(jobs, /last_success_at = NOW\(\)/);
    assert.match(jobs, /next_scan_at/);
    assert.match(presentation, /bot\.subscription\.lastScan/);
    assert.match(presentation, /bot\.subscription\.nextScan/);
    assert.match(presentation, /bot\.subscription\.lastResult/);
    assert.match(resources['zh-CN']['bot.subscription.lastScan'], /上次扫描/);
    assert.match(resources['zh-CN']['bot.subscription.nextScan'], /下次扫描约/);
    assert.match(resources['zh-CN']['bot.subscription.lastResult'], /最近结果/);
});
