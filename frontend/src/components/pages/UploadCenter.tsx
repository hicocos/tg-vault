import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, FolderOpen, Gauge, RotateCcw, ShieldCheck, Upload, XCircle } from "../ui/icons";
import type { QueueItem } from "../ui/UploadQueueModal";
import { UploadZone } from "../ui/UploadZone";
import type { UploadCapabilities } from "../../services/api";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import { formatBytes } from "../../services/formatBytes";
import "./operations.css";
import "./upload-audit.css";

interface UploadCenterProps {
    onUpload: (files: File[], folder?: string) => void;
    uploading: boolean;
    uploadProgress: number;
    capabilities: UploadCapabilities | null;
    storageTarget: { provider: string; account: string } | null;
    ready: boolean;
    folders: string[];
    queue: QueueItem[];
    recoveredUploadCount: number;
    onOpenQueue: () => void;
}

export const UploadCenter = ({ onUpload, uploading, uploadProgress, capabilities, storageTarget, ready, folders, queue, recoveredUploadCount, onOpenQueue }: UploadCenterProps) => {
    const { t } = useTranslation();

    const [destination, setDestination] = useState("");
    const activeCount = queue.filter(item => ["pending", "uploading", "processing"].includes(item.status)).length;
    const completedCount = queue.filter(item => item.status === "completed").length;
    const failedCount = queue.filter(item => ["error", "cancelled"].includes(item.status)).length;
    const recentItems = useMemo(() => queue.slice(-4).reverse(), [queue]);
    const threshold = capabilities ? Math.round(capabilities.simpleUploadThresholdBytes / 1024 / 1024) : null;
    const statusLabel: Record<QueueItem["status"], string> = {
        pending: t('management.upload.status.pending'), uploading: t('management.upload.status.uploading'), processing: t('management.upload.status.processing'),
        completed: t('management.upload.status.completed'), error: t('management.upload.status.error'), cancelled: t('management.upload.status.cancelled'),
    };
    const storageLabel = storageTarget ? `${storageTarget.provider} / ${storageTarget.account}` : t('management.upload.storageLoading');

    return (
        <section className="tv-operations op-upload-page" aria-labelledby="upload-center-title">
            <header className="tv-page-header op-page-heading">
                <div>
                    <h1 id="upload-center-title">{t('management.upload.title')}</h1>
                    <p>{t('management.upload.subtitle')}</p>
                </div>
                {(queue.length > 0 || recoveredUploadCount > 0) && (
                    <Button variant="outline" className="op-action" onClick={onOpenQueue}>
                        <Gauge className="h-4 w-4" />{t('management.upload.manageQueue')}
                    </Button>
                )}
            </header>

            <div className="op-upload-layout">
                <section className="tv-panel op-panel op-upload-workbench">
                    <section className="op-upload-target-first" aria-labelledby="upload-settings-title">
                        <h2 id="upload-settings-title">{t('uiAudit.uploadSettings')}</h2>
                        <dl className="op-upload-storage"><div><dt>{t('management.upload.currentStorage')}</dt><dd data-upload-storage>{storageLabel}</dd></div></dl>
                        <label className="op-field" htmlFor="upload-destination">{t('management.upload.destination')}
                            <select id="upload-destination" data-testid="upload-destination" value={destination} onChange={event => setDestination(event.target.value)} disabled={!ready} className="tv-field op-input">
                                <option value="">{t('management.upload.root')}</option>
                                {folders.map(folder => <option key={folder} value={folder}>{folder}</option>)}
                            </select>
                        </label>
                        <p className="op-help op-upload-lock-note" id="upload-target-lock">{t('management.upload.reliable.lockedDetail')}</p>
                    </section>
                    <UploadZone
                        onDrop={files => onUpload(files, destination || undefined)}
                        uploading={uploading}
                        uploadProgress={uploadProgress}
                        capabilities={capabilities}
                        disabled={!ready}
                    />

                    {queue.length > 0 && <section className="op-upload-batch" aria-labelledby="upload-batch-title">
                        <div className="op-section-heading">
                            <div>
                                <h2 id="upload-batch-title">{t('management.upload.currentBatch')}</h2>
                                {(completedCount > 0 || failedCount > 0) && <p>{t('management.upload.batchSummary', { completed: completedCount, failed: failedCount })}</p>}
                            </div>
                            {queue.length > 0 && <Button variant="ghost" size="sm" onClick={onOpenQueue}>{t('management.upload.viewAll')}</Button>}
                        </div>
                        {activeCount > 0 && <div data-testid="upload-queue-summary" className="op-queue-summary" role="status" aria-label={t('management.upload.queue')}>
                            <span className="op-status-dot" aria-hidden="true" />
                            <span>{t('management.upload.activeCount', { count: activeCount })}</span>
                        </div>}
                        {recentItems.length > 0 && (
                            <ul className="op-upload-list">
                                {recentItems.map(item => (
                                    <li key={item.id}>
                                        <button type="button" onClick={onOpenQueue} className="op-upload-item">
                                            <span className={cn('op-file-symbol', item.status === 'completed' && 'op-tone-success', ['error', 'cancelled'].includes(item.status) && 'op-tone-danger')}>
                                                {item.status === 'completed' ? <CheckCircle2 className="h-4 w-4" /> : ['error', 'cancelled'].includes(item.status) ? <XCircle className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
                                            </span>
                                            <span className="op-upload-item-main">
                                                <span className="op-item-title" title={item.file.name}>{item.file.name}</span>
                                                <span className="op-item-meta"><span>{statusLabel[item.status]}</span><span>{formatBytes(item.file.size)}</span></span>
                                                {item.targetLabel && <span className="op-item-target" title={item.targetLabel}>{t('files.ui.uploadQueue.target', { target: item.targetLabel })}</span>}
                                                <span className={cn('op-progress', ['error', 'cancelled'].includes(item.status) && 'op-progress--danger')} role="progressbar" aria-label={item.file.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, item.progress))}>
                                                    <span style={{ width: `${Math.max(0, Math.min(100, item.progress))}%` }} />
                                                </span>
                                                {item.error && <span className="op-inline-error">{item.error}</span>}
                                            </span>
                                            <span className="op-upload-percent">{item.progress}%</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>}
                    {recoveredUploadCount > 0 && <div className="op-upload-recovery">
                        <Button variant="outline" className="op-action" onClick={onOpenQueue}><RotateCcw className="h-4 w-4" />{t('management.upload.recoverableCount', { count: recoveredUploadCount })}</Button>
                    </div>}
                </section>

                <aside className="op-upload-settings" aria-labelledby="upload-capabilities-title">
                    <div className="op-section-heading"><h2 id="upload-capabilities-title"><FolderOpen className="h-4 w-4" />{t('uiAudit.uploadCapabilities')}</h2></div>
                    <dl className="op-target-details">

                        <div><dt><ShieldCheck className="h-4 w-4" />{t('management.upload.transferPolicy')}</dt><dd>{threshold ? t('management.upload.chunkThreshold', { size: threshold }) : t('management.upload.limitsLoading')}</dd></div>
                    </dl>
                    <details className="op-disclosure">
                        <summary>{t('management.upload.reliable.title')}</summary>
                        <div className="op-policy-list">
                            <div><RotateCcw className="h-4 w-4" /><div><h3>{t('management.upload.reliable.resumable')}</h3><p>{t('management.upload.reliable.resumableDetail')}</p></div></div>
                            <div><Gauge className="h-4 w-4" /><div><h3>{t('management.upload.reliable.concurrency')}</h3><p>{t('management.upload.reliable.concurrencyDetail')}</p></div></div>

                        </div>
                    </details>
                </aside>
            </div>
        </section>
    );
};
