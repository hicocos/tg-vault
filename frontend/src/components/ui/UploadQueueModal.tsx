import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { FileText, CheckCircle2, AlertCircle, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "./Button";
import { cn } from "../../lib/utils";
import { getUploadQueueOutcome } from "./uploadQueueOutcome";
import type { ChunkUploadSession } from "../../services/api";
import type { UploadTelemetry } from "../../services/uploadTelemetry";
import { IndeterminateSpinner } from "./IndeterminateSpinner";
import { formatBytes } from "../../services/formatBytes";
import { useTranslation } from "react-i18next";

export interface QueueItem {
    id: string;
    file: File;
    status: 'pending' | 'uploading' | 'processing' | 'completed' | 'error' | 'cancelled';
    progress: number;
    error?: string;
    resumeSessionId?: string;
    targetLabel?: string;
    loadedBytes?: number;
    totalBytes?: number;
    bytesPerSecond?: number;
    etaSeconds?: number | null;
    telemetry?: UploadTelemetry;
}

interface UploadQueueModalProps {
    isOpen: boolean;
    onClose: () => void;
    items: QueueItem[];
    recoveredSessions?: ChunkUploadSession[];
    resumingSessionIds?: string[];
    onCancel: (id: string) => void;
    onRetry: (id: string) => void;
    isPaused?: boolean;
    onTogglePause?: () => void;
    onResumeSession?: (session: ChunkUploadSession, file: File) => void;
    onCancelSession?: (session: ChunkUploadSession) => void;
}

function formatDuration(seconds: number | null | undefined, t: (key: string, options?: Record<string, unknown>) => string): string | null {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
    if (seconds <= 0) return t('files.ui.uploadQueue.almostDone');
    if (seconds < 60) return t('files.ui.uploadQueue.seconds', { count: Math.ceil(seconds) });
    if (seconds < 3600) return t('files.ui.uploadQueue.minutes', { count: Math.ceil(seconds / 60) });
    return t('files.ui.uploadQueue.hoursMinutes', { hours: Math.floor(seconds / 3600), minutes: Math.ceil((seconds % 3600) / 60) });
}

export const UploadQueueModal = ({
    isOpen,
    onClose,
    items,
    recoveredSessions = [],
    resumingSessionIds = [],
    onCancel,
    onRetry,
    isPaused = false,
    onTogglePause,
    onResumeSession,
    onCancelSession,
}: UploadQueueModalProps) => {
    const { t } = useTranslation();
    const outcome = getUploadQueueOutcome(items);
    const hasActiveItems = items.some(item => ['pending', 'uploading', 'processing'].includes(item.status));

    // 计算总体完成进度
    const completedCount = items.filter(i => i.status === 'completed' || i.status === 'error' || i.status === 'cancelled').length;
    const totalCount = items.length;

    if (!isOpen) return null;

    const panelContent = (
        <div className="fixed inset-x-3 bottom-3 z-50 pointer-events-none sm:inset-x-auto sm:right-5 sm:w-[30rem]">
            <motion.div
                initial={{ opacity: 0, x: 30, y: 20 }}
                animate={{ opacity: 1, x: 0, y: 0 }}
                exit={{ opacity: 0, x: 30, y: 20 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="pointer-events-auto relative bg-background border border-border rounded-xl shadow-2xl w-full max-h-[min(75vh,42rem)] flex flex-col overflow-hidden"
                role="region"
                aria-label={t('files.ui.uploadQueue.label')}
            >
                {/* 头部 */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/30">
                    <div className="flex flex-col gap-1">
                        <h3 className="font-semibold text-lg flex items-center gap-2">
                            {items.length === 0 && recoveredSessions.length > 0
                                ? <RotateCcw className="w-5 h-5 text-primary" />
                                : outcome.kind === 'success'
                                ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                                : outcome.kind === 'partial'
                                    ? <AlertCircle className="w-5 h-5 text-amber-500" />
                                    : outcome.kind === 'failed'
                                        ? <AlertCircle className="w-5 h-5 text-red-500" />
                                        : outcome.kind === 'cancelled'
                                            ? <AlertCircle className="w-5 h-5 text-muted-foreground" />
                                : <IndeterminateSpinner label={t('files.ui.uploadQueue.processing')} size="md" />
                            }
                            {items.length === 0 && recoveredSessions.length > 0 ? t('files.ui.uploadQueue.recoverable') : t(`files.ui.uploadQueue.${outcome.titleKey}`)}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                            {totalCount > 0 ? t('files.ui.uploadQueue.currentFiles', { completed: completedCount, total: totalCount }) : t('files.ui.uploadQueue.noBrowserUploads')}
                            {recoveredSessions.length > 0 ? t('files.ui.uploadQueue.serverSessions', { count: recoveredSessions.length }) : ''}
                        </p>
                    </div>
                    <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={onClose} aria-label={t('files.ui.uploadQueue.minimize')} title={t('files.ui.uploadQueue.minimize')}>
                        <X className="h-4 w-4" />
                    </Button>
                </div>

                {/* 列表内容 */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <AnimatePresence>
                        {recoveredSessions.map(session => {
                            const isResuming = resumingSessionIds.includes(session.uploadId);
                            const target = `${session.targetAccountName || session.targetProvider || t('files.ui.uploadQueue.unknownStorage')} / ${session.folder || t('files.root')}`;
                            return (
                                <motion.div
                                    key={session.uploadId}
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    className="flex flex-col gap-3 p-3 rounded-lg border border-amber-300/60 bg-amber-50/50"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="h-8 w-8 shrink-0 rounded bg-amber-100 flex items-center justify-center">
                                            {isResuming ? <IndeterminateSpinner label={t('files.ui.uploadQueue.resuming')} size="sm" /> : <RotateCcw className="w-4 h-4 text-amber-700" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium truncate" title={session.filename}>{session.filename}</p>
                                            <p className="text-xs text-muted-foreground mt-1 truncate" title={target}>{t('files.ui.uploadQueue.target', { target })}</p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                {t('files.ui.uploadQueue.received', { received: formatBytes(session.receivedBytes), total: formatBytes(session.totalSize) })}
                                                {session.status === 'failed' ? t('files.ui.uploadQueue.previousFailed') : session.status === 'completing' ? t('files.ui.uploadQueue.serverProcessingSuffix') : t('files.ui.uploadQueue.chooseOriginal')}
                                            </p>
                                            {session.error && <p className="text-xs text-red-600 mt-1 break-words">{session.error}</p>}
                                        </div>
                                    </div>
                                    <div className="h-1 w-full bg-amber-100 rounded-full overflow-hidden">
                                        <div className="h-full bg-amber-600 rounded-full" style={{ width: `${Math.max(0, Math.min(100, session.progress))}%` }} />
                                    </div>
                                    {session.status !== 'completing' && (
                                        <div className="flex flex-wrap justify-end gap-2">
                                            <label className={cn(
                                                "inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent",
                                                isResuming && "pointer-events-none opacity-50",
                                            )}>
                                                <RotateCcw className="h-4 w-4" />
                                                {session.status === 'failed' ? t('files.ui.uploadQueue.chooseRetry') : t('files.ui.uploadQueue.chooseContinue')}
                                                <input
                                                    className="sr-only"
                                                    type="file"
                                                    disabled={isResuming}
                                                    onChange={event => {
                                                        const file = event.target.files?.[0];
                                                        if (file) onResumeSession?.(session, file);
                                                        event.currentTarget.value = '';
                                                    }}
                                                />
                                            </label>
                                            <Button variant="outline" size="sm" disabled={isResuming} onClick={() => onCancelSession?.(session)}>
                                                <Trash2 className="h-4 w-4 mr-2" />
                                                {t('files.ui.uploadQueue.cancelSession')}
                                            </Button>
                                        </div>
                                    )}
                                </motion.div>
                            );
                        })}
                        {items.map((item) => (
                            <motion.div
                                key={item.id}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-card/50 hover:bg-card transition-colors"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="h-8 w-8 shrink-0 rounded bg-muted flex items-center justify-center">
                                        <FileText className="w-4 h-4 text-muted-foreground" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium truncate" title={item.file.name}>{item.file.name}</p>
                                        {item.targetLabel && <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={item.targetLabel}>{t('files.ui.uploadQueue.target', { target: item.targetLabel })}</p>}
                                        <div className="flex justify-between items-center mt-1">
                                            <span className={cn(
                                                "text-xs shrink-0 font-medium",
                                                item.status === 'completed' && "text-green-500",
                                                (item.status === 'error' || item.status === 'cancelled') && "text-red-500",
                                                (item.status === 'uploading' || item.status === 'processing') && "text-primary"
                                            )}>
                                                {item.status === 'completed' && t('files.ui.uploadQueue.completed')}
                                                {item.status === 'error' && t('files.ui.uploadQueue.failed')}
                                                {item.status === 'uploading' && `${item.progress}%`}
                                                {item.status === 'processing' && t('files.ui.uploadQueue.processingStatus')}
                                                {item.status === 'cancelled' && t('files.ui.uploadQueue.cancelled')}
                                                {item.status === 'pending' && t('files.ui.uploadQueue.pending')}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="shrink-0">
                                        {item.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-green-500" />}
                                        {item.status === 'error' && <AlertCircle className="w-5 h-5 text-red-500" />}
                                        {item.status === 'cancelled' && <AlertCircle className="w-5 h-5 text-muted-foreground" />}
                                        {(item.status === 'uploading' || item.status === 'processing') && <IndeterminateSpinner label={item.status === 'processing' ? t('files.ui.uploadQueue.processingUpload') : t('files.ui.uploadQueue.uploadingFile')} size="md" />}
                                    </div>
                                    {(item.status === 'pending' || item.status === 'uploading' || item.status === 'processing') && (
                                        <Button variant="outline" size="sm" onClick={() => onCancel(item.id)}>{t('common.actions.cancel')}</Button>
                                    )}
                                    {(item.status === 'error' || item.status === 'cancelled') && !item.resumeSessionId && (
                                        <Button variant="outline" size="sm" onClick={() => onRetry(item.id)}>{t('common.actions.retry')}</Button>
                                    )}
                                </div>
                                {item.error && (
                                    <p role="alert" className="break-words rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
                                        {item.error}
                                    </p>
                                )}

                                {/* 进度条 */}
                                {(item.status === 'uploading' || item.status === 'processing' || item.progress > 0) && (
                                    <>
                                        <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
                                            <motion.div
                                                className={cn(
                                                    "h-full rounded-full",
                                                    item.status === 'error' ? "bg-red-500" : "bg-primary"
                                                )}
                                                initial={{ width: 0 }}
                                                animate={{ width: `${item.progress}%` }}
                                                transition={{ duration: 0.1 }}
                                            />
                                        </div>
                                        {(item.loadedBytes !== undefined || item.bytesPerSecond) && (
                                            <div className="flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
                                                <span>{formatBytes(item.loadedBytes || 0)} / {formatBytes(item.totalBytes || item.file.size)}</span>
                                                <span>
                                                    {item.bytesPerSecond ? `${formatBytes(item.bytesPerSecond)}/s` : t('files.ui.uploadQueue.estimatingSpeed')}
                                                    {formatDuration(item.etaSeconds, t) ? t('files.ui.uploadQueue.remaining', { duration: formatDuration(item.etaSeconds, t) }) : ''}
                                                </span>
                                            </div>
                                        )}
                                    </>
                                )}
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </div>

                {/* 活跃上传期间保持任务可见；暂停只阻止新项目开始，正在传输的当前项目会完成。 */}
                <div className="p-4 border-t border-border bg-muted/30 flex flex-wrap justify-end gap-2">
                    {hasActiveItems && onTogglePause && (
                        <Button variant="outline" onClick={onTogglePause}>
                            {isPaused ? t('files.ui.uploadQueue.resumeQueue') : t('files.ui.uploadQueue.pauseQueue')}
                        </Button>
                    )}
                    {!hasActiveItems && (
                        <Button onClick={onClose} className="w-full sm:w-auto min-w-[100px]">
                            {t('common.actions.close')}
                        </Button>
                    )}
                </div>
            </motion.div>
        </div>
    );

    return createPortal(panelContent, document.body);
};
