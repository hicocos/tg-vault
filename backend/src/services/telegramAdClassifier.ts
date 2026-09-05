import type { Api } from 'telegram';
import { DEFAULT_LOCALE, t, type TelegramLocale } from '../i18n/telegram.js';

export type TelegramAdFilterMode = 'off' | 'conservative' | 'aggressive';
export type TelegramAdDecision = 'allow' | 'review' | 'block';
export type TelegramAdRuleKind = 'keyword' | 'domain' | 'username' | 'template' | 'media';
export type TelegramAdRuleAction = 'allow' | 'block';

export interface TelegramAdRule {
    id: string;
    kind: TelegramAdRuleKind;
    action: TelegramAdRuleAction;
    pattern: string;
    enabled: boolean;
}

export interface TelegramAdHistoryTemplate {
    fingerprint: string;
    decision: 'ad' | 'normal';
    confirmations: number;
}

export interface TelegramAdCandidate {
    messageIds: number[];
    groupedId: string | null;
    text: string;
    normalizedText: string;
    textFingerprint: string;
    domains: string[];
    usernames: string[];
    urls: string[];
    buttonTexts: string[];
    mediaKeys: string[];
}

export interface TelegramAdReason {
    code: string;
    label: string;
    score: number;
    ruleId?: string;
}

export interface TelegramAdClassification {
    decision: TelegramAdDecision;
    score: number;
    reasons: TelegramAdReason[];
    matchedRuleIds: string[];
}

interface TelegramAdClassificationOptions {
    mode: TelegramAdFilterMode;
    rules: TelegramAdRule[];
    history: TelegramAdHistoryTemplate[];
    locale?: TelegramLocale;
}

const TRACKING_QUERY_KEYS = /^(utm_.+|fbclid|gclid|yclid|ref|referrer|source|campaign|code)$/i;
const TRANSACTION_PATTERN = /(优惠|特价|折扣|返利|佣金|套餐|购买|下单|价格|售价|充值|提现|担保|代理|免费领取|限时|名额|商务推广|广告投放|sale|discount|buy|price|order|commission|promo)/i;
const CTA_PATTERN = /(立即|点击|加入|联系|客服|咨询|私聊|扫码|注册|领取|下载\s*app|进群|下单|购买|马上|戳我|click|join|contact|register|buy now)/i;
const CONTACT_PATTERN = /(联系|客服|咨询|私聊|微信|telegram|tg|whatsapp|商务|代理|邮箱|email)/i;
const SCARCITY_PATTERN = /(仅限今天|最后名额|马上截止|手慢无|稳赚不赔|高收益|官方授权|限时|last chance|limited time)/i;
const URL_PATTERN = /https?:\/\/[^\s<>"'）)\]]+/gi;
const USERNAME_PATTERN = /@[a-zA-Z][a-zA-Z0-9_]{3,31}/g;

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function normalizeDomain(value: string): string {
    const lowered = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    return lowered.split('/')[0].split('?')[0].replace(/\.$/, '');
}

function stableUrl(raw: string): string {
    try {
        const url = new URL(raw);
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) {
            if (TRACKING_QUERY_KEYS.test(key)) url.searchParams.delete(key);
        }
        const query = url.searchParams.toString();
        return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${query ? `?${query}` : ''}`;
    } catch {
        return raw.toLowerCase();
    }
}

export function normalizeTelegramAdText(text: string): string {
    return text
        .normalize('NFKC')
        .toLowerCase()
        .replace(URL_PATTERN, value => stableUrl(value))
        .replace(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, '<date>')
        .replace(/\d{1,2}月\d{1,2}日/g, '<date>')
        .replace(/\d{1,2}[-/.]\d{1,2}/g, '<date>')
        .replace(/(?:¥|￥|\$|usd\s*)?\d+(?:\.\d{1,2})?\s*(?:元|块|rmb|usd|刀)/gi, '<num>')
        .replace(/\b\d+(?:\.\d+)?\b/g, '<num>')
        .replace(/[🔥🎉💰💵✅🚀📣📢👉🎁💥⭐🌟❗❕]+/gu, ' ')
        .replace(/[^\p{L}\p{N}@._:/?=&<>\s-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function trigrams(value: string): Set<string> {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (compact.length <= 3) return new Set(compact ? [compact] : []);
    const result = new Set<string>();
    for (let index = 0; index <= compact.length - 3; index += 1) result.add(compact.slice(index, index + 3));
    return result;
}

export function telegramAdTextFingerprint(normalizedText: string): string {
    return normalizeTelegramAdText(normalizedText);
}

export function telegramAdTextSimilarity(firstFingerprint: string, secondFingerprint: string): number {
    const first = trigrams(firstFingerprint);
    const second = trigrams(secondFingerprint);
    if (first.size === 0 && second.size === 0) return 1;
    if (first.size === 0 || second.size === 0) return 0;
    let intersection = 0;
    for (const item of first) if (second.has(item)) intersection += 1;
    return intersection / (first.size + second.size - intersection);
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function collectButtons(value: unknown, texts: string[], urls: string[]): void {
    if (!value) return;
    if (Array.isArray(value)) {
        for (const item of value) collectButtons(item, texts, urls);
        return;
    }
    if (typeof value !== 'object') return;
    const button = value as Record<string, unknown>;
    const text = stringValue(button.text);
    const url = stringValue(button.url);
    if (text) texts.push(text);
    if (url) urls.push(url);
    for (const nested of ['button', 'buttons', 'rows']) collectButtons(button[nested], texts, urls);
}

function mediaKeysForMessage(message: any): string[] {
    const values: string[] = [];
    const photo = message?.photo || message?.media?.photo;
    const document = message?.document || message?.media?.document;
    if (photo?.id != null) values.push(`photo:${String(photo.id)}`);
    if (document?.id != null) values.push(`document:${String(document.id)}`);
    const mime = stringValue(document?.mimeType);
    const size = document?.size == null ? '' : String(document.size);
    const dimensions = Array.isArray(photo?.sizes)
        ? photo.sizes.map((item: any) => `${item?.w || 0}x${item?.h || 0}`).join(',')
        : '';
    if (mime || size || dimensions) values.push(`meta:${mime}:${size}:${dimensions}`);
    return values;
}

export function messageToTelegramAdCandidate(messages: Api.Message[]): TelegramAdCandidate {
    const sorted = [...messages].sort((a, b) => Number(a.id) - Number(b.id));
    const textParts: string[] = [];
    const urls: string[] = [];
    const buttonTexts: string[] = [];
    const mediaKeys: string[] = [];
    for (const message of sorted as any[]) {
        const text = stringValue(message.message || message.text || message.caption);
        if (text) {
            textParts.push(text);
            urls.push(...(text.match(URL_PATTERN) || []));
        }
        collectButtons(message.buttons || message.replyMarkup, buttonTexts, urls);
        mediaKeys.push(...mediaKeysForMessage(message));
    }
    const text = [...textParts, ...buttonTexts].join('\n').trim();
    const normalizedText = normalizeTelegramAdText(text);
    const normalizedUrls = unique(urls.map(stableUrl));
    const domains = unique(normalizedUrls.map(normalizeDomain));
    const usernames = unique((`${text}\n${normalizedUrls.join('\n')}`.match(USERNAME_PATTERN) || []).map(value => value.toLowerCase()));
    const groupedValue = (sorted[0] as any)?.groupedId;
    return {
        messageIds: sorted.map(message => Number(message.id)),
        groupedId: groupedValue == null ? null : String(groupedValue),
        text,
        normalizedText,
        textFingerprint: telegramAdTextFingerprint(normalizedText),
        domains,
        usernames,
        urls: normalizedUrls,
        buttonTexts: unique(buttonTexts),
        mediaKeys: unique(mediaKeys),
    };
}

function matchesRule(candidate: TelegramAdCandidate, rule: TelegramAdRule): boolean {
    const pattern = rule.pattern.trim().toLowerCase();
    if (!pattern) return false;
    if (rule.kind === 'domain') {
        const expected = normalizeDomain(pattern);
        return candidate.domains.some(domain => domain === expected || domain.endsWith(`.${expected}`));
    }
    if (rule.kind === 'username') {
        const expected = pattern.startsWith('@') ? pattern : `@${pattern}`;
        return candidate.usernames.includes(expected);
    }
    if (rule.kind === 'keyword') return candidate.normalizedText.includes(normalizeTelegramAdText(pattern));
    if (rule.kind === 'media') return candidate.mediaKeys.includes(pattern) || candidate.mediaKeys.some(key => key.toLowerCase() === pattern);
    if (rule.kind === 'template') return telegramAdTextSimilarity(candidate.textFingerprint, pattern) >= 0.82;
    return false;
}

export function classifyTelegramAdCandidate(candidate: TelegramAdCandidate, options: TelegramAdClassificationOptions): TelegramAdClassification {
    if (options.mode === 'off') return { decision: 'allow', score: 0, reasons: [], matchedRuleIds: [] };
    const enabledRules = options.rules.filter(rule => rule.enabled);
    const allowRules = enabledRules.filter(rule => rule.action === 'allow' && matchesRule(candidate, rule));
    if (allowRules.length > 0) {
        return {
            decision: 'allow', score: 0,
            reasons: allowRules.map(rule => ({ code: 'allow_rule', label: t(options.locale || DEFAULT_LOCALE, 'ads.reason.allowRule'), score: -100, ruleId: rule.id })),
            matchedRuleIds: allowRules.map(rule => rule.id),
        };
    }

    let score = 0;
    const reasons: TelegramAdReason[] = [];
    const matchedRuleIds: string[] = [];
    const add = (code: string, label: string, points: number, ruleId?: string) => {
        score += points;
        reasons.push({ code, label, score: points, ruleId });
        if (ruleId) matchedRuleIds.push(ruleId);
    };

    for (const rule of enabledRules.filter(rule => rule.action === 'block' && matchesRule(candidate, rule))) {
        const points = rule.kind === 'template' ? 90 : rule.kind === 'domain' || rule.kind === 'username' || rule.kind === 'media' ? 100 : 70;
        add(
            rule.kind === 'template' ? 'blocked_template' : 'block_rule',
            t(options.locale || DEFAULT_LOCALE, rule.kind === 'template' ? 'ads.reason.blockedTemplate' : 'ads.reason.blockRule'),
            points,
            rule.id,
        );
    }

    const normalHistory = options.history.filter(item => item.decision === 'normal' && item.confirmations > 0);
    const adHistory = options.history.filter(item => item.decision === 'ad' && item.confirmations > 0);
    const normalSimilarity = Math.max(0, ...normalHistory.map(item => telegramAdTextSimilarity(candidate.textFingerprint, item.fingerprint)));
    const adSimilarity = Math.max(0, ...adHistory.map(item => telegramAdTextSimilarity(candidate.textFingerprint, item.fingerprint)));
    if (normalSimilarity >= 0.82) add('normal_template', t(options.locale || DEFAULT_LOCALE, 'ads.reason.normalTemplate'), -50);
    else if (adSimilarity >= 0.82) add('ad_history_template', t(options.locale || DEFAULT_LOCALE, 'ads.reason.adHistoryTemplate'), 60);

    const hasTransaction = TRANSACTION_PATTERN.test(candidate.text);
    const hasCta = CTA_PATTERN.test(`${candidate.text}\n${candidate.buttonTexts.join('\n')}`);
    const hasContact = CONTACT_PATTERN.test(candidate.text) && (candidate.usernames.length > 0 || candidate.urls.length > 0);
    const hasExternalTarget = candidate.urls.length > 0 || candidate.usernames.length > 0;
    if (hasTransaction && hasContact) add('transaction_contact', t(options.locale || DEFAULT_LOCALE, 'ads.reason.transactionContact'), 35);
    else if (hasTransaction) add('transaction_intent', t(options.locale || DEFAULT_LOCALE, 'ads.reason.transactionIntent'), 15);
    if (hasCta && hasExternalTarget) add('cta_link', t(options.locale || DEFAULT_LOCALE, 'ads.reason.ctaLink'), 40);
    else if (hasCta) add('call_to_action', t(options.locale || DEFAULT_LOCALE, 'ads.reason.callToAction'), 10);
    if (candidate.urls.length + candidate.usernames.length >= 3) add('link_density', t(options.locale || DEFAULT_LOCALE, 'ads.reason.linkDensity'), 15);
    if (SCARCITY_PATTERN.test(candidate.text)) add('scarcity', t(options.locale || DEFAULT_LOCALE, 'ads.reason.scarcity'), 10);
    const emojiCount = (candidate.text.match(/\p{Extended_Pictographic}/gu) || []).length;
    if (emojiCount >= 6) add('decorative_marketing', t(options.locale || DEFAULT_LOCALE, 'ads.reason.decorativeMarketing'), 5);

    score = Math.max(0, Math.min(100, score));
    const decision: TelegramAdDecision = score >= 70
        ? 'block'
        : score >= 40
            ? options.mode === 'aggressive' ? 'block' : 'review'
            : 'allow';
    return { decision, score, reasons, matchedRuleIds: unique(matchedRuleIds) };
}
