import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle,
    Ban,
    CheckCircle2,
    Clock3,
    Copy,
    Loader2,
    RefreshCw,
    RotateCcw,
    UploadCloud,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { fileApi, type UnifiedTask, type UnifiedTaskSource } from '../../services/api';
import { authService } from '../../services/auth';
import { cn } from '../../lib/utils';
import { useTranslation } from 'react-i18next';
import { useRuntimeUiLocalization } from './useRuntimeUiLocalization';

interface TasksPageProps {
    onUnauthorized?: () => void;
    onOpenUploads?: () => void;
}

const SOURCE_OPTIONS: Array<{ value: '' | UnifiedTaskSource; label: string }> = [
    { value: '', label: '全部来源' },
    { value: 'web_upload', label: 'Web 上传' },
    { value: 'telegram_bot', label: 'Telegram 文件' },
    { value: 'telegram_channel', label: '频道下载' },
    { value: 'ytdlp', label: 'yt-dlp' },
    { value: 'subscription', label: '频道订阅' },
];

const STATUS_OPTIONS = [
    { value: '', label: '全部状态' },
    { value: 'pending', label: '等待中' },
    { value: 'running', label: '运行中' },
    { value: 'paused', label: '已暂停' },
    { value: 'waiting', label: '等待恢复' },
    { value: 'failed', label: '失败' },
    { value: 'interrupted', label: '已中断' },
    { value: 'retry_required', label: '需要重试' },
    { value: 'completed', label: '已完成' },
    { value: 'cancelled', label: '已取消' },
    { value: 'scheduled', label: '已计划' },
    { value: 'disabled', label: '已停用' },
];

const SOURCE_LABELS: Record<string, string> = Object.fromEntries(SOURCE_OPTIONS.filter(option => option.value).map(option => [option.value, option.label]));
const STATUS_LABELS: Record<string, string> = Object.fromEntries(STATUS_OPTIONS.filter(option => option.value).map(option => [option.value, option.label]));
const STAGE_LABELS: Record<string, string> = {
    waiting: '排队等待',
    queued: '排队等待',
    scanning: '扫描消息',
    downloading: '下载源文件',
    uploading: '上传到存储',
    processing: '服务器处理中',
    awaiting_file: '等待重新选择原文件',
    resumable: '上传会话可续传',
    waiting_for_next_scan: '等待下次扫描',
    completed: '处理完成',
    failed: '处理失败',
    cancelled: '已取消',
    interrupted: '服务重启时中断',
    retry_required: '需要人工重试',
    disabled: '已停用',
};

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** unit)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function taskTarget(task: UnifiedTask): string {
    const storage = task.target.accountName || task.target.provider || '未记录存储';
    return `${storage} / ${task.target.folder || '根目录'}`;
}

function statusTone(status: string): string {
    if (status === 'completed') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (['failed', 'interrupted', 'retry_required'].includes(status)) return 'bg-red-50 text-red-700 border-red-200';
    if (status === 'cancelled' || status === 'disabled') return 'bg-muted text-muted-foreground border-border';
    if (['running', 'pending'].includes(status)) return 'bg-blue-50 text-blue-700 border-blue-200';
    return 'bg-amber-50 text-amber-700 border-amber-200';
}

function StatusIcon({ status }: { status: string }) {
    if (status === 'completed') return <CheckCircle2 className="h-4 w-4" />;
    if (['failed', 'interrupted', 'retry_required'].includes(status)) return <AlertCircle className="h-4 w-4" />;
    if (status === 'cancelled' || status === 'disabled') return <Ban className="h-4 w-4" />;
    if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin" />;
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
    const [acting, setActing] = useState(false);
    const requestGeneration = useRef(0);

    const loadTasks = useCallback(async (quiet = false) => {
        const generation = ++requestGeneration.current;
        if (quiet) setRefreshing(true);
        else setLoading(true);
        try {
            const result = await fileApi.getTasks({ source, status, limit: 300 });
            if (generation !== requestGeneration.current) return;
            setTasks(result.tasks);
            setError(null);
        } catch (loadError: any) {
            if (generation !== requestGeneration.current) return;
            if (loadError?.message === 'UNAUTHORIZED') {
                authService.clearToken();
                onUnauthorized?.();
                return;
            }
            setError(loadError?.message || '获取任务列表失败');
        } finally {
            if (generation === requestGeneration.current) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, [onUnauthorized, source, status]);

    useEffect(() => {
        void loadTasks(false);
        const timer = window.setInterval(() => void loadTasks(true), 5_000);
        return () => window.clearInterval(timer);
    }, [loadTasks]);

    const summary = useMemo(() => ({
        active: tasks.filter(task => ['pending', 'running', 'paused', 'waiting'].includes(task.status)).length,
        failed: tasks.filter(task => ['failed', 'interrupted', 'retry_required'].includes(task.status)).length,
        completed: tasks.filter(task => task.status === 'completed').length,
    }), [tasks]);

    const requestAction = (task: UnifiedTask, action: 'cancel' | 'retry') => {
        if (task.sourceType === 'web_upload' && action === 'retry') {
            onOpenUploads?.();
            return;
        }
        setPendingAction({ task, action });
    };

    const confirmAction = async () => {
        if (!pendingAction) return;
        setActing(true);
        try {
            await fileApi.controlTask(pendingAction.task.sourceType, pendingAction.task.id, pendingAction.action);
            setNotice(pendingAction.action === 'cancel' ? '任务已取消' : '任务已重新提交');
            setPendingAction(null);
            await loadTasks(true);
        } catch (actionError: any) {
            if (actionError?.message === 'UNAUTHORIZED') {
                authService.clearToken();
                onUnauthorized?.();
            } else {
                setError(actionError?.message || '任务操作失败');
                setPendingAction(null);
            }
        } finally {
            setActing(false);
        }
    };

    return (
        <div ref={pageRef} className="max-w-7xl mx-auto min-h-full space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <h2 className="text-2xl font-bold text-foreground">任务中心</h2>
                    <p className="mt-1 text-sm text-muted-foreground">查看 Web、Telegram、频道订阅和 yt-dlp 的统一执行状态。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="rounded-md border border-border px-2.5 py-1.5">进行中 {summary.active}</span>
                    <span className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-red-700">需处理 {summary.failed}</span>
                    <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-emerald-700">已完成 {summary.completed}</span>
                </div>
            </div>

            <div className="flex flex-col gap-3 border-y border-border py-4 sm:flex-row sm:items-center">
                <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={source} onChange={event => setSource(event.target.value)} aria-label="按任务来源筛选">
                    {SOURCE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={status} onChange={event => setStatus(event.target.value)} aria-label="按任务状态筛选">
                    {STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <Button variant="outline" className="gap-2 sm:ml-auto" onClick={() => void loadTasks(true)} disabled={refreshing}>
                    <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
                    刷新
                </Button>
            </div>

            {notice && (
                <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                    <span>{notice}</span>
                    <button type="button" className="font-medium" onClick={() => setNotice(null)}>关闭</button>
                </div>
            )}
            {error && (
                <div className="flex items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                    <span>{error}</span>
                    <Button size="sm" variant="outline" onClick={() => void loadTasks(false)}>重试</Button>
                </div>
            )}

            {loading ? (
                <div className="flex min-h-48 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
            ) : tasks.length === 0 ? (
                <div className="flex min-h-48 flex-col items-center justify-center border-y border-border text-center">
                    <Clock3 className="mb-3 h-7 w-7 text-muted-foreground" />
                    <p className="font-medium">没有符合条件的任务</p>
                    <p className="mt-1 text-sm text-muted-foreground">调整来源或状态筛选后再查看。</p>
                </div>
            ) : (
                <div className="divide-y divide-border border-y border-border">
                    {tasks.map(task => {
                        const detailSpeed = typeof task.detail.speed === 'string' ? task.detail.speed : null;
                        const detailEta = typeof task.detail.eta === 'string' ? task.detail.eta : null;
                        return (
                            <article key={`${task.sourceType}:${task.id}`} className="py-5">
                                <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-xs font-medium text-muted-foreground">{SOURCE_LABELS[task.sourceType] || task.sourceType}</span>
                                            <span className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium', statusTone(task.status))}>
                                                <StatusIcon status={task.status} />
                                                {STATUS_LABELS[task.status] || task.status}
                                            </span>
                                            <span className="text-xs text-muted-foreground">{STAGE_LABELS[task.stage] || task.stage}</span>
                                        </div>
                                        <h3 className="mt-2 break-words text-base font-semibold">{task.title}</h3>
                                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                            <span title={taskTarget(task)}>目标：{taskTarget(task)}</span>
                                            <span>更新：{new Date(task.updatedAt).toLocaleString(locale, { hour12: false })}</span>
                                            {(detailSpeed || detailEta) && <span>{detailSpeed ? `速度 ${detailSpeed}` : ''}{detailSpeed && detailEta ? ' · ' : ''}{detailEta ? `ETA ${detailEta}` : ''}</span>}
                                        </div>
                                        {(task.progress > 0 || ['running', 'paused', 'failed'].includes(task.status)) && (
                                            <div className="mt-3 flex items-center gap-3">
                                                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                                                    <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} />
                                                </div>
                                                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(task.progress)}%</span>
                                            </div>
                                        )}
                                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                            {task.counts.total > 0 && <span>条目 {task.counts.completed}/{task.counts.total}{task.counts.failed > 0 ? `，失败 ${task.counts.failed}` : ''}</span>}
                                            {task.bytes.total > 0 && <span>数据 {formatBytes(task.bytes.transferred)} / {formatBytes(task.bytes.total)}</span>}
                                            <span className="inline-flex items-center gap-1 font-mono" title={task.id}>
                                                ID {task.id.length > 18 ? `${task.id.slice(0, 18)}...` : task.id}
                                                <button type="button" title="复制任务 ID" aria-label="复制任务 ID" onClick={() => void navigator.clipboard.writeText(task.id)}><Copy className="h-3.5 w-3.5" /></button>
                                            </span>
                                        </div>
                                        {task.error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 break-words">{task.error}</p>}
                                    </div>
                                    <div className="flex shrink-0 flex-wrap gap-2 xl:w-40 xl:justify-end">
                                        {task.retryable && (
                                            <Button size="sm" variant="outline" className="gap-2" onClick={() => requestAction(task, 'retry')}>
                                                {task.sourceType === 'web_upload' ? <UploadCloud className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                                                {task.sourceType === 'web_upload' ? '选择文件续传' : '重试'}
                                            </Button>
                                        )}
                                        {task.cancellable && (
                                            <Button size="sm" variant="outline" className="gap-2 text-red-700" onClick={() => requestAction(task, 'cancel')}>
                                                <Ban className="h-4 w-4" />
                                                取消
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </article>
                        );
                    })}
                </div>
            )}

            {pendingAction && (
                <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="task-confirm-title">
                    <div className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl">
                        <div className="flex items-start gap-3">
                            {pendingAction.action === 'cancel' ? <Ban className="mt-0.5 h-5 w-5 text-red-600" /> : <RotateCcw className="mt-0.5 h-5 w-5" />}
                            <div className="min-w-0">
                                <h3 id="task-confirm-title" className="font-semibold">{pendingAction.action === 'cancel' ? '确认取消任务' : '确认重试任务'}</h3>
                                <p className="mt-2 text-sm text-muted-foreground break-words">{pendingAction.task.title}</p>
                                <p className="mt-1 text-xs text-muted-foreground">目标保持为：{taskTarget(pendingAction.task)}</p>
                            </div>
                        </div>
                        <div className="mt-5 flex justify-end gap-2">
                            <Button variant="outline" disabled={acting} onClick={() => setPendingAction(null)}>返回</Button>
                            <Button variant={pendingAction.action === 'cancel' ? 'destructive' : 'default'} disabled={acting} onClick={() => void confirmAction()}>
                                {acting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                {pendingAction.action === 'cancel' ? '确认取消' : '确认重试'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
