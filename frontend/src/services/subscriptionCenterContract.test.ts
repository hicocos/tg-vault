import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('./appRoute.ts', import.meta.url), 'utf8');
const layout = fs.readFileSync(new URL('../components/layout/AppLayout.tsx', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../components/pages/SubscriptionCenter.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

test('subscription center is a first-class route and sidebar destination', () => {
    assert.match(route, /kind: 'subscriptions'/);
    assert.match(route, /pathname === '\/subscriptions'/);
    assert.match(layout, /id: "subscriptions"[\s\S]*label: "订阅中心"/);
    assert.match(app, /currentCategory === "subscriptions"/);
    assert.match(app, /<SubscriptionCenter/);
});

test('subscription center exposes per-channel modes, rule management and review workflow', () => {
    assert.match(page, /保守/);
    assert.match(page, /严格/);
    assert.match(page, /始终允许/);
    assert.match(page, /过滤记录/);
    assert.match(page, /不是广告/);
    assert.match(page, /是广告/);
    assert.match(api, /updateSubscriptionAdFilter/);
    assert.match(api, /createSubscriptionAdRule/);
    assert.match(api, /reviewSubscriptionAdDecision/);
    assert.match(api, /getSubscriptions\(filters: \{ limit\?: number; offset\?: number \}/);
    assert.match(page, /SUBSCRIPTION_PAGE_SIZE = 20/);
    assert.match(page, /DECISION_PAGE_SIZE = 20/);
    assert.match(page, /subscriptionPage/);
    assert.match(page, /decisionPage/);
    assert.match(page, /上一页/);
    assert.match(page, /下一页/);
});
