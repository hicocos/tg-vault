import type { Api } from 'telegram';
import { query, pool } from '../db/index.js';
import {
    classifyTelegramAdCandidate,
    messageToTelegramAdCandidate,
    type TelegramAdFilterMode,
    type TelegramAdRule,
} from './telegramAdClassifier.js';

export interface TelegramSubscriptionAdFilterResult {
    allowedMessages: Api.Message[];
    blockedMessageIds: number[];
    reviewedMessageIds: number[];
    blockedGroups: number;
}

interface TelegramAdDecisionInput {
    subscriptionId: string;
    sourcePeer: string;
    mode: TelegramAdFilterMode;
    messages: Api.Message[];
}

function groupKey(message: any): string {
    return message.groupedId == null ? `message:${Number(message.id)}` : `group:${String(message.groupedId)}`;
}

function normalizeMode(value: unknown): TelegramAdFilterMode {
    return value === 'conservative' || value === 'aggressive' ? value : 'off';
}

export async function getTelegramSubscriptionAdRules(subscriptionId: string): Promise<TelegramAdRule[]> {
    const result = await query(
        `SELECT id, kind, action, pattern, enabled
         FROM telegram_subscription_ad_rules
         WHERE subscription_id = $1 AND enabled = true
         ORDER BY created_at ASC`,
        [subscriptionId],
    );
    return result.rows.map(row => ({
        id: String(row.id),
        kind: row.kind,
        action: row.action,
        pattern: String(row.pattern),
        enabled: Boolean(row.enabled),
    }));
}

async function getHistory(subscriptionId: string) {
    const result = await query(
        `SELECT text_fingerprint AS fingerprint, manual_label AS decision, COUNT(*)::int AS confirmations
         FROM telegram_subscription_ad_decisions
         WHERE subscription_id = $1
           AND manual_label IS NOT NULL
           AND text_fingerprint IS NOT NULL
           AND text_fingerprint <> ''
         GROUP BY text_fingerprint, manual_label
         ORDER BY MAX(manually_reviewed_at) DESC
         LIMIT 200`,
        [subscriptionId],
    );
    return result.rows.map(row => ({
        fingerprint: String(row.fingerprint),
        decision: row.decision as 'ad' | 'normal',
        confirmations: Number(row.confirmations || 0),
    }));
}

async function persistDecision(input: TelegramAdDecisionInput, decision: ReturnType<typeof classifyTelegramAdCandidate>): Promise<void> {
    const candidate = messageToTelegramAdCandidate(input.messages);
    const primaryMessageId = Math.min(...candidate.messageIds);
    await query(
        `INSERT INTO telegram_subscription_ad_decisions
            (subscription_id, source_peer, message_id, grouped_id, message_ids, decision, score, reasons,
             text_excerpt, text_fingerprint, domains, usernames, media_keys, matched_rule_ids)
         VALUES ($1, $2, $3, $4, $5::int[], $6, $7, $8::jsonb, $9, $10, $11::text[], $12::text[], $13::text[], $14::uuid[])
         ON CONFLICT (subscription_id, source_peer, message_id)
         DO UPDATE SET grouped_id = EXCLUDED.grouped_id, message_ids = EXCLUDED.message_ids,
                       decision = EXCLUDED.decision, score = EXCLUDED.score, reasons = EXCLUDED.reasons,
                       text_excerpt = EXCLUDED.text_excerpt, text_fingerprint = EXCLUDED.text_fingerprint,
                       domains = EXCLUDED.domains, usernames = EXCLUDED.usernames, media_keys = EXCLUDED.media_keys,
                       matched_rule_ids = EXCLUDED.matched_rule_ids, updated_at = NOW()
         WHERE telegram_subscription_ad_decisions.manual_label IS NULL`,
        [
            input.subscriptionId,
            input.sourcePeer,
            primaryMessageId,
            candidate.groupedId,
            candidate.messageIds,
            decision.decision === 'block' ? 'blocked' : decision.decision,
            decision.score,
            JSON.stringify(decision.reasons),
            candidate.text.slice(0, 1000) || null,
            candidate.textFingerprint || null,
            candidate.domains,
            candidate.usernames,
            candidate.mediaKeys,
            decision.matchedRuleIds,
        ],
    );
}

export async function filterTelegramSubscriptionAdvertisements(input: TelegramAdDecisionInput): Promise<TelegramSubscriptionAdFilterResult> {
    const mode = normalizeMode(input.mode);
    if (mode === 'off' || input.messages.length === 0) {
        return { allowedMessages: input.messages, blockedMessageIds: [], reviewedMessageIds: [], blockedGroups: 0 };
    }
    const [rules, history] = await Promise.all([
        getTelegramSubscriptionAdRules(input.subscriptionId),
        getHistory(input.subscriptionId),
    ]);
    const groups = new Map<string, Api.Message[]>();
    for (const message of input.messages) {
        const key = groupKey(message);
        groups.set(key, [...(groups.get(key) || []), message]);
    }
    const allowedMessages: Api.Message[] = [];
    const blockedMessageIds: number[] = [];
    const reviewedMessageIds: number[] = [];
    let blockedGroups = 0;
    for (const messages of groups.values()) {
        const candidate = messageToTelegramAdCandidate(messages);
        const decision = classifyTelegramAdCandidate(candidate, { mode, rules, history });
        await persistDecision({ ...input, messages }, decision);
        if (decision.decision === 'block') {
            blockedGroups += 1;
            blockedMessageIds.push(...candidate.messageIds);
            continue;
        }
        allowedMessages.push(...messages);
        if (decision.decision === 'review') reviewedMessageIds.push(...candidate.messageIds);
    }
    return { allowedMessages, blockedMessageIds, reviewedMessageIds, blockedGroups };
}

export async function listTelegramSubscriptionAdDecisions(input: {
    subscriptionId?: string;
    decision?: 'blocked' | 'review' | 'allow';
    limit?: number;
    offset?: number;
}) {
    const limit = Math.max(1, Math.min(200, Number(input.limit || 50)));
    const offset = Math.max(0, Number(input.offset || 0));
    const result = await query(
        `SELECT d.*, s.title AS subscription_title, s.source AS subscription_source
         FROM telegram_subscription_ad_decisions d
         JOIN telegram_channel_subscriptions s ON s.id = d.subscription_id
         WHERE s.enabled = TRUE
           AND ($1::uuid IS NULL OR d.subscription_id = $1::uuid)
           AND ($2::text IS NULL OR d.decision = $2::text)
         ORDER BY d.created_at DESC
         LIMIT $3 OFFSET $4`,
        [input.subscriptionId || null, input.decision || null, limit, offset],
    );
    const total = await query(
        `SELECT COUNT(*)::int AS total
         FROM telegram_subscription_ad_decisions d
         JOIN telegram_channel_subscriptions s ON s.id = d.subscription_id
         WHERE s.enabled = TRUE
           AND ($1::uuid IS NULL OR d.subscription_id = $1::uuid)
           AND ($2::text IS NULL OR d.decision = $2::text)`,
        [input.subscriptionId || null, input.decision || null],
    );
    return { decisions: result.rows, total: Number(total.rows[0]?.total || 0), limit, offset };
}

export async function markTelegramSubscriptionAdDecision(input: {
    decisionId: string;
    label: 'ad' | 'normal';
    learnTemplate?: boolean;
}) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const updated = await client.query(
            `UPDATE telegram_subscription_ad_decisions
             SET manual_label = $2, manually_reviewed_at = NOW(),
                 decision = CASE WHEN $2 = 'ad' THEN 'blocked' ELSE 'allow' END,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [input.decisionId, input.label],
        );
        const row = updated.rows[0];
        if (!row) {
            await client.query('ROLLBACK');
            return null;
        }
        if (input.learnTemplate && row.text_fingerprint) {
            await client.query(
                `INSERT INTO telegram_subscription_ad_rules (subscription_id, kind, action, pattern, label)
                 VALUES ($1, 'template', $2, $3, $4)
                 ON CONFLICT (subscription_id, kind, action, pattern)
                 DO UPDATE SET enabled = true, label = EXCLUDED.label, updated_at = NOW()`,
                [row.subscription_id, input.label === 'ad' ? 'block' : 'allow', row.text_fingerprint, input.label === 'ad' ? '人工确认的广告模板' : '人工确认的正常模板'],
            );
        }
        await client.query('COMMIT');
        return row;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}
