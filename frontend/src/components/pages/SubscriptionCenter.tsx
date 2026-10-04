import './subscriptions-audit.css';
import { formatDateTime } from '../../i18n/format';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Ban, CheckCircle2, Filter, ListFilter, Plus, RefreshCw, ShieldCheck, Trash2 } from "../ui/icons";
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
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

const MODES: Array<{ value: TelegramAdFilterMode; labelKey: string; detailKey: string }> = [
    { value: 'off', labelKey: 'subscriptionCenter.filterModes.off.label', detailKey: 'subscriptionCenter.filterModes.off.detail' },
    { value: 'conservative', labelKey: 'subscriptionCenter.filterModes.conservative.label', detailKey: 'subscriptionCenter.filterModes.conservative.detail' },
    { value: 'aggressive', labelKey: 'subscriptionCenter.filterModes.aggressive.label', detailKey: 'subscriptionCenter.filterModes.aggressive.detail' },
];
const RULE_KINDS: Array<{ value: TelegramAdRuleKind; labelKey: string; placeholderKey: string }> = [
    { value: 'keyword', labelKey: 'subscriptionCenter.ruleKinds.keyword.label', placeholderKey: 'subscriptionCenter.ruleKinds.keyword.placeholder' },
    { value: 'domain', labelKey: 'subscriptionCenter.ruleKinds.domain.label', placeholderKey: 'subscriptionCenter.ruleKinds.domain.placeholder' },
    { value: 'username', labelKey: 'subscriptionCenter.ruleKinds.username.label', placeholderKey: 'subscriptionCenter.ruleKinds.username.placeholder' },
];

function dateLabel(value: string | null, locale: string, emptyLabel: string): string {
    if (!value) return emptyLabel;
    return formatDateTime(value, locale);
}

function modeTone(mode: TelegramAdFilterMode): string {
    if (mode === 'conservative') return 'op-badge--success';
    if (mode === 'aggressive') return 'op-badge--warning';
    return 'op-badge--muted';
}

function decisionTone(decision: TelegramAdDecision['decision']): string {
    if (decision === 'blocked') return 'op-badge--danger';
    if (decision === 'review') return 'op-badge--warning';
    return 'op-badge--success';
}

export function SubscriptionCenter({ onUnauthorized }: SubscriptionCenterProps) {
    const { t, i18n } = useTranslation();
    const language = i18n.resolvedLanguage || i18n.language;
    const audit = language.startsWith('zh') ? {
        directory: '选择频道', directoryHelp: '点击频道卡片，切换右侧设置和审核记录。', current: '当前频道', selected: '已选择', channelSettings: '过滤设置', scope: '设置和审核记录仅针对当前频道。切换频道将清空未提交的规则。', loadFailed: '加载失败，请点击刷新重试。', zero: '所有统计均为零', stats: '查看统计', attention: '待审核记录',
        bot: '打开 Telegram Bot', settings: '查看 Bot 连接设置', steps: '如何添加或恢复订阅',
        step1: '打开已配置的 Telegram Bot 私聊，发送 /tg_sub。',
        step2: '新增：按向导发送频道用户名或链接，选择目标目录并确认。',
        step3: '恢复：在订阅管理中选择已有订阅，按向导恢复同步；已保存文件不会被删除。',
        unavailable: '未获取到可验证的 Bot 用户名，请先检查连接设置。',
    } : language.startsWith('ru') ? {
        directory: 'Выберите канал', directoryHelp: 'Выберите канал, чтобы открыть настройки и историю фильтрации.', current: 'Текущий канал', selected: 'Выбран', channelSettings: 'Настройки фильтра', scope: 'Настройки и история фильтрации относятся только к выбранному каналу. При переключении несохранённое правило будет сброшено.', loadFailed: 'Не удалось загрузить. Нажмите «Обновить», чтобы повторить.', zero: 'Все показатели равны нулю', stats: 'Показать статистику', attention: 'Ожидают проверки',
        bot: 'Открыть Telegram-бота', settings: 'Настройки подключения бота', steps: 'Как добавить или возобновить подписку',
        step1: 'Откройте личный чат с настроенным Telegram-ботом и отправьте /tg_sub.',
        step2: 'Чтобы добавить подписку, отправьте имя пользователя или ссылку на канал, выберите место сохранения и подтвердите выбор.',
        step3: 'Чтобы возобновить синхронизацию, выберите существующую подписку в списке и следуйте подсказкам. Сохранённые файлы не удаляются.',
        unavailable: 'Не удалось подтвердить имя пользователя бота. Проверьте настройки подключения.',
    } : {
        directory: 'Choose a channel', directoryHelp: 'Select a channel to open its settings and filter history.', current: 'Current channel', selected: 'Selected', channelSettings: 'Filter settings', scope: 'Settings and filter history apply only to this channel. Switching channels clears the unsaved rule.', loadFailed: 'Could not load. Use Refresh to try again.', zero: 'All statistics are zero', stats: 'Show statistics', attention: 'Awaiting review',
        bot: 'Open Telegram Bot', settings: 'Bot connection settings', steps: 'How to add or resume a subscription',
        step1: 'Open a private chat with your configured Telegram Bot and send /tg_sub.',
        step2: 'To add: send the channel username or link, choose a destination folder and confirm in the wizard.',
        step3: 'To resume: select an existing subscription in subscription management and follow the prompts. Saved files are retained.',
        unavailable: 'Could not verify the Bot username. Check the connection settings first.',
    };
    const controls = language.startsWith('zh') ? {
        pause: '暂停订阅', resume: '恢复订阅', remove: '删除订阅', cancel: '取消', failed: '订阅操作失败，请重试。',
        pauseHelp: '暂停后不再安排后续扫描；已开始的扫描和已创建的下载任务可能继续，已保存文件保留。',
        resumeHelp: '恢复后按原进度和扫描计划继续同步，不会重置进度。',
        deleteHelp: '永久删除该订阅及其过滤规则、审核记录，无法撤销。不会删除已保存文件，也不会取消已开始的扫描或已创建的下载任务；请在任务中心单独管理。',
    } : language.startsWith('ru') ? {
        pause: 'Приостановить подписку', resume: 'Возобновить подписку', remove: 'Удалить подписку', cancel: 'Отмена', failed: 'Не удалось изменить подписку. Повторите попытку.',
        pauseHelp: 'Новые проверки канала не запускаются. Уже начатые проверки и созданные задачи скачивания могут продолжаться. Сохранённые файлы не удаляются.',
        resumeHelp: 'Синхронизация продолжится с сохранённой позиции по прежнему расписанию, без сброса прогресса.',
        deleteHelp: 'Подписка, её правила и история фильтрации будут удалены безвозвратно. Сохранённые файлы не удаляются. Уже начатые проверки канала и созданные задачи скачивания не отменяются — ими можно управлять в центре задач.',
    } : {
        pause: 'Pause subscription', resume: 'Resume subscription', remove: 'Delete subscription', cancel: 'Cancel', failed: 'Subscription action failed. Please retry.',
        pauseHelp: 'Stops scheduling future scans. Scans already started and existing download jobs may continue. Saved files are retained.',
        resumeHelp: 'Resumes syncing from where it left off, using the existing scan schedule.',
        deleteHelp: 'Permanently deletes this subscription, its filter rules, and filter history. This cannot be undone. Saved files are retained. Scans already started and existing download jobs are not cancelled; manage jobs separately in the task center.',
    };
    const locale = i18n.resolvedLanguage || i18n.language;
    const [botUsername, setBotUsername] = useState<string | null>(null);
    useEffect(() => { let live = true; void fileApi.getTelegramBotConfig().then(config => { if (live) setBotUsername(typeof config.bot?.username === 'string' && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(config.bot.username) ? config.bot.username : null); }).catch(() => {}); return () => { live = false; }; }, []);
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
    const mutationLock = useRef(false);
    const [deleteTarget, setDeleteTarget] = useState<TelegramSubscription | null>(null);
    const [error, setError] = useState<string | null>(null);
    const selected = subscriptions.find(item => item.id === selectedId) || null;

    const handleError = useCallback((caught: unknown, fallback: string) => {
        if (isUnauthorizedError(caught)) return void onUnauthorized?.();
        setError(errorMessage(caught, fallback));
    }, [onUnauthorized]);

    // Each request family has its own generation. Mutation refreshes use the same
    // guarded loaders, so an older response cannot overwrite a newer scope.
    const subscriptionGeneration = useRef(0);
    const ruleGeneration = useRef(0);
    const decisionGeneration = useRef(0);
    const [directoryLoading, setDirectoryLoading] = useState(false);
    const [rulesLoading, setRulesLoading] = useState(false);
    const [rulesFailed, setRulesFailed] = useState(false);
    const [decisionsFailed, setDecisionsFailed] = useState(false);
    const [decisionsLoading, setDecisionsLoading] = useState(false);
    const [rulesScope, setRulesScope] = useState<string | null>(null);
    const [decisionsScope, setDecisionsScope] = useState<string | null>(null);
    const decisionKey = `${selectedId}:${decisionFilter}:${decisionPage}:${tab}`;
    const rulesReady = !!selectedId && rulesScope === selectedId && !rulesLoading;
    const decisionsReady = !!selectedId && decisionsScope === decisionKey && !decisionsLoading;

    const selectChannel = (id: string) => {
        if (saving || directoryLoading || id === selectedId) return;
        ruleGeneration.current++;
        decisionGeneration.current++;
        setRulesScope(null); setDecisionsScope(null); setRulesFailed(false); setDecisionsFailed(false);
        setRulePattern(''); setRuleKind('domain'); setRuleAction('block');
        setDecisionPage(1); setSelectedId(id); setError(null);
    };

    const loadSubscriptions = useCallback(async () => {
        const generation = ++subscriptionGeneration.current;
        setDirectoryLoading(true);
        try {
            const result = await fileApi.getSubscriptions({ limit: SUBSCRIPTION_PAGE_SIZE, offset: (subscriptionPage - 1) * SUBSCRIPTION_PAGE_SIZE });
            if (generation !== subscriptionGeneration.current) return;
            const lastPage = Math.max(1, Math.ceil(result.total / SUBSCRIPTION_PAGE_SIZE));
            if (subscriptionPage > lastPage) { setSubscriptionPage(lastPage); return; }
            const items = result.subscriptions;
            setSubscriptions(items);
            setSubscriptionTotal(result.total);
            setSummary(result.summary);
            setSelectedId(current => current && items.some(item => item.id === current) ? current : items[0]?.id || null);
            setError(null);
        } catch (caught) {
            if (generation === subscriptionGeneration.current) handleError(caught, t('subscriptionCenter.errors.subscriptions'));
        } finally {
            if (generation === subscriptionGeneration.current) { setLoading(false); setDirectoryLoading(false); }
        }
    }, [handleError, subscriptionPage, t]);

    const loadRules = useCallback(async (subscriptionId: string) => {
        const generation = ++ruleGeneration.current;
        setRulesLoading(true); setRulesFailed(false); setRulesScope(null); setRules([]);
        try {
            const result = await fileApi.getSubscriptionAdRules(subscriptionId);
            if (generation !== ruleGeneration.current) return;
            setRules(result); setRulesScope(subscriptionId);
        } catch (caught) {
            if (generation === ruleGeneration.current) { setRulesFailed(true); handleError(caught, t('subscriptionCenter.errors.rules')); }
        } finally { if (generation === ruleGeneration.current) setRulesLoading(false); }
    }, [handleError, t]);

    const loadDecisions = useCallback(async () => {
        if (!selectedId || tab !== 'records') { setDecisionsLoading(false); return; }
        const generation = ++decisionGeneration.current;
        setDecisionsLoading(true); setDecisionsFailed(false); setDecisionsScope(null); setDecisions([]); setDecisionTotal(0);
        try {
            const result = await fileApi.getSubscriptionAdDecisions({
                subscriptionId: selectedId,
                decision: decisionFilter || undefined,
                limit: DECISION_PAGE_SIZE,
                offset: (decisionPage - 1) * DECISION_PAGE_SIZE,
            });
            if (generation !== decisionGeneration.current) return;
            setDecisions(result.decisions); setDecisionTotal(result.total); setDecisionsScope(decisionKey);
        } catch (caught) {
            if (generation === decisionGeneration.current) { setDecisionsFailed(true); handleError(caught, t('subscriptionCenter.errors.decisions')); }
        } finally { if (generation === decisionGeneration.current) setDecisionsLoading(false); }
    }, [decisionFilter, decisionPage, decisionKey, handleError, selectedId, tab, t]);

    useEffect(() => {
        void loadSubscriptions();
        return () => { subscriptionGeneration.current++; };
    }, [loadSubscriptions]);
    useEffect(() => {
        setRulePattern(''); setRuleKind('domain'); setRuleAction('block');
        setDecisionPage(1);
        if (selectedId) void loadRules(selectedId);
        else { setRules([]); setRulesScope(null); setRulesLoading(false); }
        return () => { ruleGeneration.current++; };
    }, [loadRules, selectedId]);
    useEffect(() => {
        if (tab === 'records') void loadDecisions();
        else { setDecisionsLoading(false); setDecisionsScope(null); }
        return () => { decisionGeneration.current++; };
    }, [loadDecisions, tab]);

    const mutateSubscription = async (target: TelegramSubscription, remove: boolean) => {
        if (mutationLock.current || saving || directoryLoading || target.id !== selectedId) return;
        mutationLock.current = true; setSaving(true); setError(null);
        try {
            if (remove) await fileApi.deleteSubscription(target.id);
            else await fileApi.setSubscriptionEnabled(target.id, !target.enabled);
            setDeleteTarget(null);
            if (remove) {
                ruleGeneration.current++; decisionGeneration.current++;
                setRules([]); setRulesScope(null); setDecisions([]); setDecisionsScope(null);
                setRulePattern(''); setDecisionPage(1); setSelectedId(null);
            }
            await loadSubscriptions();
        } catch (caught) { handleError(caught, controls.failed); }
        finally { mutationLock.current = false; setSaving(false); }
    };

    const updateMode = async (mode: TelegramAdFilterMode) => {
        if (!selected || mutationLock.current || saving || directoryLoading) return;
        mutationLock.current = true; setSaving(true); setError(null);
        try {
            await fileApi.updateSubscriptionAdFilter(selected.id, mode);
            await loadSubscriptions();
        } catch (caught) { handleError(caught, t('subscriptionCenter.errors.mode')); }
        finally { mutationLock.current = false; setSaving(false); }
    };

    const addRule = async () => {
        if (!selected || mutationLock.current || saving || directoryLoading || !rulesReady || !rulePattern.trim()) return;
        mutationLock.current = true; setSaving(true); setError(null);
        try {
            await fileApi.createSubscriptionAdRule(selected.id, { kind: ruleKind, action: ruleAction, pattern: rulePattern.trim() });
            setRulePattern(''); await loadRules(selected.id);
        } catch (caught) { handleError(caught, t('subscriptionCenter.errors.createRule')); }
        finally { mutationLock.current = false; setSaving(false); }
    };

    const toggleRule = async (rule: TelegramAdRule) => {
        if (!selected || mutationLock.current || saving || directoryLoading || !rulesReady || !rules.some(item => item.id === rule.id)) return;
        mutationLock.current = true; setSaving(true);
        try { await fileApi.setSubscriptionAdRuleEnabled(selected.id, rule.id, !rule.enabled); await loadRules(selected.id); }
        catch (caught) { handleError(caught, t('subscriptionCenter.errors.updateRule')); }
        finally { mutationLock.current = false; setSaving(false); }
    };

    const removeRule = async (rule: TelegramAdRule) => {
        if (!selected || mutationLock.current || saving || directoryLoading || !rulesReady || !rules.some(item => item.id === rule.id)) return;
        mutationLock.current = true; setSaving(true);
        try { await fileApi.deleteSubscriptionAdRule(selected.id, rule.id); await loadRules(selected.id); }
        catch (caught) { handleError(caught, t('subscriptionCenter.errors.deleteRule')); }
        finally { mutationLock.current = false; setSaving(false); }
    };

    const review = async (decision: TelegramAdDecision, label: 'ad' | 'normal') => {
        if (mutationLock.current || saving || directoryLoading || !decisionsReady || !decisions.some(item => item.id === decision.id)) return;
        mutationLock.current = true; setSaving(true); setError(null);
        try {
            const result = await fileApi.reviewSubscriptionAdDecision(decision.id, label, true);
            if (result.restoredJobId) setError(t('subscriptionCenter.notices.restored'));
            await Promise.all([loadDecisions(), loadSubscriptions(), selectedId ? loadRules(selectedId) : Promise.resolve()]);
        } catch (caught) { handleError(caught, t('subscriptionCenter.errors.review')); }
        finally { mutationLock.current = false; setSaving(false); }
    };

    if (loading) return <div className="tv-operations"><div className="tv-panel op-empty" role="status">{t('subscriptionCenter.loading')}</div></div>;

    const subscriptionPages = Math.max(1, Math.ceil(subscriptionTotal / SUBSCRIPTION_PAGE_SIZE));
    const decisionPages = Math.max(1, Math.ceil(decisionTotal / DECISION_PAGE_SIZE));
    const Pagination = ({ page, pages, total, onChange }: { page: number; pages: number; total: number; onChange: (page: number) => void }) => (
        <footer className="op-pagination">
            <span>{t('subscriptionCenter.pagination.summary', { total, page, pages })}</span>
            <div className="op-actions">
                <Button size="sm" variant="outline" disabled={page <= 1 || saving || directoryLoading || decisionsLoading} onClick={() => onChange(page - 1)}>{t('subscriptionCenter.pagination.previous')}</Button>
                <Button size="sm" variant="outline" disabled={page >= pages || saving || directoryLoading || decisionsLoading} onClick={() => onChange(page + 1)}>{t('subscriptionCenter.pagination.next')}</Button>
            </div>
        </footer>
    );

    return (
        <section className="tv-operations op-subscriptions-page" aria-labelledby="subscriptions-page-title">
            <header className="tv-page-header op-page-heading">
                <div>
                    <span className="op-eyebrow"><ShieldCheck className="h-3.5 w-3.5" />{t('subscriptionCenter.eyebrow')}</span>
                    <h1 id="subscriptions-page-title">{t('subscriptionCenter.title')}</h1>
                    <p>{t('subscriptionCenter.description')}</p>
                </div>
                <Button variant="outline" className="op-action" disabled={saving || directoryLoading || rulesLoading || decisionsLoading} onClick={() => { void loadSubscriptions(); if (selectedId) void loadRules(selectedId); if (tab === 'records') void loadDecisions(); }}><RefreshCw className="h-4 w-4" />{t('subscriptionCenter.refresh')}</Button>
            </header>

            <details className="audit-subscription-zero"><summary>{Object.values(summary).some(value => value > 0) ? audit.stats : `${audit.zero} · ${audit.stats}`}</summary><dl className="tv-panel op-stat-strip">
                {[
                    [t('subscriptionCenter.summary.enabled'), summary.enabled, t('subscriptionCenter.summary.enabledDetail')],
                    [t('subscriptionCenter.summary.protected'), summary.protected, t('subscriptionCenter.summary.protectedDetail')],
                    [t('subscriptionCenter.summary.blocked'), summary.blocked, t('subscriptionCenter.summary.blockedDetail')],
                    [audit.attention, summary.review, t('subscriptionCenter.summary.reviewDetail')],
                ].map(([label, value, detail]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd><p>{detail}</p></div>)}
            </dl></details>
            {error && <div className="op-notice op-notice--danger" role="alert"><AlertCircle className="h-4 w-4 shrink-0" /><span>{error}</span></div>}

            {subscriptions.length === 0 ? <div className="tv-panel op-empty audit-subscription-empty">
                    <ListFilter className="h-6 w-6" aria-hidden="true" />
                    <h3>{t('subscriptionCenter.empty.title')}</h3>
                    <p>{t('subscriptionCenter.empty.description')}</p>
                    <div className="audit-subscription-entry">
                        {botUsername ? <a className="audit-subscription-link" href={`https://t.me/${botUsername}`} target="_blank" rel="noopener noreferrer">{audit.bot}</a>
                            : <><p className="op-help">{audit.unavailable}</p><a className="audit-subscription-link" href="/settings/telegram">{audit.settings}</a></>}
                    </div>
                    <details className="audit-subscription-steps"><summary>{audit.steps}</summary><ol><li>{audit.step1}</li><li>{audit.step2}</li><li>{audit.step3}</li></ol></details>
                </div> :
                <div className="op-subscription-layout">
                    <section className="tv-panel op-subscription-directory" aria-label={audit.directory} aria-busy={directoryLoading}>
                        <div className="op-table-toolbar"><div><h2>{audit.directory}</h2><p className="op-help">{audit.directoryHelp}</p></div><span className="op-badge op-badge--info">{subscriptionTotal}</span></div>
                        {directoryLoading && <p className="op-scope-status" role="status">{t('subscriptionCenter.loading')}</p>}
                        <div className="op-channel-cards">
                            {subscriptions.map(item => <button key={item.id} type="button" disabled={saving || directoryLoading} aria-pressed={selectedId === item.id} onClick={() => selectChannel(item.id)} className={cn('op-channel-card', selectedId === item.id && 'is-selected')}>
                                <span className="op-channel-card-heading"><strong>{item.title || item.source}</strong>{selectedId === item.id && <span className="op-channel-selected"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{audit.selected}</span>}</span>
                                <small>{item.source_original || item.source}</small>
                                <span className="op-channel-badges"><span className={cn('op-badge', item.enabled ? 'op-badge--success' : 'op-badge--muted')}>{t(item.enabled ? 'subscriptionCenter.subscription.enabled' : 'subscriptionCenter.subscription.disabled')}</span><span className={cn('op-badge', modeTone(item.ad_filter_mode))}>{t(MODES.find(mode => mode.value === item.ad_filter_mode)?.labelKey || 'subscriptionCenter.filterModes.off.label')}</span></span>
                                <span className="op-channel-counts"><span>{t('subscriptionCenter.subscription.blocked', { count: item.ad_stats?.blocked_count || 0 })}</span><span>{t('subscriptionCenter.subscription.review', { count: item.ad_stats?.review_count || 0 })}</span></span>
                            </button>)}
                        </div>
                        <Pagination page={subscriptionPage} pages={subscriptionPages} total={subscriptionTotal} onChange={setSubscriptionPage} />
                        <details className="audit-subscription-steps op-directory-help"><summary>{audit.steps}</summary>
                            <div className="audit-subscription-entry">{botUsername ? <a className="audit-subscription-link" href={`https://t.me/${botUsername}`} target="_blank" rel="noopener noreferrer">{audit.bot}</a> : <><p className="op-help">{audit.unavailable}</p><a className="audit-subscription-link" href="/settings/telegram">{audit.settings}</a></>}</div>
                            <ol><li>{audit.step1}</li><li>{audit.step2}</li><li>{audit.step3}</li></ol>
                        </details>
                    </section>

                    {selected && <div className="op-channel-workspace">
                        <header className="op-current-channel"><span className="op-eyebrow">{audit.current}</span><h2>{selected.title || selected.source}</h2><p className="op-help">{selected.source_original || selected.source}</p><p className="op-help">{audit.scope}</p></header>
                        <section className="tv-panel op-panel" aria-label={selected.title || selected.source}>
                            <div className="op-actions">
                                <Button variant="outline" disabled={saving || directoryLoading} onClick={() => void mutateSubscription(selected, false)}>{selected.enabled ? controls.pause : controls.resume}</Button>
                                <Button variant="destructive" disabled={saving || directoryLoading} onClick={() => setDeleteTarget(selected)}>{controls.remove}</Button>
                            </div>
                            <p className="op-help">{selected.enabled ? controls.pauseHelp : controls.resumeHelp}</p>
                        </section>
                        <nav className="op-tabs" aria-label={audit.current}>
                            <button type="button" disabled={saving || directoryLoading} aria-pressed={tab === 'subscriptions'} onClick={() => setTab('subscriptions')} className={cn(tab === 'subscriptions' && 'is-active')}><ListFilter className="h-4 w-4" />{audit.channelSettings}</button>
                            <button type="button" disabled={saving || directoryLoading} aria-pressed={tab === 'records'} onClick={() => setTab('records')} className={cn(tab === 'records' && 'is-active')}><ShieldCheck className="h-4 w-4" />{t('subscriptionCenter.tabs.records')}</button>
                        </nav>
                        {tab === 'subscriptions' ? <div className="op-subscription-settings">
                        <section className="tv-panel op-panel">
                            <div className="op-section-heading">
                                <div><h2 className="op-break">{audit.channelSettings}</h2><p>{t('subscriptionCenter.subscription.lastScan', { date: dateLabel(selected.last_scan_at, locale, t('subscriptionCenter.dateUnavailable')), messageId: selected.last_message_id })}</p></div>
                                <span className={cn('op-badge', selected.enabled ? 'op-badge--success' : 'op-badge--muted')}>{t(selected.enabled ? 'subscriptionCenter.subscription.enabled' : 'subscriptionCenter.subscription.disabled')}</span>
                            </div>
                            <div className="op-mode-list" role="group" aria-label={t('subscriptionCenter.table.filter')}>
                                {MODES.map(mode => <button key={mode.value} disabled={saving || directoryLoading} type="button" aria-pressed={selected.ad_filter_mode === mode.value} onClick={() => void updateMode(mode.value)} className={cn('op-mode-option', selected.ad_filter_mode === mode.value && 'is-active')}>
                                    <span className="op-mode-indicator">{selected.ad_filter_mode === mode.value && <CheckCircle2 className="h-4 w-4" />}</span><span><strong>{t(mode.labelKey)}</strong><small>{t(mode.detailKey)}</small></span>
                                </button>)}
                            </div>
                        </section>
                        <section className="tv-panel op-panel">
                            <div className="op-section-heading"><div><h2><Filter className="h-4 w-4" />{t('subscriptionCenter.rules.title')}</h2><p>{t('subscriptionCenter.rules.description')}</p></div></div>
                            <fieldset className="op-rule-editor" disabled={saving || directoryLoading || !rulesReady}>
                            <form className="op-rule-form" onSubmit={event => { event.preventDefault(); void addRule(); }}>
                                <label className="op-field"><span>{t('subscriptionCenter.table.action')}</span><select value={ruleAction} onChange={event => setRuleAction(event.target.value as TelegramAdRuleAction)} className="tv-field op-input" disabled={saving || directoryLoading}><option value="block">{t('subscriptionCenter.rules.actions.block')}</option><option value="allow">{t('subscriptionCenter.rules.actions.alwaysAllow')}</option></select></label>
                                <label className="op-field"><span>{t('subscriptionCenter.table.kind')}</span><select value={ruleKind} onChange={event => setRuleKind(event.target.value as TelegramAdRuleKind)} className="tv-field op-input" disabled={saving || directoryLoading}>{RULE_KINDS.map(kind => <option key={kind.value} value={kind.value}>{t(kind.labelKey)}</option>)}</select></label>
                                <label className="op-field op-rule-pattern"><span>{t('subscriptionCenter.table.pattern')}</span><input value={rulePattern} onChange={event => setRulePattern(event.target.value)} placeholder={t(RULE_KINDS.find(kind => kind.value === ruleKind)?.placeholderKey || 'subscriptionCenter.ruleKinds.domain.placeholder')} className="tv-field op-input" disabled={saving || directoryLoading} /></label>
                                <Button type="submit" disabled={saving || !rulePattern.trim()} className="op-action"><Plus className="h-4 w-4" />{t('subscriptionCenter.rules.add')}</Button>
                            </form>
                            </fieldset>
                            <div className="op-rule-list" aria-busy={rulesLoading}>
                                {!rulesReady ? <p className="op-empty op-empty--compact" role="status">{rulesFailed ? audit.loadFailed : t('subscriptionCenter.loading')}</p> : rules.length === 0 ? <p className="op-empty op-empty--compact">{t('subscriptionCenter.rules.empty')}</p> : rules.map(rule => <div key={rule.id} className="op-rule-row">
                                    <input type="checkbox" checked={rule.enabled} disabled={saving || directoryLoading} onChange={() => void toggleRule(rule)} aria-label={t('subscriptionCenter.rules.enabledAria', { rule: rule.label || rule.pattern })} />
                                    <div className="op-rule-content"><div className="op-item-meta"><span className={cn('op-badge', rule.action === 'allow' ? 'op-badge--success' : 'op-badge--danger')}>{t(rule.action === 'allow' ? 'subscriptionCenter.rules.actions.allow' : 'subscriptionCenter.rules.actions.block')}</span><span>{t(RULE_KINDS.find(kind => kind.value === rule.kind)?.labelKey || (rule.kind === 'template' ? 'subscriptionCenter.ruleKinds.template.label' : 'subscriptionCenter.ruleKinds.other.label'), { kind: rule.kind })}</span></div><p title={rule.pattern}>{rule.label || rule.pattern}</p></div>
                                    <Button variant="ghost" size="icon" className="op-danger-button" disabled={saving || directoryLoading} onClick={() => void removeRule(rule)} aria-label={t('subscriptionCenter.rules.deleteAria')}><Trash2 className="h-4 w-4" /></Button>
                                </div>)}
                            </div>
                        </section>
                    </div> : (
                <section className="tv-panel op-decision-console">
                    <div className="op-table-toolbar op-record-toolbar">
                        <div><h2>{t('subscriptionCenter.records.title')}</h2><p className="op-help">{t('subscriptionCenter.records.description')}</p></div>
                        <div className="op-record-filters">
                            <label className="op-field"><span>{t('subscriptionCenter.table.decision')}</span><select value={decisionFilter} disabled={saving || directoryLoading} onChange={event => { decisionGeneration.current++; setDecisionsScope(null); setDecisionPage(1); setDecisionFilter(event.target.value as typeof decisionFilter); }} className="tv-field op-input"><option value="">{t('subscriptionCenter.records.filters.all')}</option><option value="blocked">{t('subscriptionCenter.records.filters.blocked')}</option><option value="review">{t('subscriptionCenter.records.filters.review')}</option><option value="allow">{t('subscriptionCenter.records.filters.allow')}</option></select></label>
                        </div>
                    </div>
                    {!decisionsReady ? <div className="op-empty" role="status">{decisionsFailed ? audit.loadFailed : t('subscriptionCenter.loading')}</div> : decisions.length === 0 ? <div className="op-empty"><Ban className="h-8 w-8" /><h3>{t('subscriptionCenter.records.emptyTitle')}</h3><p>{t('subscriptionCenter.records.emptyDescription')}</p></div> : (
                        <div className="op-decision-list">{decisions.map(item => <article key={item.id} className="op-decision-row">
                            <div className="op-decision-meta"><span className={cn('op-badge', decisionTone(item.decision))}>{t(`subscriptionCenter.records.decisions.${item.decision}`)} · {t('subscriptionCenter.records.score', { score: item.score })}</span><strong>{item.subscription_title || item.subscription_source}</strong><small>#{item.message_id} · {dateLabel(item.created_at, locale, t('subscriptionCenter.dateUnavailable'))}</small>{item.manual_label && <span className="op-badge op-badge--info">{t(item.manual_label === 'ad' ? 'subscriptionCenter.records.confirmedAd' : 'subscriptionCenter.records.confirmedNormal')}</span>}</div>
                            <div className="op-decision-content"><p>{item.text_excerpt || t('subscriptionCenter.records.noText')}</p><div className="op-reason-list">{(item.reasons || []).map((reason, index) => <span key={`${reason.code}-${index}`} className="op-reason">{reason.label}{reason.score > 0 ? ` +${reason.score}` : ` ${reason.score}`}</span>)}</div>{(item.domains?.length || item.usernames?.length) > 0 && <small className="op-break">{[...(item.domains || []), ...(item.usernames || [])].join(' · ')}</small>}</div>
                            <div className="op-actions op-review-actions"><Button size="sm" variant="outline" disabled={saving || directoryLoading} className="op-action" onClick={() => void review(item, 'normal')}><CheckCircle2 className="h-4 w-4" />{t('subscriptionCenter.records.markNormal')}</Button><Button size="sm" variant="outline" disabled={saving || directoryLoading} className="op-action op-danger-button" onClick={() => void review(item, 'ad')}><Ban className="h-4 w-4" />{t('subscriptionCenter.records.markAd')}</Button></div>
                        </article>)}</div>
                    )}
                    <Pagination page={decisionPage} pages={decisionPages} total={decisionTotal} onChange={setDecisionPage} />
                </section>
                        )}
                    </div>}
                </div>
            }
            <Dialog open={!!deleteTarget} onClose={() => { if (!mutationLock.current) setDeleteTarget(null); }} labelledBy="subscription-delete-title" describedBy="subscription-delete-impact" alert>
                <div className="tv-modal-header"><div className="tv-modal-heading">
                    <h3 id="subscription-delete-title" className="tv-modal-title">{controls.remove} — {deleteTarget?.title || deleteTarget?.source}</h3>
                    <p className="op-break">{deleteTarget?.source_original || deleteTarget?.source}</p>
                    <p id="subscription-delete-impact" className="tv-modal-description">{controls.deleteHelp}</p>
                    {error && <p role="alert">{error}</p>}
                </div></div>
                <div className="tv-modal-footer">
                    <Button variant="outline" disabled={saving} onClick={() => setDeleteTarget(null)}>{controls.cancel}</Button>
                    <Button variant="destructive" disabled={saving || directoryLoading} onClick={() => { if (deleteTarget) void mutateSubscription(deleteTarget, true); }}>{controls.remove}</Button>
                </div>
            </Dialog>
        </section>
    );
}
