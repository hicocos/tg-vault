import { Router, type Request, type Response } from 'express';
import { pool, query } from '../db/index.js';
import { requireAuth } from './auth.js';
import { createSubscriptionDownloadJob } from '../services/telegramChannelJobs.js';
import { claimTelegramAdRestore, markTelegramAdRestoreFailure, markTelegramAdRestoreSuccess } from '../services/telegramAdRestore.js';
import {
    listTelegramSubscriptionAdDecisions,
    markTelegramSubscriptionAdDecision,
} from '../services/telegramSubscriptionAdFilter.js';
import type { TelegramAdFilterMode, TelegramAdRuleAction, TelegramAdRuleKind } from '../services/telegramAdClassifier.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set<TelegramAdFilterMode>(['off', 'conservative', 'aggressive']);
const RULE_KINDS = new Set<TelegramAdRuleKind>(['keyword', 'domain', 'username', 'template', 'media']);
const RULE_ACTIONS = new Set<TelegramAdRuleAction>(['allow', 'block']);

router.use((_req: Request, res: Response, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});

function validateUuid(value: unknown): string | null {
    const normalized = String(value || '').trim();
    return UUID_PATTERN.test(normalized) ? normalized : null;
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    try {
        const [subscriptions, totalResult, summaryResult] = await Promise.all([
            query(
                `SELECT s.id, s.user_id, s.chat_id, s.source, s.source_original, s.source_type, s.title, s.last_message_id,
                        s.folder_override, s.enabled, s.disabled_reason, s.disabled_at, s.last_scan_at, s.last_success_at,
                        s.last_error, s.last_result, s.next_scan_at, s.target_mode, s.target_provider, s.target_account_id,
                        s.ad_filter_mode, s.created_at, s.updated_at,
                        jsonb_build_object(
                            'blocked_count', COUNT(d.id) FILTER (WHERE d.decision = 'blocked'),
                            'review_count', COUNT(d.id) FILTER (WHERE d.decision = 'review'),
                            'reviewed_count', COUNT(d.id) FILTER (WHERE d.manual_label IS NOT NULL)
                        ) AS ad_stats
                 FROM telegram_channel_subscriptions s
                 LEFT JOIN telegram_subscription_ad_decisions d ON d.subscription_id = s.id
                 WHERE s.enabled = TRUE
                 GROUP BY s.id
                 ORDER BY s.updated_at DESC
                 LIMIT $1 OFFSET $2`,
                [limit, offset],
            ),
            query(`SELECT COUNT(*)::int AS total FROM telegram_channel_subscriptions s WHERE s.enabled = TRUE`),
            query(
                `SELECT COUNT(DISTINCT s.id)::int AS enabled,
                        COUNT(DISTINCT s.id) FILTER (WHERE s.ad_filter_mode <> 'off')::int AS protected,
                        COUNT(d.id) FILTER (WHERE d.decision = 'blocked')::int AS blocked,
                        COUNT(d.id) FILTER (WHERE d.decision = 'review')::int AS review
                 FROM telegram_channel_subscriptions s
                 LEFT JOIN telegram_subscription_ad_decisions d ON d.subscription_id = s.id
                 WHERE s.enabled = TRUE`,
            ),
        ]);
        res.json({
            subscriptions: subscriptions.rows,
            total: Number(totalResult.rows[0]?.total || 0),
            limit,
            offset,
            summary: summaryResult.rows[0] || { enabled: 0, protected: 0, blocked: 0, review: 0 },
        });
    } catch (error) {
        console.error('获取订阅中心失败:', error);
        res.status(500).json({ error: '获取订阅中心失败' });
    }
});

router.patch('/:subscriptionId', requireAuth, async (req: Request, res: Response) => {
    const subscriptionId = validateUuid(req.params.subscriptionId);
    if (!subscriptionId) return res.status(400).json({ error: '无效的订阅 ID' });
    const mode = String(req.body?.adFilterMode || '') as TelegramAdFilterMode;
    if (!MODES.has(mode)) return res.status(400).json({ error: '无效的广告过滤模式' });
    try {
        const result = await query(
            `UPDATE telegram_channel_subscriptions
             SET ad_filter_mode = $2, updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [subscriptionId, mode],
        );
        if (!result.rowCount) return res.status(404).json({ error: '订阅不存在' });
        res.json({ subscription: result.rows[0] });
    } catch (error) {
        console.error('更新订阅过滤模式失败:', error);
        res.status(500).json({ error: '更新订阅过滤模式失败' });
    }
});

router.get('/:subscriptionId/rules', requireAuth, async (req: Request, res: Response) => {
    const subscriptionId = validateUuid(req.params.subscriptionId);
    if (!subscriptionId) return res.status(400).json({ error: '无效的订阅 ID' });
    try {
        const result = await query(
            `SELECT id, subscription_id, kind, action, pattern, label, enabled, created_at, updated_at
             FROM telegram_subscription_ad_rules
             WHERE subscription_id = $1
             ORDER BY action ASC, kind ASC, created_at DESC`,
            [subscriptionId],
        );
        res.json({ rules: result.rows });
    } catch (error) {
        console.error('获取广告过滤规则失败:', error);
        res.status(500).json({ error: '获取广告过滤规则失败' });
    }
});

router.post('/:subscriptionId/rules', requireAuth, async (req: Request, res: Response) => {
    const subscriptionId = validateUuid(req.params.subscriptionId);
    if (!subscriptionId) return res.status(400).json({ error: '无效的订阅 ID' });
    const kind = String(req.body?.kind || '') as TelegramAdRuleKind;
    const action = String(req.body?.action || '') as TelegramAdRuleAction;
    const pattern = String(req.body?.pattern || '').trim();
    const label = String(req.body?.label || '').trim().slice(0, 200);
    if (!RULE_KINDS.has(kind) || !RULE_ACTIONS.has(action)) return res.status(400).json({ error: '无效的规则类型或动作' });
    if (!pattern || pattern.length > 2000) return res.status(400).json({ error: '规则内容不能为空且不能超过 2000 个字符' });
    try {
        const result = await query(
            `INSERT INTO telegram_subscription_ad_rules (subscription_id, kind, action, pattern, label)
             SELECT $1, $2, $3, $4, $5
             WHERE EXISTS (SELECT 1 FROM telegram_channel_subscriptions WHERE id = $1)
             ON CONFLICT (subscription_id, kind, action, pattern)
             DO UPDATE SET enabled = true, label = EXCLUDED.label, updated_at = NOW()
             RETURNING *`,
            [subscriptionId, kind, action, pattern, label || null],
        );
        if (!result.rowCount) return res.status(404).json({ error: '订阅不存在' });
        res.status(201).json({ rule: result.rows[0] });
    } catch (error) {
        console.error('创建广告过滤规则失败:', error);
        res.status(500).json({ error: '创建广告过滤规则失败' });
    }
});

router.patch('/:subscriptionId/rules/:ruleId', requireAuth, async (req: Request, res: Response) => {
    const subscriptionId = validateUuid(req.params.subscriptionId);
    const ruleId = validateUuid(req.params.ruleId);
    if (!subscriptionId || !ruleId) return res.status(400).json({ error: '无效的订阅或规则 ID' });
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔值' });
    try {
        const result = await query(
            `UPDATE telegram_subscription_ad_rules SET enabled = $3, updated_at = NOW()
             WHERE id = $2 AND subscription_id = $1 RETURNING *`,
            [subscriptionId, ruleId, req.body.enabled],
        );
        if (!result.rowCount) return res.status(404).json({ error: '规则不存在' });
        res.json({ rule: result.rows[0] });
    } catch (error) {
        console.error('更新广告过滤规则失败:', error);
        res.status(500).json({ error: '更新广告过滤规则失败' });
    }
});

router.delete('/:subscriptionId/rules/:ruleId', requireAuth, async (req: Request, res: Response) => {
    const subscriptionId = validateUuid(req.params.subscriptionId);
    const ruleId = validateUuid(req.params.ruleId);
    if (!subscriptionId || !ruleId) return res.status(400).json({ error: '无效的订阅或规则 ID' });
    try {
        const result = await query('DELETE FROM telegram_subscription_ad_rules WHERE id = $2 AND subscription_id = $1 RETURNING id', [subscriptionId, ruleId]);
        if (!result.rowCount) return res.status(404).json({ error: '规则不存在' });
        res.json({ success: true });
    } catch (error) {
        console.error('删除广告过滤规则失败:', error);
        res.status(500).json({ error: '删除广告过滤规则失败' });
    }
});

router.get('/decisions/list', requireAuth, async (req: Request, res: Response) => {
    const subscriptionId = req.query.subscriptionId ? (validateUuid(req.query.subscriptionId) || undefined) : undefined;
    if (req.query.subscriptionId && !subscriptionId) return res.status(400).json({ error: '无效的订阅 ID' });
    const decision = String(req.query.decision || '');
    if (decision && !['blocked', 'review', 'allow'].includes(decision)) return res.status(400).json({ error: '无效的判定状态' });
    try {
        res.json(await listTelegramSubscriptionAdDecisions({
            subscriptionId,
            decision: decision ? decision as 'blocked' | 'review' | 'allow' : undefined,
            limit: Number(req.query.limit || 50),
            offset: Number(req.query.offset || 0),
        }));
    } catch (error) {
        console.error('获取广告判定记录失败:', error);
        res.status(500).json({ error: '获取广告判定记录失败' });
    }
});

router.post('/decisions/:decisionId/review', requireAuth, async (req: Request, res: Response) => {
    const decisionId = validateUuid(req.params.decisionId);
    if (!decisionId) return res.status(400).json({ error: '无效的判定记录 ID' });
    const label = String(req.body?.label || '');
    if (!['ad', 'normal'].includes(label)) return res.status(400).json({ error: 'label 必须是 ad 或 normal' });
    let before: Awaited<ReturnType<typeof claimTelegramAdRestore>>;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        before = await claimTelegramAdRestore(client, decisionId, label === 'normal');
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error('锁定广告恢复记录失败:', error);
        return res.status(500).json({ error: '锁定广告恢复记录失败' });
    } finally {
        client.release();
    }
    if (before.kind === 'missing' || !before.row) return res.status(404).json({ error: '判定记录不存在' });
    if (before.kind === 'in_progress') return res.status(409).json({ error: '该内容正在恢复下载，请稍后刷新查看' });
    try {
        let restoredJobId: string | null = before.restoredJobId || null;
        if (label === 'normal' && before.row.decision === 'blocked' && !restoredJobId) {
            restoredJobId = await createSubscriptionDownloadJob({
                subscriptionId: String(before.row.subscription_id),
                decisionId,
                userId: Number(before.row.user_id),
                chatId: before.row.chat_id === null ? null : Number(before.row.chat_id),
                source: String(before.row.source_peer),
                folderOverride: before.row.folder_override || null,
                messageIds: Array.isArray(before.row.message_ids) ? before.row.message_ids.map(Number) : [],
            });
            await markTelegramAdRestoreSuccess(decisionId, restoredJobId);
        }
        const decision = await markTelegramSubscriptionAdDecision({ decisionId, label: label as 'ad' | 'normal', learnTemplate: req.body?.learnTemplate !== false });
        return res.json({ decision, restoredJobId });
    } catch (error) {
        if (label === 'normal' && before.row.decision === 'blocked' && !before.restoredJobId) {
            await markTelegramAdRestoreFailure(decisionId, error).catch(() => undefined);
        }
        console.error('人工修正广告判定失败:', error);
        return res.status(400).json({ error: error instanceof Error ? error.message : '人工修正广告判定失败' });
    }
});

export default router;
