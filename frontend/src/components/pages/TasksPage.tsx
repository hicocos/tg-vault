import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle, Ban, CheckCircle2, CheckSquare, Clock3, Copy,
    RefreshCw, RotateCcw, Square, Trash2, UploadCloud, X,
} from 'lucide-react';
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';
import { Button } from '../ui/Button';
import { fileApi, type TaskDismissalPreview, type UnifiedTask, type UnifiedTaskSource } from '../../services/api';
import { authService } from '../../services/auth';
import { cn } from '../../lib/utils';
import { useTranslation } from 'react-i18next';
import { useRuntimeUiLocalization } from './useRuntimeUiLocalization';

interface TasksPageProps { onUnauthorized?: () => void; onOpenUploads?: () => void; }

const SOURCE_OPTIONS: Array<{ value: '' | UnifiedTaskSource; label: string }> = [
    { value: '', label: '全部来源' }, { value: 'web_upload', label: 'Web 上传' },
    { value: 'telegram_bot', label: 'Telegram 文件' }, { value: 'telegram_channel', label: '频道下载' },
    { value: 'ytdlp', label: 'yt-dlp' }, { value: 'subscription', label: '频道订阅' },
];
const STATUS_OPTIONS = [
    { value: '', label: '全部状态' }, { value: 'pending', label: '等待中' },
    { value: 'running', label: '运行中' }, { value: 'paused', label: '已暂停' },
    { value: 'waiting', label: '等待恢复' }, { value: 'failed', label: '失败' },
    { value: 'interrupted', label: '已中断' }, { value: 'retry_required', label: '需要重试' },
    { value: 'completed', label: '已完成' }, { value: 'cancelled', label: '已取消' },
    { value: 'scheduled', label: '已计划' }, { value: 'disabled', label: '已停用' },
];
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(SOURCE_OPTIONS.filter(o => o.value).map(o => [o.value, o.label]));
const STATUS_LABELS: Record<string, string> = Object.fromEntries(STATUS_OPTIONS.filter(o => o.value).map(o => [o.value, o.label]));
const STAGE_LABELS: Record<string, string> = {
    waiting: '排队等待', queued: '排队等待', scanning: '扫描消息', downloading: '下载源文件',
    uploading: '上传到存储', processing: '服务器处理中', awaiting_file: '等待重新选择原文件',
    resumable: '上传会话可续传', waiting_for_next_scan: '等待下次扫描', completed: '处理完成',
    failed: '处理失败', cancelled: '已取消', interrupted: '服务重启时中断',
    retry_required: '需要人工重试', disabled: '已停用',
};

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** unit)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function taskTarget(task: UnifiedTask): string {
    return `${task.target.accountName || task.target.provider || '未记录存储'} / ${task.target.folder || '根目录'}`;
}
function taskKey(task: Pick<UnifiedTask, 'sourceType' | 'id'>): string { return `${task.sourceType}:${task.id}`; }
function statusTone(status: string): string {
    if (status === 'completed') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (['failed', 'interrupted', 'retry_required'].includes(status)) return 'bg-red-50 text-red-700 border-red-200';
    if (['cancelled', 'disabled'].includes(status)) return 'bg-muted text-muted-foreground border-border';
    if (['running', 'pending'].includes(status)) return 'bg-blue-50 text-blue-700 border-blue-200';
    return 'bg-amber-50 text-amber-700 border-amber-200';
}
function StatusIcon({ status }: { status: string }) {
    if (status === 'completed') return <CheckCircle2 className="h-4 w-4" />;
    if (['failed', 'interrupted', 'retry_required'].includes(status)) return <AlertCircle className="h-4 w-4" />;
    if (['cancelled', 'disabled'].includes(status)) return <Ban className="h-4 w-4" />;
    if (status === 'running') return <IndeterminateSpinner label="任务正在运行" size="sm" />;
    return <Clock3 className="h-4 w-4" />;
}

export const TasksPage = ({ onUnauthorized, onOpenUploads }: TasksPageProps) => {
    const { i18n } = useTranslation();
    const locale = i18n.resolvedLanguage?.startsWith('en') ? 'en-US' : 'zh-CN';
    const pageRef = useRef<HTMLDivElement>(null);
    useRuntimeUiLocalization(pageRef);
    const [tasks, setTasks] = useState<UnifiedTask[]>([]);
    const [source, setSource] = useState('');
    const [status, setStatus] = useState('');
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [pendingAction, setPendingAction] = useState<{ task: UnifiedTask; action: 'cancel' | 'retry' } | null>(null);
    const [dismissalPreview, setDismissalPreview] = useState<TaskDismissalPreview | null>(null);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [acting, setActing] = useState(false);
    const requestGeneration = useRef(0);

    const loadTasks = useCallback(async (quiet = false) => {
        const generation = ++requestGeneration.current;
        if (quiet) setRefreshing(true);
        else setLoading(true);
        try {
            const result = await fileApi.getTasks({ source, status, limit: 300 });
            if (generation !== requestGeneration.current) return;
            setTasks(result.tasks); setError(null);
            setSelected(previous => previous.filter(key => result.tasks.some(task => task.dismissible && taskKey(task) === key)));
        } catch (loadError: any) {
            if (generation !== requestGeneration.current) return;
            if (loadError?.message === 'UNAUTHORIZED') { authService.clearToken(); onUnauthorized?.(); return; }
            setError(loadError?.message || '获取任务列表失败');
        } finally {
            if (generation === requestGeneration.current) { setLoading(false); setRefreshing(false); }
        }
    }, [onUnauthorized, source, status]);

    useEffect(() => {
        void loadTasks(false);
        const timer = window.setInterval(() => void loadTasks(true), 5_000);
        return () => window.clearInterval(timer);
    }, [loadTasks]);

    const summary = useMemo(() => ({
        active: tasks.filter(t => ['pending', 'running', 'paused', 'waiting'].includes(t.status)).length,
        failed: tasks.filter(t => ['failed', 'interrupted', 'retry_required'].includes(t.status)).length,
        completed: tasks.filter(t => t.status === 'completed').length,
    }), [tasks]);
    const dismissibleTasks = useMemo(() => tasks.filter(task => task.dismissible), [tasks]);

    const requestAction = (task: UnifiedTask, action: 'cancel' | 'retry') => {
        if (task.sourceType === 'web_upload' && action === 'retry') { onOpenUploads?.(); return; }
        setPendingAction({ task, action });
    };
    const confirmAction = async () => {
        if (!pendingAction) return;
        setActing(true);
        try {
            await fileApi.controlTask(pendingAction.task.sourceType, pendingAction.task.id, pendingAction.action);
            setNotice(pendingAction.action === 'cancel' ? '任务已取消' : '任务已重新提交');
            setPendingAction(null); await loadTasks(true);
        } catch (actionError: any) {
            if (actionError?.message === 'UNAUTHORIZED') { authService.clearToken(); onUnauthorized?.(); }
            else { setError(actionError?.message || '任务操作失败'); setPendingAction(null); }
        } finally { setActing(false); }
    };

    const prepareDismissal = async (input: { tasks?: UnifiedTask[]; filtered?: boolean }) => {
        setActing(true); setError(null);
        try {
            const preview = await fileApi.prepareTaskDismissal(input.tasks
                ? { tasks: input.tasks.map(task => ({ sourceType: task.sourceType, id: task.id })) }
                : { source, status });
            setDismissalPreview(preview);
        } catch (dismissError: any) {
            if (dismissError?.message === 'UNAUTHORIZED') { authService.clearToken(); onUnauthorized?.(); }
            else setError(dismissError?.message || '无法创建删除预览');
        } finally { setActing(false); }
    };
    const confirmDismissal = async () => {
        if (!dismissalPreview) return;
        setActing(true);
        try {
            const result = await fileApi.confirmTaskDismissal(dismissalPreview);
            setNotice(result.failed.length ? `已删除 ${result.dismissed.length} 条，${result.failed.length} 条因状态变化未删除` : `已从任务中心删除 ${result.dismissed.length} 条记录`);
            setDismissalPreview(null); setSelected([]); setSelectionMode(false); await loadTasks(true);
        } catch (dismissError: any) {
            if (dismissError?.message === 'UNAUTHORIZED') { authService.clearToken(); onUnauthorized?.(); }
            else setError(dismissError?.message || '删除任务记录失败');
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
        <div ref={pageRef} className="mx-auto min-h-full max-w-7xl space-y-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div><h2 className="text-2xl font-bold">任务中心</h2><p className="mt-1 text-sm text-muted-foreground">查看和管理 Web、Telegram、频道订阅及 yt-dlp 任务。</p></div>
                <div className="grid grid-cols-3 gap-2 text-center text-xs sm:text-sm">
                    <button className="rounded-md border px-2 py-2" onClick={() => setStatus('')}>进行中 {summary.active}</button>
                    <button className="rounded-md border border-red-200 bg-red-50 px-2 py-2 text-red-700" onClick={() => setStatus('failed')}>需处理 {summary.failed}</button>
                    <button className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-2 text-emerald-700" onClick={() => setStatus('completed')}>已完成 {summary.completed}</button>
                </div>
            </div>

            <div className="border-y border-border py-4">
                <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                    <select className="h-10 min-w-0 rounded-md border bg-background px-2 text-sm sm:w-auto" value={source} onChange={e => setSource(e.target.value)} aria-label="按任务来源筛选">{SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                    <select className="h-10 min-w-0 rounded-md border bg-background px-2 text-sm sm:w-auto" value={status} onChange={e => setStatus(e.target.value)} aria-label="按任务状态筛选">{STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                    <div className="col-span-2 flex flex-wrap gap-2 sm:ml-auto">
                        <Button size="sm" variant="outline" className="gap-2" onClick={() => { setSelectionMode(!selectionMode); setSelected([]); }} disabled={!dismissibleTasks.length}><CheckSquare className="h-4 w-4" />{selectionMode ? '退出选择' : '选择任务'}</Button>
                        <Button size="sm" variant="outline" className="gap-2 text-red-700" onClick={() => void prepareDismissal({ filtered: true })} disabled={!dismissibleTasks.length || acting}><Trash2 className="h-4 w-4" />清理终态记录</Button>
                        <Button size="icon" variant="outline" aria-label="刷新任务" title="刷新" onClick={() => void loadTasks(true)} disabled={refreshing}>{refreshing ? <IndeterminateSpinner label="正在刷新任务" size="sm" /> : <RefreshCw className="h-4 w-4" />}</Button>
                    </div>
                </div>
                {selectionMode && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm"><span>已选择 {selected.length} 条</span><Button size="sm" variant="outline" onClick={() => setSelected(dismissibleTasks.map(taskKey))}>全选可删除</Button><Button size="sm" variant="ghost" onClick={() => setSelected([])}>清空</Button><Button size="sm" variant="destructive" disabled={!selected.length || acting} onClick={() => void prepareDismissal({ tasks: selectedTasks })}>删除所选</Button></div>}
            </div>

            {notice && <div className="flex justify-between rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><span>{notice}</span><button onClick={() => setNotice(null)}>关闭</button></div>}
            {error && <div className="flex items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><span>{error}</span><Button size="sm" variant="outline" onClick={() => void loadTasks(false)}>重试</Button></div>}

            {loading ? <div className="flex min-h-48 items-center justify-center"><IndeterminateSpinner label="正在加载任务" size="md" /></div> : tasks.length === 0 ? <div className="flex min-h-48 flex-col items-center justify-center border-y text-center"><Clock3 className="mb-3 h-7 w-7 text-muted-foreground" /><p className="font-medium">没有符合条件的任务</p><p className="mt-1 text-sm text-muted-foreground">调整来源或状态筛选后再查看。</p></div> : (
                <div className="divide-y divide-border border-y">
                    {tasks.map(task => {
                        const stageLabel = STAGE_LABELS[task.stage] || task.stage;
                        const statusLabel = STATUS_LABELS[task.status] || task.status;
                        const showStage = STAGE_LABELS[task.stage] !== STATUS_LABELS[task.status] && stageLabel !== statusLabel;
                        const detailSpeed = typeof task.detail.speed === 'string' ? task.detail.speed : null;
                        const detailEta = typeof task.detail.eta === 'string' ? task.detail.eta : null;
                        const checked = selected.includes(taskKey(task));
                        return <article key={taskKey(task)} className="py-5">
                            <div className="flex gap-3">
                                {selectionMode && <button type="button" className={cn('mt-1 h-10 w-10 shrink-0 items-center justify-center rounded-md', task.dismissible ? 'flex' : 'hidden')} onClick={() => toggleSelection(task)} aria-label={checked ? '取消选择任务' : '选择任务'}>{checked ? <CheckSquare className="h-5 w-5 text-primary" /> : <Square className="h-5 w-5" />}</button>}
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-muted-foreground">{SOURCE_LABELS[task.sourceType] || task.sourceType}</span><span className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium', statusTone(task.status))}><StatusIcon status={task.status} />{statusLabel}</span>{showStage && <span className="text-xs text-muted-foreground">{stageLabel}</span>}</div>
                                    <h3 className="mt-2 line-clamp-2 break-words text-base font-semibold">{task.title}</h3>
                                    <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2"><span className="break-all" title={taskTarget(task)}>目标：{taskTarget(task)}</span><span>更新：{new Date(task.updatedAt).toLocaleString(locale, { hour12: false })}</span>{(detailSpeed || detailEta) && <span>{detailSpeed ? `速度 ${detailSpeed}` : ''}{detailSpeed && detailEta ? ' · ' : ''}{detailEta ? `ETA ${detailEta}` : ''}</span>}</div>
                                    {(task.progress > 0 || ['running', 'paused', 'failed'].includes(task.status)) && <div className="mt-3 flex items-center gap-3"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} /></div><span className="w-10 text-right text-xs">{Math.round(task.progress)}%</span></div>}
                                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{task.counts.total > 0 && <span>条目 {task.counts.completed}/{task.counts.total}{task.counts.failed > 0 ? `，失败 ${task.counts.failed}` : ''}</span>}{task.bytes.total > 0 && <span>数据 {formatBytes(task.bytes.transferred)} / {formatBytes(task.bytes.total)}</span>}<span className="inline-flex items-center gap-1 font-mono" title={task.id}>ID {task.id.length > 18 ? `${task.id.slice(0, 18)}...` : task.id}<button title="复制任务 ID" aria-label="复制任务 ID" onClick={() => void navigator.clipboard.writeText(task.id)}><Copy className="h-3.5 w-3.5" /></button></span></div>
                                    {task.error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 break-words">{task.error}</p>}
                                </div>
                                {!selectionMode && <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row">{task.retryable && <Button size="sm" variant="outline" className="gap-1" onClick={() => requestAction(task, 'retry')}>{task.sourceType === 'web_upload' ? <UploadCloud className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}{task.sourceType === 'web_upload' ? '续传' : '重试'}</Button>}{task.cancellable && <Button size="sm" variant="outline" className="gap-1 text-red-700" onClick={() => requestAction(task, 'cancel')}><Ban className="h-4 w-4" />取消</Button>}{task.dismissible && <Button size="sm" variant="ghost" className="gap-1 text-red-700" onClick={() => void prepareDismissal({ tasks: [task] })}><Trash2 className="h-4 w-4" /><span className="hidden sm:inline">删除记录</span></Button>}</div>}
                            </div>
                        </article>;
                    })}
                </div>
            )}

            {pendingAction && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-lg bg-background p-5 shadow-xl"><h3 className="font-semibold">{pendingAction.action === 'cancel' ? '确认取消任务' : '确认重试任务'}</h3><p className="mt-2 break-words text-sm text-muted-foreground">{pendingAction.task.title}</p><p className="mt-1 text-xs text-muted-foreground">目标保持为：{taskTarget(pendingAction.task)}</p><div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={acting} onClick={() => setPendingAction(null)}>返回</Button><Button variant={pendingAction.action === 'cancel' ? 'destructive' : 'default'} disabled={acting} onClick={() => void confirmAction()}>{acting && <IndeterminateSpinner label="正在执行任务操作" size="sm" className="mr-2" />}{pendingAction.action === 'cancel' ? '确认取消' : '确认重试'}</Button></div></div></div>}

            {dismissalPreview && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="dismiss-title"><div className="w-full max-w-md rounded-xl border bg-background p-5 shadow-xl"><div className="flex items-start gap-3"><Trash2 className="mt-0.5 h-5 w-5 text-red-600" /><div><h3 id="dismiss-title" className="font-semibold">确认从任务中心删除</h3><p className="mt-2 text-sm">将删除 {dismissalPreview.impact.count} 条终态记录。</p><p className="mt-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">只会从任务中心隐藏记录，不会删除任何文件、云端对象、订阅配置或底层任务数据。任务状态再次变化后会重新出现。</p></div><button className="ml-auto" onClick={() => setDismissalPreview(null)} aria-label="关闭"><X className="h-5 w-5" /></button></div><div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={acting} onClick={() => setDismissalPreview(null)}>返回</Button><Button variant="destructive" disabled={acting} onClick={() => void confirmDismissal()}>{acting && <IndeterminateSpinner label="正在执行任务操作" size="sm" className="mr-2" />}确认删除记录</Button></div></div></div>}
        </div>
    );
};
