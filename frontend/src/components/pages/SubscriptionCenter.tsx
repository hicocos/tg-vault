import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Ban, Check, CheckCircle2, Filter, ListFilter, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import fileApi from '../../services/api';
import type {
    TelegramAdDecision,
    TelegramAdFilterMode,
    TelegramAdRule,
    TelegramAdRuleAction,
    TelegramAdRuleKind,
    TelegramSubscription,
} from '../../services/apiTypes';
import { cn } from '../../lib/utils';
import { errorMessage } from '../../services/unknownError';
import { isUnauthorizedError } from '../../services/apiActionError';

interface SubscriptionCenterProps { onUnauthorized?: () => void; }
type Tab = 'subscriptions' | 'records';
const SUBSCRIPTION_PAGE_SIZE = 20;
const DECISION_PAGE_SIZE = 20;

const MODES: Array<{ value: TelegramAdFilterMode; label: string; detail: string }> = [
    { value: 'off', label: '关闭', detail: '所有内容照常下载' },
    { value: 'conservative', label: '保守', detail: '只过滤高可信广告，疑似内容仍保存' },
    { value: 'aggressive', label: '严格', detail: '高可信和疑似广告都不下载' },
];
const RULE_KINDS: Array<{ value: TelegramAdRuleKind; label: string; placeholder: string }> = [
    { value: 'keyword', label: '文案包含', placeholder: '例如：限时代理招募' },
    { value: 'domain', label: '链接域名', placeholder: '例如：promo.example.com' },
    { value: 'username', label: '账号或机器人', placeholder: '例如：@seller_bot' },
];

function dateLabel(value: string | null): string {
    if (!value) return '暂无';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function modeTone(mode: TelegramAdFilterMode): string {
    if (mode === 'conservative') return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-300';
    if (mode === 'aggressive') return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-300';
    return 'border-border bg-muted text-muted-foreground';
}

function decisionTone(decision: TelegramAdDecision['decision']): string {
    if (decision === 'blocked') return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/35 dark:text-red-300';
    if (decision === 'review') return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-300';
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-300';
}

export function SubscriptionCenter({ onUnauthorized }: SubscriptionCenterProps) {
    const [tab, setTab] = useState<Tab>('subscriptions');
    const [subscriptions, setSubscriptions] = useState<TelegramSubscription[]>([]);
    const [subscriptionTotal, setSubscriptionTotal] = useState(0);
    const [subscriptionPage, setSubscriptionPage] = useState(1);
    const [summary, setSummary] = useState({ enabled: 0, protected: 0, blocked: 0, review: 0 });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [rules, setRules] = useState<TelegramAdRule[]>([]);
    const [decisions, setDecisions] = useState<TelegramAdDecision[]>([]);
    const [decisionTotal, setDecisionTotal] = useState(0);
    const [decisionPage, setDecisionPage] = useState(1);
    const [decisionFilter, setDecisionFilter] = useState<'' | 'blocked' | 'review' | 'allow'>('');
    const [ruleKind, setRuleKind] = useState<TelegramAdRuleKind>('domain');
    const [ruleAction, setRuleAction] = useState<TelegramAdRuleAction>('block');
    const [rulePattern, setRulePattern] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const selected = subscriptions.find(item => item.id === selectedId) || null;

    const handleError = useCallback((caught: unknown, fallback: string) => {
        if (isUnauthorizedError(caught)) return void onUnauthorized?.();
        setError(errorMessage(caught, fallback));
    }, [onUnauthorized]);

    const loadSubscriptions = useCallback(async () => {
        try {
            const result = await fileApi.getSubscriptions({ limit: SUBSCRIPTION_PAGE_SIZE, offset: (subscriptionPage - 1) * SUBSCRIPTION_PAGE_SIZE });
            const items = result.subscriptions;
            setSubscriptions(items);
            setSubscriptionTotal(result.total);
            setSummary(result.summary);
            setSelectedId(current => current && items.some(item => item.id === current) ? current : items[0]?.id || null);
            setError(null);
        } catch (caught) { handleError(caught, '获取订阅列表失败'); }
        finally { setLoading(false); }
    }, [handleError, subscriptionPage]);

    const loadRules = useCallback(async (subscriptionId: string) => {
        try { setRules(await fileApi.getSubscriptionAdRules(subscriptionId)); }
        catch (caught) { handleError(caught, '获取过滤规则失败'); }
    }, [handleError]);

    const loadDecisions = useCallback(async () => {
        try {
            const result = await fileApi.getSubscriptionAdDecisions({
                subscriptionId: selectedId || undefined,
                decision: decisionFilter || undefined,
                limit: DECISION_PAGE_SIZE,
                offset: (decisionPage - 1) * DECISION_PAGE_SIZE,
            });
            setDecisions(result.decisions);
            setDecisionTotal(result.total);
        } catch (caught) { handleError(caught, '获取过滤记录失败'); }
    }, [decisionFilter, decisionPage, handleError, selectedId]);

    useEffect(() => { void loadSubscriptions(); }, [loadSubscriptions]);
    useEffect(() => { if (selectedId) void loadRules(selectedId); else setRules([]); }, [loadRules, selectedId]);
    useEffect(() => { setDecisionPage(1); }, [decisionFilter, selectedId]);
    useEffect(() => { if (tab === 'records') void loadDecisions(); }, [loadDecisions, tab]);

    const updateMode = async (mode: TelegramAdFilterMode) => {
        if (!selected) return;
        setSaving(true); setError(null);
        try {
            await fileApi.updateSubscriptionAdFilter(selected.id, mode);
            await loadSubscriptions();
        } catch (caught) { handleError(caught, '更新过滤模式失败'); }
        finally { setSaving(false); }
    };

    const addRule = async () => {
        if (!selected || !rulePattern.trim()) return;
        setSaving(true); setError(null);
        try {
            await fileApi.createSubscriptionAdRule(selected.id, { kind: ruleKind, action: ruleAction, pattern: rulePattern.trim() });
            setRulePattern(''); await loadRules(selected.id);
        } catch (caught) { handleError(caught, '创建过滤规则失败'); }
        finally { setSaving(false); }
    };

    const toggleRule = async (rule: TelegramAdRule) => {
        if (!selected) return;
        setSaving(true);
        try { await fileApi.setSubscriptionAdRuleEnabled(selected.id, rule.id, !rule.enabled); await loadRules(selected.id); }
        catch (caught) { handleError(caught, '更新规则失败'); }
        finally { setSaving(false); }
    };

    const removeRule = async (rule: TelegramAdRule) => {
        if (!selected) return;
        setSaving(true);
        try { await fileApi.deleteSubscriptionAdRule(selected.id, rule.id); await loadRules(selected.id); }
        catch (caught) { handleError(caught, '删除规则失败'); }
        finally { setSaving(false); }
    };

    const review = async (decision: TelegramAdDecision, label: 'ad' | 'normal') => {
        setSaving(true); setError(null);
        try {
            const result = await fileApi.reviewSubscriptionAdDecision(decision.id, label, true);
            if (result.restoredJobId) setError('已纠正为正常内容，并重新加入下载队列。');
            await Promise.all([loadDecisions(), loadSubscriptions(), selectedId ? loadRules(selectedId) : Promise.resolve()]);
        } catch (caught) { handleError(caught, '修正过滤结果失败'); }
        finally { setSaving(false); }
    };

    if (loading) return <div className="mx-auto max-w-7xl py-16 text-center text-sm text-muted-foreground">正在加载订阅中心…</div>;

    const subscriptionPages = Math.max(1, Math.ceil(subscriptionTotal / SUBSCRIPTION_PAGE_SIZE));
    const decisionPages = Math.max(1, Math.ceil(decisionTotal / DECISION_PAGE_SIZE));

    const Pagination = ({ page, pages, total, onChange }: { page: number; pages: number; total: number; onChange: (page: number) => void }) => (
        <div className="flex flex-col gap-2 border-t px-3 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>共 {total} 条 · 第 {page}/{pages} 页</span>
            <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</Button>
                <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</Button>
            </div>
        </div>
    );

    return (
        <div className="mx-auto min-h-full max-w-7xl space-y-5">
            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <div className="flex items-center gap-2 text-sm font-medium text-primary"><ShieldCheck className="h-4 w-4" />频道归档保护</div>
                    <h2 className="mt-1 text-2xl font-bold">订阅中心</h2>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">集中管理频道同步与广告过滤。过滤发生在下载任务创建前，命中内容不会写入存储。</p>
                </div>
                <Button variant="outline" className="gap-2 self-start lg:self-auto" onClick={() => { void loadSubscriptions(); if (tab === 'records') void loadDecisions(); }}>
                    <RefreshCw className="h-4 w-4" />刷新
                </Button>
            </header>

            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                    ['启用订阅', summary.enabled, '个频道正在同步'], ['已开启保护', summary.protected, '个频道启用过滤'],
                    ['已拦截', summary.blocked, '组内容未下载'], ['待留意', summary.review, '条疑似广告'],
                ].map(([label, value, detail]) => <div key={String(label)} className="rounded-xl border bg-card p-4 shadow-sm"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>)}
            </section>

            {error && <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/35 dark:text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}

            <div className="inline-flex rounded-lg border bg-muted/50 p-1">
                <button type="button" onClick={() => setTab('subscriptions')} className={cn('rounded-md px-4 py-2 text-sm font-medium transition-colors', tab === 'subscriptions' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}>订阅与规则</button>
                <button type="button" onClick={() => setTab('records')} className={cn('rounded-md px-4 py-2 text-sm font-medium transition-colors', tab === 'records' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}>过滤记录</button>
            </div>

            {tab === 'subscriptions' ? (
                subscriptions.length === 0 ? <div className="flex flex-col items-center justify-center rounded-xl border bg-card py-20 text-center"><ListFilter className="h-12 w-12 text-muted-foreground/50" /><h3 className="mt-4 text-lg font-semibold">暂无启用中的频道订阅</h3><p className="mt-1 max-w-sm text-sm text-muted-foreground">请先通过 Telegram Bot 新增或恢复订阅，随后可在这里配置过滤。</p></div> :
                <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
                    <aside className="overflow-hidden rounded-xl border bg-card shadow-sm">
                        <div className="max-h-[640px] space-y-2 overflow-y-auto p-2">
                        {subscriptions.map(item => (
                            <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} className={cn('w-full rounded-lg border px-3 py-3 text-left transition-colors', selectedId === item.id ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:bg-muted/60')}>
                                <div className="flex items-start justify-between gap-2"><span className="truncate text-sm font-semibold">{item.title || item.source}</span><span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', modeTone(item.ad_filter_mode))}>{MODES.find(mode => mode.value === item.ad_filter_mode)?.label}</span></div>
                                <p className="mt-1 truncate text-xs text-muted-foreground">{item.source_original || item.source}</p>
                                <div className="mt-2 flex gap-3 text-[11px] text-muted-foreground"><span>同步中</span><span>拦截 {item.ad_stats?.blocked_count || 0}</span><span>待留意 {item.ad_stats?.review_count || 0}</span></div>
                            </button>
                        ))}
                        </div>
                        <Pagination page={subscriptionPage} pages={subscriptionPages} total={subscriptionTotal} onChange={setSubscriptionPage} />
                    </aside>
                    {selected && <main className="space-y-5">
                        <section className="rounded-xl border bg-card p-5 shadow-sm">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h3 className="text-lg font-semibold">{selected.title || selected.source}</h3><p className="mt-1 text-sm text-muted-foreground">最近扫描 {dateLabel(selected.last_scan_at)} · 消息进度 #{selected.last_message_id}</p></div><span className={cn('self-start rounded-full border px-2.5 py-1 text-xs font-medium', selected.enabled ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-300' : 'border-border bg-muted text-muted-foreground')}>{selected.enabled ? '订阅已启用' : '订阅已停用'}</span></div>
                            <div className="mt-5 grid gap-3 md:grid-cols-3">{MODES.map(mode => <button key={mode.value} disabled={saving} type="button" onClick={() => void updateMode(mode.value)} className={cn('rounded-lg border p-4 text-left transition-all disabled:opacity-60', selected.ad_filter_mode === mode.value ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'hover:border-primary/30 hover:bg-muted/30')}><div className="flex items-center justify-between"><span className="font-semibold">{mode.label}</span>{selected.ad_filter_mode === mode.value && <CheckCircle2 className="h-4 w-4 text-primary" />}</div><p className="mt-2 text-xs leading-5 text-muted-foreground">{mode.detail}</p></button>)}</div>
                        </section>
                        <section className="rounded-xl border bg-card p-5 shadow-sm">
                            <div className="flex items-center gap-2"><Filter className="h-4 w-4 text-primary" /><h3 className="font-semibold">频道规则</h3></div>
                            <p className="mt-1 text-sm text-muted-foreground">允许规则优先级最高；屏蔽规则只作用于当前频道。</p>
                            <div className="mt-4 grid gap-2 sm:grid-cols-[130px_130px_minmax(0,1fr)_auto]">
                                <select value={ruleAction} onChange={event => setRuleAction(event.target.value as TelegramAdRuleAction)} className="h-10 rounded-md border bg-background px-3 text-sm"><option value="block">屏蔽</option><option value="allow">始终允许</option></select>
                                <select value={ruleKind} onChange={event => setRuleKind(event.target.value as TelegramAdRuleKind)} className="h-10 rounded-md border bg-background px-3 text-sm">{RULE_KINDS.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select>
                                <input value={rulePattern} onChange={event => setRulePattern(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void addRule(); }} placeholder={RULE_KINDS.find(kind => kind.value === ruleKind)?.placeholder} className="h-10 min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
                                <Button disabled={saving || !rulePattern.trim()} className="gap-2" onClick={() => void addRule()}><Plus className="h-4 w-4" />添加</Button>
                            </div>
                            <div className="mt-4 divide-y rounded-lg border">{rules.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">暂无自定义规则，系统仍会使用可解释的风险评分。</p> : rules.map(rule => <div key={rule.id} className="flex items-center gap-3 px-4 py-3"><button type="button" disabled={saving} onClick={() => void toggleRule(rule)} className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded border', rule.enabled ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background')}>{rule.enabled && <Check className="h-3.5 w-3.5" />}</button><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', rule.action === 'allow' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300')}>{rule.action === 'allow' ? '允许' : '屏蔽'}</span><span className="text-xs text-muted-foreground">{RULE_KINDS.find(kind => kind.value === rule.kind)?.label || (rule.kind === 'template' ? '相似模板' : rule.kind)}</span></div><p className="mt-1 truncate text-sm font-medium">{rule.label || rule.pattern}</p></div><Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" disabled={saving} onClick={() => void removeRule(rule)} aria-label="删除规则"><Trash2 className="h-4 w-4" /></Button></div>)}</div>
                        </section>
                    </main>}
                </div>
            ) : (
                <section className="space-y-4">
                    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-semibold">过滤与判定记录</h3><p className="mt-1 text-sm text-muted-foreground">人工修正会学习为当前频道的相似模板。</p></div><select value={decisionFilter} onChange={event => setDecisionFilter(event.target.value as typeof decisionFilter)} className="h-10 rounded-md border bg-background px-3 text-sm"><option value="">全部结果</option><option value="blocked">已拦截</option><option value="review">待留意</option><option value="allow">已允许</option></select></div>
                    {decisions.length === 0 ? <div className="flex flex-col items-center justify-center rounded-xl border bg-card py-20 text-center"><Ban className="h-12 w-12 text-muted-foreground/50" /><h3 className="mt-4 text-lg font-semibold">暂无过滤记录</h3><p className="mt-1 max-w-sm text-sm text-muted-foreground">广告过滤启用并扫描到新消息后，判定原因会显示在这里。</p></div> : <div className="overflow-hidden rounded-xl border bg-card"><div className="max-h-[720px] space-y-3 overflow-y-auto p-3">{decisions.map(item => <article key={item.id} className="rounded-xl border bg-background p-4 shadow-sm"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold', decisionTone(item.decision))}>{item.decision === 'blocked' ? '已拦截' : item.decision === 'review' ? '待留意' : '已允许'} · {item.score} 分</span><span className="text-xs text-muted-foreground">{item.subscription_title || item.subscription_source} · #{item.message_id} · {dateLabel(item.created_at)}</span>{item.manual_label && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">已人工确认{item.manual_label === 'ad' ? '广告' : '正常'}</span>}</div><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{item.text_excerpt || '无文字内容，仅根据链接、按钮或媒体元数据判定'}</p><div className="mt-3 flex flex-wrap gap-2">{(item.reasons || []).map((reason, index) => <span key={`${reason.code}-${index}`} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{reason.label}{reason.score > 0 ? ` +${reason.score}` : ` ${reason.score}`}</span>)}</div>{(item.domains?.length || item.usernames?.length) > 0 && <p className="mt-3 break-all text-xs text-muted-foreground">{[...(item.domains || []), ...(item.usernames || [])].join(' · ')}</p>}</div><div className="flex shrink-0 gap-2"><Button size="sm" variant="outline" disabled={saving} onClick={() => void review(item, 'normal')} className="gap-1.5"><CheckCircle2 className="h-4 w-4" />不是广告</Button><Button size="sm" variant="outline" disabled={saving} onClick={() => void review(item, 'ad')} className="gap-1.5 text-destructive"><Ban className="h-4 w-4" />是广告</Button></div></div></article>)}</div><Pagination page={decisionPage} pages={decisionPages} total={decisionTotal} onChange={setDecisionPage} /></div>}
                </section>
            )}
        </div>
    );
}
