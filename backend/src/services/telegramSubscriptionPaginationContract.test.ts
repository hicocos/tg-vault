import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const routes = fs.readFileSync(new URL('../routes/subscriptions.ts', import.meta.url), 'utf8');
const decisions = fs.readFileSync(new URL('./telegramSubscriptionAdFilter.ts', import.meta.url), 'utf8');

test('subscription list only returns enabled rows with bounded server pagination', () => {
    assert.match(routes, /WHERE s\.enabled = TRUE/);
    assert.match(routes, /LIMIT \$1 OFFSET \$2/);
    assert.match(routes, /COUNT\(\*\)::int AS total/);
    assert.match(routes, /total/);
    assert.match(routes, /limit/);
    assert.match(routes, /offset/);
    assert.match(decisions, /JOIN telegram_channel_subscriptions s ON s\.id = d\.subscription_id/);
    assert.match(decisions, /WHERE s\.enabled = TRUE/);
});
