import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle, Ban, CheckCircle2, CheckSquare, Clock3, Copy,
    RefreshCw, RotateCcw, Square, Trash2, UploadCloud, X,
} from 'lucide-react';
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';
import { Button } from '../ui/Button';
import { fileApi, type TaskDismissalPreview, type UnifiedTask, type UnifiedTaskSource } from '../../services/api';
import { isUnauthorizedError } from '../../services/apiActionError';
import { cn } from '../../lib/utils';
import { formatBytes } from '../../services/formatBytes';
import { useTranslation } from 'react-i18next';
import { dismissibleTaskSnapshot, pruneSelectedTaskKeys, scopeTasks, summarizeTaskStatuses, type TaskQuickFilter } from '../../services/taskQuickFilters';
import { createSerialPoller } from '../../services/serialPoller';
import { Dialog } from '../ui/Dialog';
import { errorMessage } from '../../services/unknownError';

interface TasksPageProps { onUnauthorized?: () => void; onOpenUploads?: () => void; onShowAllTasks?: () => void; initialAccountId?: string | null; }
interface TaskNotice { message: string; sequence: number; }

const SOURCE_OPTIONS: Array<{ value: '' | UnifiedTaskSource; labelKey: string }> = [
    { value: '', labelKey: 'tasks.sources.all' }, { value: 'web_upload', labelKey: 'tasks.sources.webUpload' },
    { value: 'telegram_bot', labelKey: 'tasks.sources.telegramFile' }, { value: 'telegram_channel', labelKey: 'tasks.sources.channelDownload' },
    { value: 'telegram_target', labelKey: 'tasks.sources.telegramTarget' },
    { value: 'subscription', labelKey: 'tasks.sources.subscription' },
];
const STATUS_OPTIONS = [
    { value: '', labelKey: 'tasks.statuses.all' }, { value: 'pending', labelKey: 'tasks.statuses.pending' },
    { value: 'running', labelKey: 'tasks.statuses.running' }, { value: 'paused', labelKey: 'tasks.statuses.paused' },
    { value: 'waiting', labelKey: 'tasks.statuses.waiting' }, { value: 'failed', labelKey: 'tasks.statuses.failed' },
    { value: 'interrupted', labelKey: 'tasks.statuses.interrupted' }, { value: 'retry_required', labelKey: 'tasks.statuses.retryRequired' },
    { value: 'completed', labelKey: 'tasks.statuses.completed' }, { value: 'cancelled', labelKey: 'tasks.statuses.cancelled' },
    { value: 'scheduled', labelKey: 'tasks.statuses.scheduled' }, { value: 'disabled', labelKey: 'tasks.statuses.disabled' },
];
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(SOURCE_OPTIONS.filter(o => o.value).map(o => [o.value, o.labelKey]));
const STATUS_LABELS: Record<string, string> = Object.fromEntries(STATUS_OPTIONS.filter(o => o.value).map(o => [o.value, o.labelKey]));
const STAGE_LABELS: Record<string, string> = {
    waiting: 'tasks.stages.queued', queued: 'tasks.stages.queued', scanning: 'tasks.stages.scanning', downloading: 'tasks.stages.downloading',
    uploading: 'tasks.stages.uploading', processing: 'tasks.stages.processing', awaiting_file: 'tasks.stages.awaitingFile',
    resumable: 'tasks.stages.resumable', waiting_for_next_scan: 'tasks.stages.waitingForNextScan', waiting_for_next_task: 'tasks.stages.waitingForNextTask', completed: 'tasks.stages.completed',
    failed: 'tasks.stages.failed', cancelled: 'tasks.statuses.cancelled', interrupted: 'tasks.stages.interrupted',
    retry_required: 'tasks.stages.retryRequired', disabled: 'tasks.statuses.disabled',
};

function taskKey(task: Pick<UnifiedTask, 'sourceType' | 'id'>): string { return `${task.sourceType}:${task.id}`; }
function statusTone(status: string): string {
    if (status === 'completed') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (['failed', 'interrupted', 'retry_required'].includes(status)) return 'bg-red-50 text-red-700 border-red-200';
    if (['cancelled', 'disabled'].includes(status)) return 'bg-muted text-muted-foreground border-border';
    if (['running', 'pending'].includes(status)) return 'bg-blue-50 text-blue-700 border-blue-200';
    return 'bg-amber-50 text-amber-700 border-amber-200';
}
function StatusIcon({ status, runningLabel }: { status: string; runningLabel: string }) {
    if (status === 'completed') return <CheckCircle2 className="h-4 w-4" />;
    if (['failed', 'interrupted', 'retry_required'].includes(status)) return <AlertCircle className="h-4 w-4" />;
    if (['cancelled', 'disabled'].includes(status)) return <Ban className="h-4 w-4" />;
    if (status === 'running') return <IndeterminateSpinner label={runningLabel} size="sm" />;
    return <Clock3 className="h-4 w-4" />;
}

export const TasksPage = ({ onUnauthorized, onOpenUploads, onShowAllTasks, initialAccountId }: TasksPageProps) => {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || i18n.language;
    const taskTarget = (task: UnifiedTask): string => t('tasks.target.path', {
        storage: task.target.accountName || task.target.provider || t('tasks.target.unknownStorage'),
        folder: task.target.folder || t('tasks.target.root'),
    });
    const [tasks, setTasks] = useState<UnifiedTask[]>([]);
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
            const relevantTasks = initialAccountId
                ? result.tasks.filter(task => task.target.accountId === initialAccountId)
                : result.tasks;
            tasksRef.current = relevantTasks;
            setTasks(relevantTasks); setError(null);
            setSelected(previous => pruneSelectedTaskKeys(previous, relevantTasks, scopeFilters, taskKey));
        } catch (loadError: unknown) {
            if (generation !== requestGeneration.current) return;
            if (isUnauthorizedError(loadError)) { onUnauthorized?.(); return; }
            setError(errorMessage(loadError, t('tasks.errors.load')));
        } finally {
            if (generation === requestGeneration.current) { setLoading(false); setRefreshing(false); }
        }
    }, [initialAccountId, onUnauthorized, scopeFilters, source, status]);

    useEffect(() => {
        let first = true;
        const nextDelayMs = () => {
            if (document.visibilityState !== 'visible') return 60_000;
            return tasksRef.current.some(task => ['pending', 'running', 'paused', 'waiting', 'interrupted'].includes(task.status)) ? 5_000 : 20_000;
        };
        const poller = createSerialPoller({
            run: async () => {
                await loadTasks(!first);
                first = false;
            },
            schedule: (callback, delay) => window.setTimeout(callback, delay),
            cancel: handle => window.clearTimeout(handle as number),
            delayMs: 5_000,
            nextDelayMs,
        });
        poller.start();
        return () => {
            poller.stop();
            requestGeneration.current += 1;
        };
    }, [loadTasks]);

    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(null), 4_000);
        return () => window.clearTimeout(timer);
    }, [notice?.sequence]);

    const summary = useMemo(() => summarizeTaskStatuses(tasks), [tasks]);
    const visibleTasks = useMemo(() => scopeTasks(tasks, scopeFilters), [scopeFilters, tasks]);
    const dismissibleTasks = useMemo(() => dismissibleTaskSnapshot(tasks, scopeFilters), [scopeFilters, tasks]);

    const taskActionLabel = (task: UnifiedTask, action: 'cancel' | 'retry'): string => {
        if (action === 'retry') return task.sourceType === 'web_upload' ? t('tasks.actions.resume') : t('tasks.actions.retry');
        if (task.sourceType === 'subscription') return t('tasks.actions.followDefault');
        if (task.sourceType === 'telegram_target') return t('tasks.actions.clearTarget');
        return t('tasks.actions.cancel');
    };
    const requestAction = (task: UnifiedTask, action: 'cancel' | 'retry') => {
        if (task.sourceType === 'web_upload' && action === 'retry') { onOpenUploads?.(); return; }
        setPendingAction({ task, action });
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
        <div className="mx-auto min-h-full max-w-7xl space-y-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <h2 className="text-2xl font-bold">{t('tasks.title')}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{t(initialAccountId ? 'tasks.subtitleScoped' : 'tasks.subtitle')}</p>
                    {initialAccountId && <button type="button" className="mt-2 text-sm font-medium text-primary hover:underline" onClick={onShowAllTasks}>{t('tasks.showAll')}</button>}
                </div>
                <div className="grid grid-cols-4 gap-2 text-center text-xs sm:text-sm">
                    {([
                        ['all', 'tasks.quickFilters.all', tasks.length, ''],
                        ['active', 'tasks.quickFilters.active', summary.active, ''],
                        ['attention', 'tasks.quickFilters.attention', summary.attention, 'border-red-200 text-red-700'],
                        ['completed', 'tasks.quickFilters.completed', summary.completed, 'border-emerald-200 text-emerald-700'],
                    ] as const).map(([filter, labelKey, count, tone]) => (
                        <button
                            key={filter}
                            type="button"
                            aria-pressed={quickFilter === filter}
                            className={cn(
                                'min-w-0 break-words whitespace-normal rounded-md border px-2 py-2 text-center leading-tight transition-colors',
                                tone,
                                quickFilter === filter ? 'bg-primary text-primary-foreground ring-2 ring-primary/20' : 'bg-background hover:bg-muted/60',
                            )}
                            onClick={() => { setStatus(''); setQuickFilter(filter); }}
                        >
                            {t(labelKey)} {count}
                        </button>
                    ))}
                </div>
            </div>

            <div className="border-y border-border py-4">
                <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                    <select className="h-10 min-w-0 whitespace-normal rounded-md border bg-background px-2 text-sm sm:w-auto" value={source} onChange={e => setSource(e.target.value)} aria-label={t('tasks.filters.sourceAria')}>{SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}</select>
                    <select className="h-10 min-w-0 whitespace-normal rounded-md border bg-background px-2 text-sm sm:w-auto" value={status} onChange={e => { setStatus(e.target.value); setQuickFilter('all'); }} aria-label={t('tasks.filters.statusAria')}>{STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}</select>
                    <div className="col-span-2 flex flex-wrap gap-2 sm:ml-auto">
                        <Button size="sm" variant="outline" className="gap-2" onClick={() => { setSelectionMode(!selectionMode); setSelected([]); }} disabled={!dismissibleTasks.length}><CheckSquare className="h-4 w-4" />{t(selectionMode ? 'tasks.selection.exit' : 'tasks.selection.enter')}</Button>
                        <Button size="sm" variant="outline" className="gap-2 text-red-700" onClick={() => void prepareDismissal({ tasks: dismissibleTasks })} disabled={!dismissibleTasks.length || acting}><Trash2 className="h-4 w-4" />{t('tasks.actions.cleanTerminal')}</Button>
                        <Button size="icon" variant="outline" aria-label={t('tasks.actions.refreshAria')} title={t('tasks.actions.refresh')} onClick={() => void loadTasks(true)} disabled={refreshing}>{refreshing ? <IndeterminateSpinner label={t('tasks.loading.refresh')} size="sm" /> : <RefreshCw className="h-4 w-4" />}</Button>
                    </div>
                </div>
                {selectionMode && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm"><span>{t('tasks.selection.count', { count: selected.length })}</span><Button size="sm" variant="outline" onClick={() => setSelected(dismissibleTasks.map(taskKey))}>{t('tasks.selection.selectAll')}</Button><Button size="sm" variant="ghost" onClick={() => setSelected([])}>{t('tasks.selection.clear')}</Button><Button size="sm" variant="destructive" disabled={!selected.length || acting} onClick={() => void prepareDismissal({ tasks: selectedTasks })}>{t('tasks.selection.delete')}</Button></div>}
            </div>

            {notice && <div className="flex items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status" aria-live="polite"><span>{notice.message}</span><button type="button" className="rounded p-1 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600" onClick={() => setNotice(null)} aria-label={t('tasks.actions.closeNotice')} title={t('tasks.actions.closeNotice')}><X className="h-4 w-4" /></button></div>}
            {error && <div className="flex items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><span>{error}</span><Button size="sm" variant="outline" onClick={() => void loadTasks(false)}>{t('tasks.actions.retry')}</Button></div>}

            {loading ? <div className="flex min-h-48 items-center justify-center"><IndeterminateSpinner label={t('tasks.loading.initial')} size="md" /></div> : visibleTasks.length === 0 ? <div className="flex min-h-48 flex-col items-center justify-center border-y text-center"><Clock3 className="mb-3 h-7 w-7 text-muted-foreground" /><p className="font-medium">{t('tasks.empty.title')}</p><p className="mt-1 text-sm text-muted-foreground">{t('tasks.empty.description')}</p></div> : (
                <div className="divide-y divide-border border-y">
                    {visibleTasks.map(task => {
                        const stageLabel = STAGE_LABELS[task.stage] ? t(STAGE_LABELS[task.stage]) : task.stage;
                        const statusLabel = STATUS_LABELS[task.status] ? t(STATUS_LABELS[task.status]) : task.status;
                        const showStage = STAGE_LABELS[task.stage] !== STATUS_LABELS[task.status] && stageLabel !== statusLabel;
                        const detailSpeed = typeof task.detail.speed === 'string' ? task.detail.speed : null;
                        const detailEta = typeof task.detail.eta === 'string' ? task.detail.eta : null;
                        const checked = selected.includes(taskKey(task));
                        return <article key={taskKey(task)} className="py-5">
                            <div className="flex gap-3">
                                {selectionMode && <button type="button" className={cn('mt-1 h-10 w-10 shrink-0 items-center justify-center rounded-md', task.dismissible ? 'flex' : 'hidden')} onClick={() => toggleSelection(task)} aria-label={t(checked ? 'tasks.selection.deselectAria' : 'tasks.selection.selectAria')}>{checked ? <CheckSquare className="h-5 w-5 text-primary" /> : <Square className="h-5 w-5" />}</button>}
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-muted-foreground">{SOURCE_LABELS[task.sourceType] ? t(SOURCE_LABELS[task.sourceType]) : task.sourceType}</span><span className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium', statusTone(task.status))}><StatusIcon status={task.status} runningLabel={t('tasks.loading.running')} />{statusLabel}</span>{showStage && <span className="text-xs text-muted-foreground">{stageLabel}</span>}</div>
                                    <h3 className="mt-2 line-clamp-2 break-words text-base font-semibold">{task.title}</h3>
                                    <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2"><span className="break-all" title={taskTarget(task)}>{t('tasks.target.label', { target: taskTarget(task) })}</span><span>{t('tasks.updated', { time: new Date(task.updatedAt).toLocaleString(locale, { hour12: false }) })}</span>{(detailSpeed || detailEta) && <span>{detailSpeed ? t('tasks.progress.speed', { speed: detailSpeed }) : ''}{detailSpeed && detailEta ? ' · ' : ''}{detailEta ? t('tasks.progress.eta', { eta: detailEta }) : ''}</span>}</div>
                                    {(task.progress > 0 || ['running', 'paused', 'failed'].includes(task.status)) && <div className="mt-3 flex items-center gap-3"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} /></div><span className="w-10 text-right text-xs">{Math.round(task.progress)}%</span></div>}
                                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{task.counts.total > 0 && <span>{t('tasks.progress.items', { completed: task.counts.completed, total: task.counts.total })}{task.counts.failed > 0 ? t('tasks.progress.failed', { count: task.counts.failed }) : ''}</span>}{task.bytes.total > 0 && <span>{t('tasks.progress.data', { transferred: formatBytes(task.bytes.transferred), total: formatBytes(task.bytes.total) })}</span>}<span className="inline-flex items-center gap-1 font-mono" title={task.id}>ID {task.id.length > 18 ? `${task.id.slice(0, 18)}...` : task.id}<button title={t('tasks.actions.copyId')} aria-label={t('tasks.actions.copyId')} onClick={() => void navigator.clipboard.writeText(task.id)}><Copy className="h-3.5 w-3.5" /></button></span></div>
                                    {task.error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 break-words">{task.error}</p>}
                                </div>
                                {!selectionMode && <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row">{task.retryable && <Button size="sm" variant="outline" className="gap-1" onClick={() => requestAction(task, 'retry')}>{task.sourceType === 'web_upload' ? <UploadCloud className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}{taskActionLabel(task, 'retry')}</Button>}{task.cancellable && <Button size="sm" variant="outline" className="gap-1 text-red-700" onClick={() => requestAction(task, 'cancel')}><Ban className="h-4 w-4" />{taskActionLabel(task, 'cancel')}</Button>}{task.dismissible && <Button size="sm" variant="ghost" className="gap-1 text-red-700" onClick={() => void prepareDismissal({ tasks: [task] })}><Trash2 className="h-4 w-4" /><span className="hidden sm:inline">{t('tasks.actions.deleteRecord')}</span></Button>}</div>}
                            </div>
                        </article>;
                    })}
                </div>
            )}

            {pendingAction && <Dialog open onClose={() => { if (!acting) setPendingAction(null); }} labelledBy="task-action-dialog-title" closeOnEscape={!acting} closeOnBackdrop={!acting} className="w-full max-w-md"><div className="w-full rounded-lg bg-background p-5 shadow-xl"><h3 id="task-action-dialog-title" className="font-semibold">{pendingAction.action === 'cancel' ? t('tasks.dialogs.confirmAction', { action: taskActionLabel(pendingAction.task, 'cancel') }) : t('tasks.dialogs.retryTitle')}</h3><p className="mt-2 break-words text-sm text-muted-foreground">{pendingAction.task.title}</p><p className="mt-1 text-xs text-muted-foreground">{t('tasks.dialogs.targetUnchanged', { target: taskTarget(pendingAction.task) })}</p><div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={acting} onClick={() => setPendingAction(null)}>{t('tasks.actions.back')}</Button><Button variant={pendingAction.action === 'cancel' ? 'destructive' : 'default'} disabled={acting} onClick={() => void confirmAction()}>{acting && <IndeterminateSpinner label={t('tasks.loading.action')} size="sm" className="mr-2" />}{pendingAction.action === 'cancel' ? t('tasks.dialogs.confirmAction', { action: taskActionLabel(pendingAction.task, 'cancel') }) : t('tasks.dialogs.confirmRetry')}</Button></div></div></Dialog>}

            {dismissalPreview && <Dialog open onClose={() => { if (!acting) setDismissalPreview(null); }} labelledBy="dismiss-title" alert closeOnEscape={!acting} closeOnBackdrop={!acting} className="w-full max-w-md"><div className="w-full rounded-xl border bg-background p-5 shadow-xl"><div className="flex items-start gap-3"><Trash2 className="mt-0.5 h-5 w-5 text-red-600" /><div><h3 id="dismiss-title" className="font-semibold">{t('tasks.dialogs.dismissTitle')}</h3><p className="mt-2 text-sm">{t('tasks.dialogs.dismissCount', { count: dismissalPreview.impact.count })}</p><p className="mt-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">{t('tasks.dialogs.dismissDescription')}</p></div><button className="ml-auto" onClick={() => setDismissalPreview(null)} aria-label={t('tasks.actions.close')}><X className="h-5 w-5" /></button></div><div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={acting} onClick={() => setDismissalPreview(null)}>{t('tasks.actions.back')}</Button><Button variant="destructive" disabled={acting} onClick={() => void confirmDismissal()}>{acting && <IndeterminateSpinner label={t('tasks.loading.action')} size="sm" className="mr-2" />}{t('tasks.actions.confirmDeleteRecord')}</Button></div></div></Dialog>}
        </div>
    );
};
