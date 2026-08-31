import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const routes = fs.readFileSync(new URL('../routes/subscriptions.ts', import.meta.url), 'utf8');
const jobs = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../db/migrations/2026083101_telegram_subscription_ad_filter.sql', import.meta.url), 'utf8');

test('subscription center exposes mode, rules, decisions and manual review endpoints', () => {
    assert.match(routes, /router\.get\('\/'/);
    assert.match(routes, /router\.patch\('\/:subscriptionId'/);
    assert.match(routes, /router\.post\('\/:subscriptionId\/rules'/);
    assert.match(routes, /router\.delete\('\/:subscriptionId\/rules\/:ruleId'/);
    assert.match(routes, /router\.get\('\/decisions\/list'/);
    assert.match(routes, /router\.post\('\/decisions\/:decisionId\/review'/);
    assert.match(routes, /createSubscriptionDownloadJob/);
    assert.match(routes, /markTelegramAdRestoreSuccess/);
    assert.match(routes, /Cache-Control/);
    assert.match(routes, /claimTelegramAdRestore/);
    assert.match(routes, /markTelegramAdRestoreFailure/);
    assert.match(jobs, /adDecisionId/);
});

test('the subscription worker filters before persisting download items and advances blocked ids safely', () => {
    const filterIndex = jobs.indexOf('filterTelegramSubscriptionAdvertisements({');
    const persistIndex = jobs.indexOf('await persistDownloadMessages(jobId', filterIndex);
    assert.ok(filterIndex > 0);
    assert.ok(persistIndex > filterIndex);
    assert.match(jobs.slice(filterIndex, persistIndex + 500), /candidateMessages = adFilter\.allowedMessages/);
    assert.match(jobs, /adFilter\.blockedMessageIds/);
});

test('schema and migration keep advertisement tables and mode in sync', () => {
    for (const text of [schema, migration]) {
        assert.match(text, /ad_filter_mode/);
        assert.match(text, /telegram_subscription_ad_rules/);
        assert.match(text, /telegram_subscription_ad_decisions/);
        assert.match(text, /manual_label/);
    }
});
