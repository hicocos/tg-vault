import './tasks-audit.css';
import { formatDateTime } from '../../i18n/format';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle, Ban, CheckCircle2, CheckSquare, Clock3, Copy,
    RefreshCw, RotateCcw, Trash2, UploadCloud, X,
} from "../ui/icons";
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';
import { Button } from '../ui/Button';
import { fileApi, type TaskDismissalPreview, type UnifiedTask, type UnifiedTaskSource } from '../../services/api';
import { isUnauthorizedError } from '../../services/apiActionError';
import { cn } from '../../lib/utils';
import { taskTransferDisplay } from '../../services/taskTransferDisplay';
import { useTranslation } from 'react-i18next';
import { dismissibleTaskSnapshot, pruneSelectedTaskKeys, scopeTasks, summarizeTaskStatuses, type TaskQuickFilter } from '../../services/taskQuickFilters';
import { createSerialPoller } from '../../services/serialPoller';
import { Dialog } from '../ui/Dialog';
import { errorMessage } from '../../services/unknownError';
import { TaskFailureDetails } from './TaskFailureDetails';

interface TasksPageProps { onUnauthorized?: () => void; onOpenUploads?: () => void; onShowAllTasks?: () => void; initialAccountId?: string | null; qbittorrentEnabled?: boolean; }
interface TaskNotice { message: string; sequence: number; }

const SOURCE_OPTIONS: Array<{ value: '' | UnifiedTaskSource; labelKey: string }> = [
    { value: '', labelKey: 'tasks.sources.all' }, { value: 'web_upload', labelKey: 'tasks.sources.webUpload' },
    { value: 'telegram_bot', labelKey: 'tasks.sources.telegramFile' }, { value: 'telegram_channel', labelKey: 'tasks.sources.channelDownload' },
    { value: 'telegram_target', labelKey: 'tasks.sources.telegramTarget' },
    { value: 'subscription', labelKey: 'tasks.sources.subscription' },
    { value: 'qbittorrent', labelKey: 'qbittorrent.nav' },
];
const STATUS_OPTIONS = [
    { value: '', labelKey: 'tasks.statuses.all' }, { value: 'pending', labelKey: 'tasks.statuses.pending' },
    { value: 'running', labelKey: 'tasks.statuses.running' }, { value: 'paused', labelKey: 'tasks.statuses.paused' },
    { value: 'waiting', labelKey: 'tasks.statuses.waiting' }, { value: 'failed', labelKey: 'tasks.statuses.failed' },
    { value: 'awaiting_selection', labelKey: 'tasks.statuses.awaitingSelection' },
    { value: 'pausing', labelKey: 'tasks.statuses.pausing' },
    { value: 'interrupted', labelKey: 'tasks.statuses.interrupted' }, { value: 'retry_required', labelKey: 'tasks.statuses.retryRequired' },
    { value: 'completed', labelKey: 'tasks.statuses.completed' }, { value: 'cancelled', labelKey: 'tasks.statuses.cancelled' },
    { value: 'scheduled', labelKey: 'tasks.statuses.scheduled' }, { value: 'disabled', labelKey: 'tasks.statuses.disabled' },
];
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(SOURCE_OPTIONS.filter(o => o.value).map(o => [o.value, o.labelKey]));
const STATUS_LABELS: Record<string, string> = Object.fromEntries(STATUS_OPTIONS.filter(o => o.value).map(o => [o.value, o.labelKey]));
const STAGE_LABELS: Record<string, string> = {
    waiting: 'tasks.stages.queued', queued: 'tasks.stages.queued', scanning: 'tasks.stages.scanning', downloading: 'tasks.stages.downloading',
    awaiting_selection: 'tasks.statuses.awaitingSelection',
    uploading: 'tasks.stages.uploading', processing: 'tasks.stages.processing', awaiting_file: 'tasks.stages.awaitingFile',
    resumable: 'tasks.stages.resumable', waiting_for_next_scan: 'tasks.stages.waitingForNextScan', waiting_for_next_task: 'tasks.stages.waitingForNextTask', completed: 'tasks.stages.completed',
    failed: 'tasks.stages.failed', cancelled: 'tasks.statuses.cancelled', interrupted: 'tasks.stages.interrupted',
    retry_required: 'tasks.stages.retryRequired', disabled: 'tasks.statuses.disabled',
    paused: 'tasks.statuses.paused', pausing: 'tasks.statuses.pausing',
    submitting: 'qbittorrent.stages.submitting', metadata: 'qbittorrent.stages.metadata', cleaning: 'qbittorrent.stages.cleaning', cancelling: 'qbittorrent.stages.cancelling',
};

function taskKey(task: Pick<UnifiedTask, 'sourceType' | 'id'>): string { return `${task.sourceType}:${task.id}`; }
function statusTone(status: string): string {
    if (status === 'completed') return 'op-badge--success';
    if (['failed', 'interrupted', 'retry_required'].includes(status)) return 'op-badge--danger';
    if (['cancelled', 'disabled'].includes(status)) return 'op-badge--muted';
    if (['running', 'pending'].includes(status)) return 'op-badge--info';
    return 'op-badge--warning';
}
function StatusIcon({ status, runningLabel }: { status: string; runningLabel: string }) {
    if (status === 'completed') return <CheckCircle2 className="h-4 w-4" />;
    if (['failed', 'interrupted', 'retry_required'].includes(status)) return <AlertCircle className="h-4 w-4" />;
    if (['cancelled', 'disabled'].includes(status)) return <Ban className="h-4 w-4" />;
    if (status === 'running') return <IndeterminateSpinner label={runningLabel} size="sm" />;
    return <Clock3 className="h-4 w-4" />;
}

export const TasksPage = ({ onUnauthorized, onOpenUploads, onShowAllTasks, initialAccountId, qbittorrentEnabled = false }: TasksPageProps) => {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || i18n.language;
    const audit = {
        more: t('uiAudit.taskLabels.more'), details: t('uiAudit.taskLabels.details'),
        history: t('uiAudit.taskLabels.history'), paused: t('uiAudit.taskLabels.paused'),
    };
    const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1280px)').matches);
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const media = window.matchMedia('(max-width: 1280px)');
        const update = () => setMobile(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    // Use cards while the workspace cannot comfortably fit the task table.
    const TaskCollection = mobile ? 'div' : 'table';
    const TaskBody = mobile ? 'div' : 'tbody';
    const TaskRow = mobile ? 'article' : 'tr';
    const TaskCell = mobile ? 'div' : 'td';
    const taskTarget = (task: UnifiedTask): string => t('tasks.target.path', {
        storage: task.target.accountName || task.target.provider || t('tasks.target.unknownStorage'),
        folder: task.target.folder || t('tasks.target.root'),
    });
    const [storedTasks, setTasks] = useState<UnifiedTask[]>([]);
    const tasks = useMemo(() => storedTasks.filter(task => qbittorrentEnabled || task.sourceType !== 'qbittorrent'), [storedTasks, qbittorrentEnabled]);
    const [tasksObservedAt, setTasksObservedAt] = useState(0);
    const tasksRef = useRef<UnifiedTask[]>([]);
    const [source, setSource] = useState('');
    const [status, setStatus] = useState('');
    const [quickFilter, setQuickFilter] = useState<TaskQuickFilter>('all');
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<TaskNotice | null>(null);
    const showNotice = (message: string) => setNotice(previous => ({ message, sequence: (previous?.sequence ?? 0) + 1 }));
    const [pendingAction, setPendingAction] = useState<{ task: UnifiedTask; action: 'cancel' | 'retry' } | null>(null);
    const [dismissalPreview, setDismissalPreview] = useState<TaskDismissalPreview | null>(null);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [acting, setActing] = useState(false);
    const requestGeneration = useRef(0);
    const scopeFilters = useMemo(() => ({
        source,
        status,
        accountId: initialAccountId,
        quickFilter,
    }), [initialAccountId, quickFilter, source, status]);

    const loadTasks = useCallback(async (quiet = false) => {
        const generation = ++requestGeneration.current;
        if (quiet) setRefreshing(true);
        else setLoading(true);
        try {
            const result = await fileApi.getTasks({ source, status, accountId: initialAccountId || undefined, limit: 300 });
            if (generation !== requestGeneration.current) return;
            const relevantTasks = result.tasks.filter(task => (qbittorrentEnabled || task.sourceType !== 'qbittorrent')
                && (!initialAccountId || task.target.accountId === initialAccountId));
            tasksRef.current = relevantTasks;
            setTasks(relevantTasks); setError(null);
            setTasksObservedAt(Date.now());
            setSelected(previous => pruneSelectedTaskKeys(previous, relevantTasks, scopeFilters, taskKey));
        } catch (loadError: unknown) {
            if (generation !== requestGeneration.current) return;
            if (isUnauthorizedError(loadError)) { onUnauthorized?.(); return; }
            setError(errorMessage(loadError, t('tasks.errors.load')));
        } finally {
            if (generation === requestGeneration.current) { setLoading(false); setRefreshing(false); }
        }
    }, [initialAccountId, onUnauthorized, scopeFilters, source, status, qbittorrentEnabled]);

    useEffect(() => {
        let first = true;
        const nextDelayMs = () => {
            if (document.visibilityState !== 'visible') return 60_000;
            return tasksRef.current.some(task => ['pending', 'running', 'pausing', 'paused', 'waiting', 'interrupted'].includes(task.status)) ? 3_000 : 20_000;
        };
        const poller = createSerialPoller({
            run: async () => {
                await loadTasks(!first);
                first = false;
            },
            schedule: (callback, delay) => window.setTimeout(callback, delay),
            cancel: handle => window.clearTimeout(handle as number),
            delayMs: 3_000,
            nextDelayMs,
        });
        poller.start();
        return () => {
            poller.stop();
            requestGeneration.current += 1;
        };
    }, [loadTasks]);

    useEffect(() => {
        if (qbittorrentEnabled) return;
        if (source === 'qbittorrent') setSource('');
        setPendingAction(previous => previous?.task.sourceType === 'qbittorrent' ? null : previous);
    }, [qbittorrentEnabled, source]);

    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(null), 4_000);
        return () => window.clearTimeout(timer);
    }, [notice?.sequence]);

    const summary = useMemo(() => summarizeTaskStatuses(tasks), [tasks]);
    const visibleTasks = useMemo(() => scopeTasks(tasks, scopeFilters), [scopeFilters, tasks]);
    const dismissibleTasks = useMemo(() => dismissibleTaskSnapshot(tasks, scopeFilters), [scopeFilters, tasks]);

    const taskActionLabel = (task: UnifiedTask, action: 'cancel' | 'retry'): string => {
        if (action === 'retry') return task.sourceType === 'qbittorrent' && task.stage === 'cancelling' ? t('qbittorrent.retryCancel') : task.sourceType === 'web_upload' ? t('tasks.actions.resume') : t('tasks.actions.retry');
        if (task.sourceType === 'subscription') return t('tasks.actions.followDefault');
        if (task.sourceType === 'telegram_target') return t('tasks.actions.clearTarget');
        return t('tasks.actions.cancel');
    };
    const requestAction = (task: UnifiedTask, action: 'cancel' | 'retry') => {
        if (task.sourceType === 'web_upload' && action === 'retry') { onOpenUploads?.(); return; }
        setPendingAction({ task, action });
    };
    const controlChannel = async (task: UnifiedTask, action: 'pause' | 'resume') => {
        setActing(true);
        try {
            await fileApi.controlTask(task.sourceType, task.id, action);
            await loadTasks(true);
        } catch (actionError) {
            if (isUnauthorizedError(actionError)) onUnauthorized?.();
            else setError(errorMessage(actionError, t('tasks.errors.action')));
        } finally { setActing(false); }
    };
    const confirmAction = async () => {
        if (!pendingAction) return;
        setActing(true);
        try {
            await fileApi.controlTask(pendingAction.task.sourceType, pendingAction.task.id, pendingAction.action);
            const cancelledNotice = pendingAction.task.sourceType === 'subscription'
                ? t('tasks.notices.subscriptionDefault')
                : pendingAction.task.sourceType === 'telegram_target'
                    ? t('tasks.notices.targetCleared')
                    : t('tasks.notices.cancelled');
            showNotice(pendingAction.action === 'cancel' ? cancelledNotice : t('tasks.notices.resubmitted'));
            setPendingAction(null); await loadTasks(true);
        } catch (actionError: unknown) {
            if (isUnauthorizedError(actionError)) { onUnauthorized?.(); }
            else { setError(errorMessage(actionError, t('tasks.errors.action'))); setPendingAction(null); }
        } finally { setActing(false); }
    };

    const prepareDismissal = async (input: { tasks: UnifiedTask[] }) => {
        setActing(true); setError(null);
        try {
            const preview = await fileApi.prepareTaskDismissal({
                tasks: input.tasks.map(task => ({ sourceType: task.sourceType, id: task.id })),
            });
            setDismissalPreview(preview);
        } catch (dismissError: unknown) {
            if (isUnauthorizedError(dismissError)) { onUnauthorized?.(); }
            else setError(errorMessage(dismissError, t('tasks.errors.preview')));
        } finally { setActing(false); }
    };
    const confirmDismissal = async () => {
        if (!dismissalPreview) return;
        setActing(true);
        try {
            const result = await fileApi.confirmTaskDismissal(dismissalPreview);
            showNotice(result.failed.length
                ? t('tasks.notices.dismissPartial', { dismissed: result.dismissed.length, failed: result.failed.length })
                : t('tasks.notices.dismissed', { count: result.dismissed.length }));
            setDismissalPreview(null); setSelected([]); setSelectionMode(false); await loadTasks(true);
        } catch (dismissError: unknown) {
            if (isUnauthorizedError(dismissError)) { onUnauthorized?.(); }
            else setError(errorMessage(dismissError, t('tasks.errors.dismiss')));
            setDismissalPreview(null);
        } finally { setActing(false); }
    };
    const toggleSelection = (task: UnifiedTask) => {
        if (!task.dismissible) return;
        const key = taskKey(task);
        setSelected(previous => previous.includes(key) ? previous.filter(item => item !== key) : [...previous, key]);
    };
    const selectedTasks = dismissibleTasks.filter(task => selected.includes(taskKey(task)));

    return (
        <section className="tv-operations op-tasks-page" aria-labelledby="tasks-page-title">
            <header className="tv-page-header op-page-heading">
                <div>
                    <h1 id="tasks-page-title">{t('tasks.title')}</h1>
                    {initialAccountId && <p>{t('tasks.subtitleScoped')}</p>}
                    {initialAccountId && <button type="button" className="op-text-button op-scope-link" onClick={onShowAllTasks}>{t('tasks.showAll')}</button>}
                </div>
                <Button variant="outline" className="op-action" aria-label={t('tasks.actions.refreshAria')} onClick={() => void loadTasks(true)} disabled={refreshing}>
                    {refreshing ? <IndeterminateSpinner label={t('tasks.loading.refresh')} size="sm" /> : <RefreshCw className="h-4 w-4" />}{t('tasks.actions.refresh')}
                </Button>
            </header>

            {notice && <div className="op-notice op-notice--success" role="status" aria-live="polite"><span>{notice.message}</span><button type="button" className="op-icon-button" onClick={() => setNotice(null)} aria-label={t('tasks.actions.closeNotice')} title={t('tasks.actions.closeNotice')}><X className="h-4 w-4" /></button></div>}
            {error && <div className="op-notice op-notice--danger" role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => void loadTasks(false)}>{t('tasks.actions.retry')}</Button></div>}

            <section className="tv-panel op-task-console" aria-label={t('tasks.title')}>
                <div className="op-task-filters">
                    <div className="op-quick-filters" aria-label={t('tasks.filters.statusAria')}>
                        {([
                            ['all', 'tasks.quickFilters.all', tasks.length],
                            ['active', 'tasks.quickFilters.active', summary.active],
                            ['attention', 'tasks.quickFilters.attention', summary.attention],
                            ['completed', 'tasks.quickFilters.completed', summary.completed],
                        ] as const).map(([filter, labelKey, count]) => (
                            <button key={filter} type="button" aria-pressed={quickFilter === filter} className={cn('op-quick-filter', quickFilter === filter && 'is-active')} onClick={() => { setStatus(''); setQuickFilter(filter); }}>
                                <span>{t(labelKey)}</span><strong>{count}</strong>
                            </button>
                        ))}
                    </div>
                    <div className="op-filter-fields">
                        <label className="op-field"><span>{t('tasks.filters.sourceAria')}</span><select className="tv-field op-input" value={source} onChange={e => setSource(e.target.value)}>{SOURCE_OPTIONS.filter(option => qbittorrentEnabled || option.value !== 'qbittorrent').map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}</select></label>
                        <label className="op-field"><span>{t('tasks.filters.statusAria')}</span><select className="tv-field op-input" value={status} onChange={e => { setStatus(e.target.value); setQuickFilter('all'); }}>{STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}</select></label>
                    </div>
                </div>
                <div className="op-table-toolbar">
                    <Button size="sm" variant="outline" className="op-action" onClick={() => { setSelectionMode(!selectionMode); setSelected([]); }} disabled={!dismissibleTasks.length || acting}><CheckSquare className="h-4 w-4" />{t(selectionMode ? 'tasks.selection.exit' : 'tasks.selection.enter')}</Button>
                    <details className="op-more-actions"><summary>{audit.more}</summary><Button size="sm" variant="outline" className="op-action op-danger-button" onClick={() => void prepareDismissal({ tasks: dismissibleTasks })} disabled={!dismissibleTasks.length || acting}><Trash2 className="h-4 w-4" />{t('tasks.actions.cleanTerminal')}</Button></details>
                </div>
                {selectionMode && <div className="op-selection-bar"><strong>{t('tasks.selection.count', { count: selected.length })}</strong><div className="op-actions"><Button size="sm" variant="outline" disabled={acting} onClick={() => setSelected(dismissibleTasks.map(taskKey))}>{t('tasks.selection.selectAll')}</Button><Button size="sm" variant="ghost" disabled={acting} onClick={() => setSelected([])}>{t('tasks.selection.clear')}</Button><Button size="sm" variant="destructive" disabled={!selected.length || acting} onClick={() => void prepareDismissal({ tasks: selectedTasks })}>{t('tasks.selection.delete')}</Button></div></div>}

                {loading ? <div className="op-empty"><IndeterminateSpinner label={t('tasks.loading.initial')} size="md" /></div> : visibleTasks.length === 0 ? <div className="op-empty"><Clock3 className="h-7 w-7" /><h3>{t('tasks.empty.title')}</h3><p>{t('tasks.empty.description')}</p></div> : (
                    <div className={mobile ? "audit-task-cards" : "op-table-scroll"} tabIndex={mobile ? undefined : 0} role="region" aria-label={t('tasks.title')} aria-busy={refreshing}>
                        <TaskCollection className={mobile ? "audit-task-collection" : "op-table op-task-table"}>
                            {!mobile && <thead><tr>
                                {selectionMode && <th scope="col" className="op-select-cell">{t('tasks.selection.enter')}</th>}
                                <th scope="col">{t('tasks.table.task')}</th><th scope="col">{t('tasks.table.status')}</th><th scope="col">{t('tasks.table.target')}</th><th scope="col">{t('tasks.table.progress')}</th><th scope="col">{t('tasks.table.actions')}</th>
                            </tr></thead>}
                            <TaskBody>{visibleTasks.map(task => {
                                const stageLabel = STAGE_LABELS[task.stage] ? t(STAGE_LABELS[task.stage]) : task.stage;
                                const noMatches = task.status === 'completed' && task.sourceType === 'telegram_channel'
                                    && task.detail.scan && typeof task.detail.scan === 'object'
                                    && 'outcome' in task.detail.scan && task.detail.scan.outcome === 'no_matches';
                                const statusLabel = noMatches ? t('tasks.statuses.noMatches')
                                    : STATUS_LABELS[task.status] ? t(STATUS_LABELS[task.status]) : task.status;
                                const stopped = ['cancelled', 'failed', 'interrupted', 'retry_required', 'disabled'].includes(task.status);
                                const progress = Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress)) : 0;
                                const progressLabel = stopped ? audit.history : task.status === 'paused' ? audit.paused : t('tasks.table.progress');
                                const showStage = (!stopped || (task.sourceType === 'qbittorrent' && ['cleaning', 'cancelling'].includes(task.stage))) && task.status !== 'completed' && STAGE_LABELS[task.stage] !== STATUS_LABELS[task.status] && stageLabel !== statusLabel;
                                const transfer = taskTransferDisplay(task);
                                const detailSpeed = transfer.speed;
                                const detailEta = task.status === 'running' && typeof task.detail.eta === 'string' ? task.detail.eta : null;
                                const scan = task.sourceType === 'telegram_channel' && ['date_range', 'tag_download'].includes(task.kind) && task.detail.scan && typeof task.detail.scan === 'object'
                                    ? task.detail.scan as Record<string, unknown> : null;
                                const commentMessagesScanned = Number(scan?.commentMessagesScanned ?? 0);
                                const commentMediaFound = Number(scan?.commentMediaFound ?? 0);
                                const lastMessageDate = typeof scan?.lastMessageDate === 'string' ? scan.lastMessageDate : null;
                                const checked = selected.includes(taskKey(task));
                                return <TaskRow key={taskKey(task)} data-status={task.status} aria-label={mobile ? task.title : undefined} className={cn(mobile && "audit-task-card", checked && 'is-selected')}>
                                    {selectionMode && <TaskCell className="op-select-cell"><input type="checkbox" checked={checked} disabled={!task.dismissible || acting} onChange={() => toggleSelection(task)} aria-label={t(checked ? 'tasks.selection.deselectAria' : 'tasks.selection.selectAria')} title={!task.dismissible ? t('tasks.runningNotDismissible') : undefined} /></TaskCell>}
                                    <TaskCell className="op-task-identity">
                                        <span className="op-cell-meta">{SOURCE_LABELS[task.sourceType] ? t(SOURCE_LABELS[task.sourceType]) : task.sourceType}</span>
                                        <h3 title={task.title}>{task.title}</h3>
                                        <time className="op-cell-meta" dateTime={task.updatedAt}>{formatDateTime(task.updatedAt, locale)}</time>
                                    </TaskCell>
                                    <TaskCell className="audit-task-status"><span className={cn('op-badge', noMatches ? 'op-badge--muted' : statusTone(task.status))}><StatusIcon status={noMatches ? 'cancelled' : task.status} runningLabel={t('tasks.loading.running')} />{statusLabel}</span>{showStage && <small className="op-cell-meta">{stageLabel}</small>}</TaskCell>
                                    <TaskCell className="op-task-target" title={taskTarget(task)}>{t('tasks.target.label', { target: taskTarget(task) })}</TaskCell>
                                    <TaskCell className="op-task-transfer">
                                        {(progress > 0 || stopped || ['running', 'paused'].includes(task.status)) && <div className={cn('audit-task-progress', (stopped || task.status === 'paused') && 'is-historical')}><span className="audit-progress-label">{progressLabel}</span><div className="op-progress-line"><div className="op-progress" role="progressbar" aria-label={`${task.title}: ${progressLabel}`} aria-valuetext={`${progressLabel}: ${Math.round(progress)}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div><span>{Math.round(progress)}%</span></div></div>}
                                        {task.sourceType === 'qbittorrent' && typeof task.detail.downloadProgress === 'number' && <small className="op-cell-meta">{t('qbittorrent.download')}: {Math.round(Math.max(0, Math.min(100, task.detail.downloadProgress)))}% · {t('qbittorrent.transfer')}: {Math.round(progress)}%</small>}
                                        {task.counts.total > 0 && <small className="op-cell-meta">{task.sourceType === 'telegram_channel'
                                            ? t('tasks.progress.channelItems', { processed: task.detail.processed ?? task.counts.completed, total: task.counts.total, completed: task.counts.completed, failed: task.counts.failed, skipped: task.detail.skipped ?? 0 })
                                            : <>{t('tasks.progress.items', { completed: task.counts.completed, total: task.counts.total })}{task.counts.failed > 0 ? t('tasks.progress.failed', { count: task.counts.failed }) : ''}</>}</small>}
                                        {task.sourceType === 'telegram_channel' && task.status !== 'completed' && !stopped && <small className="op-cell-meta">{t('tasks.progress.channelQueue', { active: task.detail.active ?? 0, pending: task.detail.pending ?? 0 })}</small>}
                                        {['telegram_channel', 'telegram_bot'].includes(task.sourceType) && ['running', 'pending', 'pausing', 'paused'].includes(task.status) && typeof task.detail.downloading === 'number' && <small className="op-cell-meta">{t('tasks.progress.transferStages', { downloading: task.detail.downloading, uploading: task.detail.uploading ?? 0, waiting: task.detail.waitingUpload ?? 0, retrying: task.detail.retrying ?? 0 })}</small>}
                                        {scan && task.detail.scanStatus !== 'done' && !stopped && <small className="op-cell-meta">{t('tasks.progress.channelScan', { messages: Number(scan.channelMessagesScanned ?? 0), files: Number(scan.channelMediaFound ?? 0) })}</small>}
                                        {scan && task.detail.scanStatus !== 'done' && !stopped && (commentMessagesScanned > 0 || commentMediaFound > 0) && <small className="op-cell-meta">{t('tasks.progress.commentScan', { messages: commentMessagesScanned, files: commentMediaFound })}</small>}
                                        {scan && Number(scan.waitUntil || 0) > tasksObservedAt && <small className="op-cell-meta">{t('tasks.progress.scanWait', { time: formatDateTime(new Date(Number(scan.waitUntil)).toISOString(), locale) })}</small>}
                                        {task.sourceType === 'telegram_channel' && task.detail.scanStatus !== 'done' && !stopped && <small className="op-cell-meta">{t('tasks.progress.scanningHint')}</small>}
                                        {task.status === 'awaiting_selection' && <small className="op-cell-meta">{t('tasks.progress.selectionHint')}</small>}
                                        {transfer.showBytes && <small className="op-cell-meta">{t(task.sourceType === 'telegram_channel' ? (task.detail.fileSelectionConfirmed ? 'tasks.progress.selectedData' : 'tasks.progress.savedData') : 'tasks.progress.data', { transferred: transfer.transferred, total: transfer.total })}</small>}
                                        {Number(task.detail.savedUnknownCount) > 0 && <small className="op-cell-meta">{t('tasks.progress.unknownSizes', { count: Number(task.detail.savedUnknownCount) })}</small>}
                                        {(detailSpeed || detailEta) && <small className="op-cell-meta">{detailSpeed ? t('tasks.progress.speed', { speed: detailSpeed }) : ''}{detailSpeed && detailEta ? ' · ' : ''}{detailEta ? t('tasks.progress.eta', { eta: detailEta }) : ''}</small>}
                                        <details className="op-task-details">
                                            <summary>{audit.details}</summary>
                                            <span className="op-task-id"><code>{task.id}</code><button type="button" className="op-icon-button" title={t('tasks.actions.copyId')} aria-label={t('tasks.actions.copyId')} onClick={() => void navigator.clipboard.writeText(task.id)}><Copy className="h-3.5 w-3.5" /></button></span>
                                            {scan && <small className="op-cell-meta">{t('tasks.progress.channelScan', { messages: Number(scan.channelMessagesScanned ?? 0), files: Number(scan.channelMediaFound ?? 0) })}</small>}
                                            {scan && (commentMessagesScanned > 0 || commentMediaFound > 0) && <small className="op-cell-meta">{t('tasks.progress.commentScan', { messages: commentMessagesScanned, files: commentMediaFound })}</small>}
                                            {lastMessageDate && <small className="op-cell-meta">{t('tasks.progress.scanDate', { time: formatDateTime(lastMessageDate, locale) })}</small>}
                                            {task.sourceType === 'telegram_channel' && Number(task.detail.excluded) > 0 && <small className="op-cell-meta">{t('tasks.progress.excluded', { count: Number(task.detail.excluded) })}</small>}
                                            {task.sourceType === 'qbittorrent' && <small className="op-cell-meta">{t(task.detail.preserveLocalFiles ? 'qbittorrent.preserved' : 'qbittorrent.deletedAfterTransfer')}</small>}
                                        </details>
                                        {(task.counts.failed > 0 || task.error) && <TaskFailureDetails task={task} onUnauthorized={onUnauthorized} />}
                                    </TaskCell>
                                    <TaskCell className="op-task-actions">{!selectionMode && <div className="op-actions">
                                        {(['telegram_channel', 'telegram_bot'].includes(task.sourceType) || (task.sourceType === 'qbittorrent' && ['submitting', 'metadata', 'downloading', 'paused'].includes(task.stage))) && ['running', 'pending', 'waiting', 'pausing', 'paused'].includes(task.status) && <Button size="sm" variant="outline" disabled={acting} className="op-action" onClick={() => void controlChannel(task, ['paused', 'pausing'].includes(task.status) ? 'resume' : 'pause')}>{t(['paused', 'pausing'].includes(task.status) ? 'tasks.actions.continue' : 'tasks.actions.pause')}</Button>}
                                        {task.retryable && <Button size="sm" variant="outline" disabled={acting} className="op-action" onClick={() => requestAction(task, 'retry')}>{task.sourceType === 'web_upload' ? <UploadCloud className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}{taskActionLabel(task, 'retry')}</Button>}
                                        {task.cancellable && <Button size="sm" variant="outline" disabled={acting} className="op-action op-danger-button" onClick={() => requestAction(task, 'cancel')}><Ban className="h-4 w-4" />{taskActionLabel(task, 'cancel')}</Button>}
                                        {task.dismissible && <Button size="sm" variant="ghost" disabled={acting} className="op-action op-danger-button" onClick={() => void prepareDismissal({ tasks: [task] })}><Trash2 className="h-4 w-4" />{t('tasks.actions.deleteRecord')}</Button>}
                                    </div>}</TaskCell>
                                </TaskRow>;
                            })}</TaskBody>
                        </TaskCollection>
                    </div>
                )}
            </section>

            {pendingAction && <Dialog open onClose={() => { if (!acting) setPendingAction(null); }} labelledBy="task-action-dialog-title" closeOnEscape={!acting} closeOnBackdrop={!acting} className="w-full max-w-md"><div className="tv-panel op-confirm-card"><h3 id="task-action-dialog-title" className="font-semibold">{pendingAction.action === 'cancel' ? t('tasks.dialogs.confirmAction', { action: taskActionLabel(pendingAction.task, 'cancel') }) : t(pendingAction.task.sourceType === 'qbittorrent' && pendingAction.task.stage === 'cancelling' ? 'qbittorrent.retryCancel' : 'tasks.dialogs.retryTitle')}</h3><p className="mt-2 break-words text-sm text-muted-foreground">{pendingAction.task.title}</p><p className="mt-1 text-xs text-muted-foreground">{t(pendingAction.action === 'cancel' ? 'uiAudit.taskLabels.currentTarget' : pendingAction.task.sourceType === 'qbittorrent' && pendingAction.task.stage === 'cancelling' ? 'qbittorrent.retryCancelHint' : 'tasks.dialogs.targetUnchanged', { target: taskTarget(pendingAction.task) })}</p>{pendingAction.task.sourceType === 'qbittorrent' && pendingAction.action === 'cancel' && <p className="mt-2 text-xs text-muted-foreground">{t('qbittorrent.cancelDescription')}</p>}<div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={acting} onClick={() => setPendingAction(null)}>{t('tasks.actions.back')}</Button><Button variant={pendingAction.action === 'cancel' ? 'destructive' : 'default'} disabled={acting} onClick={() => void confirmAction()}>{acting && <IndeterminateSpinner label={t('tasks.loading.action')} size="sm" className="mr-2" />}{pendingAction.action === 'cancel' ? taskActionLabel(pendingAction.task, 'cancel') : pendingAction.task.sourceType === 'qbittorrent' && pendingAction.task.stage === 'cancelling' ? t('qbittorrent.retryCancel') : t('tasks.dialogs.confirmRetry')}</Button></div></div></Dialog>}

            {dismissalPreview && <Dialog open onClose={() => { if (!acting) setDismissalPreview(null); }} labelledBy="dismiss-title" alert closeOnEscape={!acting} closeOnBackdrop={!acting} className="w-full max-w-md"><div className="tv-panel op-confirm-card"><div className="flex items-start gap-3"><Trash2 className="mt-0.5 h-5 w-5 text-destructive" /><div><h3 id="dismiss-title" className="font-semibold">{t('tasks.dialogs.dismissTitle')}</h3><p className="mt-2 text-sm">{t('tasks.dialogs.dismissCount', { count: dismissalPreview.impact.count })}</p><p className="mt-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">{t('tasks.dialogs.dismissDescription')}</p></div><button className="ml-auto" disabled={acting} onClick={() => setDismissalPreview(null)} aria-label={t('tasks.actions.close')}><X className="h-5 w-5" /></button></div><div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={acting} onClick={() => setDismissalPreview(null)}>{t('tasks.actions.back')}</Button><Button variant="destructive" disabled={acting} onClick={() => void confirmDismissal()}>{acting && <IndeterminateSpinner label={t('tasks.loading.action')} size="sm" className="mr-2" />}{t('tasks.actions.confirmDeleteRecord')}</Button></div></div></Dialog>}
        </section>
    );
};
