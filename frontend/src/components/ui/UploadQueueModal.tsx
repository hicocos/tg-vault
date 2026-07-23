import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { FileText, CheckCircle2, AlertCircle, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "./Button";
import { cn } from "../../lib/utils";
import { getUploadQueueOutcome } from "./uploadQueueOutcome";
import type { ChunkUploadSession } from "../../services/api";
import type { UploadTelemetry } from "../../services/uploadTelemetry";
import { IndeterminateSpinner } from "./IndeterminateSpinner";

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

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** unit)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds: number | null | undefined): string | null {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
    if (seconds <= 0) return '即将完成';
    if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
    if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
    return `${Math.floor(seconds / 3600)} 小时 ${Math.ceil((seconds % 3600) / 60)} 分钟`;
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
                aria-label="上传队列"
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
                                : <IndeterminateSpinner label="正在处理上传队列" size="md" />
                            }
                            {items.length === 0 && recoveredSessions.length > 0 ? '有上传等待恢复' : outcome.title}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                            {totalCount > 0 ? `${completedCount} / ${totalCount} 个当前文件` : '当前没有浏览器上传'}
                            {recoveredSessions.length > 0 ? `，${recoveredSessions.length} 个服务端会话` : ''}
                        </p>
                    </div>
                    <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={onClose} aria-label="最小化上传队列" title="最小化上传队列">
                        <X className="h-4 w-4" />
                    </Button>
                </div>

                {/* 列表内容 */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <AnimatePresence>
                        {recoveredSessions.map(session => {
                            const isResuming = resumingSessionIds.includes(session.uploadId);
                            const target = `${session.targetAccountName || session.targetProvider || '未知存储'} / ${session.folder || '根目录'}`;
                            return (
                                <motion.div
                                    key={session.uploadId}
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    className="flex flex-col gap-3 p-3 rounded-lg border border-amber-300/60 bg-amber-50/50"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="h-8 w-8 shrink-0 rounded bg-amber-100 flex items-center justify-center">
                                            {isResuming ? <IndeterminateSpinner label="正在恢复上传" size="sm" /> : <RotateCcw className="w-4 h-4 text-amber-700" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium truncate" title={session.filename}>{session.filename}</p>
                                            <p className="text-xs text-muted-foreground mt-1 truncate" title={target}>目标：{target}</p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                已接收 {formatBytes(session.receivedBytes)} / {formatBytes(session.totalSize)}
                                                {session.status === 'failed' ? ' · 上次上传失败' : session.status === 'completing' ? ' · 服务器处理中' : ' · 等待重新选择原文件'}
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
                                                {session.status === 'failed' ? '选择原文件并重试' : '选择原文件并继续'}
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
                                                取消会话
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
                                        {item.targetLabel && <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={item.targetLabel}>目标：{item.targetLabel}</p>}
                                        <div className="flex justify-between items-center mt-1">
                                            <span className={cn(
                                                "text-xs shrink-0 font-medium",
                                                item.status === 'completed' && "text-green-500",
                                                (item.status === 'error' || item.status === 'cancelled') && "text-red-500",
                                                (item.status === 'uploading' || item.status === 'processing') && "text-primary"
                                            )}>
                                                {item.status === 'completed' && "完成"}
                                                {item.status === 'error' && "失败"}
                                                {item.status === 'uploading' && `${item.progress}%`}
                                                {item.status === 'processing' && "服务器处理中"}
                                                {item.status === 'cancelled' && "已取消"}
                                                {item.status === 'pending' && "等待中"}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="shrink-0">
                                        {item.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-green-500" />}
                                        {item.status === 'error' && <AlertCircle className="w-5 h-5 text-red-500" />}
                                        {item.status === 'cancelled' && <AlertCircle className="w-5 h-5 text-muted-foreground" />}
                                        {(item.status === 'uploading' || item.status === 'processing') && <IndeterminateSpinner label={item.status === 'processing' ? "正在处理上传" : "正在上传文件"} size="md" />}
                                    </div>
                                    {(item.status === 'pending' || item.status === 'uploading' || item.status === 'processing') && (
                                        <Button variant="outline" size="sm" onClick={() => onCancel(item.id)}>取消</Button>
                                    )}
                                    {(item.status === 'error' || item.status === 'cancelled') && !item.resumeSessionId && (
                                        <Button variant="outline" size="sm" onClick={() => onRetry(item.id)}>重试</Button>
                                    )}
                                </div>

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
                                                    {item.bytesPerSecond ? `${formatBytes(item.bytesPerSecond)}/s` : '正在估算速度'}
                                                    {formatDuration(item.etaSeconds) ? ` · 剩余 ${formatDuration(item.etaSeconds)}` : ''}
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
                            {isPaused ? '继续队列' : '暂停队列'}
                        </Button>
                    )}
                    {!hasActiveItems && (
                        <Button onClick={onClose} className="w-full sm:w-auto min-w-[100px]">
                            关闭
                        </Button>
                    )}
                </div>
            </motion.div>
        </div>
    );

    return createPortal(panelContent, document.body);
};
