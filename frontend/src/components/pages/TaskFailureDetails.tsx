import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fileApi, type TaskFailurePage, type UnifiedTask } from '../../services/api';
import { isUnauthorizedError } from '../../services/apiActionError';
import { errorMessage } from '../../services/unknownError';
import { localizeTaskReason } from '../../i18n/taskReason';
import { Button } from '../ui/Button';
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';

export function TaskFailureDetails({ task, onUnauthorized }: { task: UnifiedTask; onUnauthorized?: () => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [offset, setOffset] = useState(0);
    const [revision, setRevision] = useState(0);
    const [page, setPage] = useState<TaskFailurePage | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const supported = task.sourceType === 'telegram_channel';

    useEffect(() => {
        if (!open || !supported) return;
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        setPage(null);
        void fileApi.getTaskFailures(task.sourceType, task.id, offset, controller.signal)
            .then(result => { if (!controller.signal.aborted) setPage(result); })
            .catch(cause => {
                if (controller.signal.aborted) return;
                if (isUnauthorizedError(cause)) { onUnauthorized?.(); return; }
                setError(errorMessage(cause, t('tasks.failures.loadFailed')));
            })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [open, supported, task.sourceType, task.id, task.counts.failed, offset, revision, onUnauthorized, t]);

    return <details className="op-task-failures" open={open} onToggle={event => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (!next) setOffset(0);
    }}>
        <summary>{t(task.counts.failed > 0 ? 'tasks.failures.title' : 'tasks.failures.errorTitle', { count: task.counts.failed })}</summary>
        {open && <div className="op-task-failure-body" role="region" aria-label={t('tasks.failures.errorTitle')} aria-busy={loading} tabIndex={0}>
            {(!supported || (!loading && !page?.items.length)) && task.error && <pre className="op-task-failure-reason" tabIndex={0}>{localizeTaskReason(task.error, t)}</pre>}
            {loading && <IndeterminateSpinner label={t('tasks.failures.loading')} size="sm" />}
            {error && <p role="alert" className="op-task-failure-reason">{error}</p>}
            {!loading && !error && (!supported || page?.items.length === 0) && <p className="op-cell-meta">{t('tasks.failures.empty')}</p>}
            {!loading && page && page.items.length > 0 && <ul className="op-task-failure-list">
                {page.items.map(item => <li key={item.id}>
                    <strong className="op-task-failure-name" title={item.fileName || undefined}>{item.fileName || t('tasks.failures.unknownFile')}</strong>
                    <pre className="op-task-failure-reason" tabIndex={0}>{item.error || t('tasks.failures.unknownReason')}</pre>
                    {item.messageUrl ? <a className="op-task-failure-link" href={item.messageUrl} target="_blank" rel="noopener noreferrer">{t('tasks.failures.openMessage', { id: item.messageId })}</a>
                        : <span className="op-cell-meta">{t('tasks.failures.noLink', { id: item.messageId ?? '—' })}</span>}
                </li>)}
            </ul>}
            {supported && <div className="op-task-failure-controls">
                {page && page.total > 0 && <span className="op-cell-meta">{t('tasks.failures.range', { start: page.items.length ? page.offset + 1 : 0, end: page.items.length ? page.offset + page.items.length : 0, total: page.total })}</span>}
                {offset > 0 && <Button size="sm" variant="outline" disabled={loading} onClick={() => setOffset(Math.max(0, offset - 10))}>{t('tasks.failures.previous')}</Button>}
                {page && page.offset + page.items.length < page.total && <Button size="sm" variant="outline" disabled={loading} onClick={() => setOffset(page.offset + page.limit)}>{t('tasks.failures.next')}</Button>}
                <Button size="sm" variant="ghost" disabled={loading} onClick={() => { setOffset(0); setRevision(value => value + 1); }}>{t(error ? 'tasks.failures.retry' : 'tasks.actions.refresh')}</Button>
            </div>}
        </div>}
    </details>;
}
