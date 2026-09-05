import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import zh from '../locales/zh-CN/index';
import en from '../locales/en/index';

const route = fs.readFileSync(new URL('./appRoute.ts', import.meta.url), 'utf8');
const layout = fs.readFileSync(new URL('../components/layout/AppLayout.tsx', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../components/pages/SubscriptionCenter.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

test('subscription center is a first-class route and sidebar destination', () => {
    assert.match(route, /kind: 'subscriptions'/);
    assert.match(route, /pathname === '\/subscriptions'/);
    assert.match(layout, /id: "subscriptions"[\s\S]*label: t\('sidebar\.subscriptions'\)/);
    assert.equal(zh.sidebar.subscriptions, '订阅中心');
    assert.equal(en.sidebar.subscriptions, 'Subscription center');
    assert.match(app, /currentCategory === "subscriptions"/);
    assert.match(app, /<SubscriptionCenter/);
});

test('subscription center exposes per-channel modes, rule management and review workflow', () => {
    const paths = [
        'subscriptionCenter.filterModes.conservative.label',
        'subscriptionCenter.filterModes.aggressive.label',
        'subscriptionCenter.rules.actions.alwaysAllow',
        'subscriptionCenter.records.title',
        'subscriptionCenter.records.markNormal',
        'subscriptionCenter.records.markAd',
        'subscriptionCenter.pagination.previous',
        'subscriptionCenter.pagination.next',
        'subscriptionCenter.description',
        'subscriptionCenter.summary.enabled',
        'subscriptionCenter.summary.enabledDetail',
        'subscriptionCenter.empty.title',
        'subscriptionCenter.errors.subscriptions',
    ];
    const read = (catalog: Record<string, unknown>, path: string) => path.split('.').reduce<unknown>((value, segment) => value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined, catalog);
    for (const path of paths) {
        assert.match(page, new RegExp(path.replaceAll('.', '\\.')), path);
        assert.equal(typeof read(zh, path), 'string', `missing zh-CN ${path}`);
        assert.equal(typeof read(en, path), 'string', `missing en ${path}`);
        assert.notEqual(read(zh, path), read(en, path), `${path} must be localized`);
    }
    assert.match(api, /updateSubscriptionAdFilter/);
    assert.match(api, /createSubscriptionAdRule/);
    assert.match(api, /reviewSubscriptionAdDecision/);
    assert.match(api, /getSubscriptions\(filters: \{ limit\?: number; offset\?: number \}/);
    assert.match(page, /SUBSCRIPTION_PAGE_SIZE = 20/);
    assert.match(page, /DECISION_PAGE_SIZE = 20/);
    assert.match(page, /subscriptionPage/);
    assert.match(page, /decisionPage/);
});
