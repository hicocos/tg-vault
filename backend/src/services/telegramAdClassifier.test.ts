import assert from 'node:assert/strict';
import test from 'node:test';
import {
    classifyTelegramAdCandidate,
    messageToTelegramAdCandidate,
    normalizeTelegramAdText,
    telegramAdTextFingerprint,
    telegramAdTextSimilarity,
} from './telegramAdClassifier.js';

function message(input: Record<string, unknown>) {
    return { id: 1, message: '', entities: [], buttons: [], ...input } as any;
}

test('normalization removes volatile prices, dates and tracking parameters but keeps promotion identity', () => {
    const normalized = normalizeTelegramAdText('🔥 8月31日限时 88 元，联系 @Seller88 https://sale.example/a?utm_source=tg&code=9988');
    assert.match(normalized, /<date>/);
    assert.match(normalized, /<num>/);
    assert.match(normalized, /@seller88/);
    assert.match(normalized, /sale\.example\/a/);
    assert.doesNotMatch(normalized, /utm_source|9988/);
});

test('similar daily promotion copy has a stable fuzzy fingerprint', () => {
    const first = telegramAdTextFingerprint(normalizeTelegramAdText('今日特价 88 元，立即联系 @seller88 下单'));
    const second = telegramAdTextFingerprint(normalizeTelegramAdText('今日特价 99 元，立即联系 @seller88 下单'));
    assert.ok(telegramAdTextSimilarity(first, second) >= 0.84);
});

test('a marketing keyword alone is not enough to block an archive item', () => {
    const candidate = messageToTelegramAdCandidate([message({ message: '本期视频介绍软件优惠价格的计算方式' })]);
    const result = classifyTelegramAdCandidate(candidate, { mode: 'conservative', rules: [], history: [] });
    assert.equal(result.decision, 'allow');
    assert.ok(result.score < 40);
});

test('transaction intent plus call-to-action and external contact is high-confidence advertising', () => {
    const candidate = messageToTelegramAdCandidate([message({
        message: '限时优惠套餐，立即下单，联系客服 @cheap_shop_bot',
        buttons: [[{ text: '立即购买', url: 'https://cheap.example/register?ref=telegram' }]],
    })]);
    const result = classifyTelegramAdCandidate(candidate, { mode: 'conservative', rules: [], history: [] });
    assert.equal(result.decision, 'block');
    assert.ok(result.score >= 70);
    assert.ok(result.reasons.some(reason => reason.code === 'transaction_contact'));
    assert.ok(result.reasons.some(reason => reason.code === 'cta_link'));
});

test('channel allow rules override every heuristic and block rule', () => {
    const candidate = messageToTelegramAdCandidate([message({
        message: '限时优惠，立即注册联系客服 @official_bot',
        buttons: [[{ text: '立即注册', url: 'https://official.example/join' }]],
    })]);
    const result = classifyTelegramAdCandidate(candidate, {
        mode: 'aggressive',
        rules: [
            { id: 'block', kind: 'domain', action: 'block', pattern: 'official.example', enabled: true },
            { id: 'allow', kind: 'username', action: 'allow', pattern: '@official_bot', enabled: true },
        ],
        history: [],
    });
    assert.equal(result.decision, 'allow');
    assert.equal(result.score, 0);
    assert.ok(result.reasons.some(reason => reason.code === 'allow_rule'));
});

test('a manually confirmed similar template blocks future variants', () => {
    const oldText = normalizeTelegramAdText('商务推广：套餐 88 元，联系 @daily_agent');
    const candidate = messageToTelegramAdCandidate([message({ message: '商务推广：套餐 128 元，联系 @daily_agent' })]);
    const result = classifyTelegramAdCandidate(candidate, {
        mode: 'conservative',
        rules: [{
            id: 'template', kind: 'template', action: 'block', pattern: telegramAdTextFingerprint(oldText), enabled: true,
        }],
        history: [],
    });
    assert.equal(result.decision, 'block');
    assert.ok(result.reasons.some(reason => reason.code === 'blocked_template'));
});

test('aggressive mode blocks suspicious candidates while conservative mode keeps them', () => {
    const candidate = messageToTelegramAdCandidate([message({ message: '点击下方加入交流群 https://t.me/example_group' })]);
    const conservative = classifyTelegramAdCandidate(candidate, { mode: 'conservative', rules: [], history: [] });
    const aggressive = classifyTelegramAdCandidate(candidate, { mode: 'aggressive', rules: [], history: [] });
    assert.equal(conservative.decision, 'review');
    assert.equal(aggressive.decision, 'block');
});

test('a media group is classified as one candidate using captions, buttons and all message ids', () => {
    const candidate = messageToTelegramAdCandidate([
        message({ id: 10, groupedId: '777', message: '限时优惠套餐' }),
        message({ id: 11, groupedId: '777', message: '联系客服 @seller_bot', buttons: [[{ text: '立即下单', url: 'https://seller.example' }]] }),
    ]);
    assert.deepEqual(candidate.messageIds, [10, 11]);
    assert.equal(candidate.groupedId, '777');
    assert.ok(candidate.usernames.includes('@seller_bot'));
    assert.ok(candidate.domains.includes('seller.example'));
    assert.ok(classifyTelegramAdCandidate(candidate, { mode: 'conservative', rules: [], history: [] }).score >= 70);
});
