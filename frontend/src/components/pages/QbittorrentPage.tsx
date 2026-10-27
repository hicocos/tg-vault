import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Ban, Check, ChevronDown, Clock3, Download, FileStack, Folder, Pause, Play, Plus, RefreshCw, RotateCcw, Search, Trash2, UploadCloud, X } from '../ui/icons';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';
import { fileApi } from '../../services/api';
import type { StorageAccount, TaskDismissalPreview } from '../../services/api';
import { qbittorrentClient } from '../../services/clients/qbittorrentClient';
import type { QbConfig, QbFile, QbSettings, QbTask } from '../../services/clients/qbittorrentClient';
import { createSerialPoller } from '../../services/serialPoller';
import { errorMessage } from '../../services/unknownError';
import { parseMagnetLinks } from '../../services/qbittorrentBatch';
import { formatBytes } from '../../services/formatBytes';
import { formatDateTime } from '../../i18n/format';
import { SettingsField } from './SettingsPresentation';
import { QbittorrentTargetFields } from './QbittorrentTargetFields';
import './qbittorrent.css';

const canSelect = (task: QbTask) => ['metadata', 'downloading', 'paused'].includes(task.stage) && !['completed', 'cancelled'].includes(task.status);

function Progress({ label, value, bytes, total, speed, complete }: { label: string; value: number; bytes: number; total: number; speed?: number; complete: boolean }) {
    const { t } = useTranslation();
    const progress = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
    return <div className={`qb-progress${complete ? ' is-complete' : ''}`}>
        <div className="qb-progress-label"><span>{complete && <Check size={14} aria-hidden="true" />}{label}</span><strong>{progress > 0 && progress < 1 ? progress.toFixed(1) : Math.round(progress)}%</strong></div>
        <progress aria-label={label} max={100} value={progress} />
        <div className="qb-progress-facts"><span>{formatBytes(bytes)} / {total > 0 ? formatBytes(total) : t('qbittorrent.sizePending')}</span>{speed !== undefined && speed > 0 && <strong>{t('qbittorrent.speed', { speed: formatBytes(speed) })}</strong>}</div>
    </div>;
}

export function QbittorrentPage({ config }: { config: Extract<QbConfig, { enabled: true }> }) {
    const { t, i18n } = useTranslation();
    const [accounts, setAccounts] = useState<StorageAccount[]>([]);
    const [target, setTarget] = useState<Pick<QbSettings, 'targetAccountId' | 'targetFolder' | 'preserveLocalFiles'>>({ targetAccountId: config.targetAccountId, targetFolder: config.targetFolder, preserveLocalFiles: config.preserveLocalFiles });
    const [source, setSource] = useState<'magnet' | 'torrent'>('magnet');
    const [magnet, setMagnet] = useState('');
    const [torrents, setTorrents] = useState<File[]>([]);
    const [createOpen, setCreateOpen] = useState(false);
    const [createResults, setCreateResults] = useState<Array<{ label: string; error: string | null }>>([]);
    const [createProgress, setCreateProgress] = useState<{ completed: number; total: number } | null>(null);
    const [createdNotice, setCreatedNotice] = useState(0);
    const magnetLinks = parseMagnetLinks(magnet);
    const inputCount = source === 'magnet' ? magnetLinks.length : torrents.length;
    const fileInput = useRef<HTMLInputElement>(null);
    const targetDetails = useRef<HTMLDetailsElement>(null);
    const [tasks, setTasks] = useState<QbTask[]>([]);
    const [taskScope, setTaskScope] = useState<'active' | 'history' | 'attention'>('active');
    const [query, setQuery] = useState('');
    const [dismissal, setDismissal] = useState<TaskDismissalPreview | null>(null);
    const activeTasks = tasks.filter(task => task.status !== 'completed' && task.status !== 'cancelled');
    const historyTasks = tasks.filter(task => task.status === 'completed' || task.status === 'cancelled');
    const attentionTasks = activeTasks.filter(task => task.status === 'failed' || task.status === 'paused');
    const scopedTasks = taskScope === 'history' ? historyTasks : taskScope === 'attention' ? attentionTasks : activeTasks;
    const search = query.trim().toLocaleLowerCase();
    const visibleTasks = search ? scopedTasks.filter(task => task.title.toLocaleLowerCase().includes(search) || task.targetFolder.toLocaleLowerCase().includes(search)) : scopedTasks;
    const downloadingTasks = activeTasks.filter(task => task.status === 'running' && ['submitting', 'metadata', 'downloading'].includes(task.stage));
    const transferringTasks = activeTasks.filter(task => task.status === 'running' && ['uploading', 'cleaning'].includes(task.stage));
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [creating, setCreating] = useState(false);
    const [acting, setActing] = useState(false);
    const [cancelling, setCancelling] = useState<QbTask | null>(null);
    const [fileTaskId, setFileTaskId] = useState<string | null>(null);
    const [files, setFiles] = useState<QbFile[]>([]);
    const [selected, setSelected] = useState<number[]>([]);
    const [filesLoading, setFilesLoading] = useState(false);
    const [fileError, setFileError] = useState<string | null>(null);
    const filesGeneration = useRef(0);
    const generation = useRef(0);
    const fileTask = tasks.find(task => task.id === fileTaskId);
    const selectedFiles = files.filter(file => selected.includes(file.index));
    const load = useCallback(async () => {
        const request = ++generation.current;
        try {
            const result = await qbittorrentClient.getTasks();
            if (request === generation.current) { setTasks(result.tasks); setLoadError(null); }
        } catch (cause) { if (request === generation.current) setLoadError(errorMessage(cause)); }
        finally { if (request === generation.current) setLoading(false); }
    }, []);
    useEffect(() => {
        let active = true;
        void fileApi.getStorageConfig().then(result => { if (active) setAccounts(result.accounts); }).catch(cause => { if (active) setError(errorMessage(cause)); });
        return () => { active = false; };
    }, []);
    useEffect(() => {
        const poller = createSerialPoller({ run: load, schedule: (callback, delay) => window.setTimeout(callback, delay), cancel: handle => window.clearTimeout(handle as number), delayMs: 3000, nextDelayMs: () => document.visibilityState === 'visible' ? 3000 : 30000 });
        poller.start();
        return () => { poller.stop(); generation.current += 1; filesGeneration.current += 1; };
    }, [load]);
    const refresh = async () => {
        setRefreshing(true);
        try { await load(); } finally { setRefreshing(false); }
    };
    const openCreate = () => { setCreatedNotice(0); setCreateOpen(true); };
    const create = async () => {
        if (creating || !inputCount) return;
        const inputs = source === 'magnet'
            ? magnetLinks.map(link => ({ label: link, magnet: link, torrent: null }))
            : torrents.map(file => ({ label: file.name, magnet: null, torrent: file }));
        const destination = { ...target };
        const failedMagnets: string[] = [];
        const failedTorrents: File[] = [];
        let added = 0;
        setCreating(true); setCreateResults([]); setCreateProgress({ completed: 0, total: inputs.length });
        try {
            for (const [index, input] of inputs.entries()) {
                try {
                    const body = new FormData();
                    if (input.magnet) body.set('magnet', input.magnet);
                    else if (input.torrent) body.set('torrent', input.torrent);
                    body.set('targetAccountId', destination.targetAccountId);
                    body.set('targetFolder', destination.targetFolder);
                    body.set('preserveLocalFiles', String(destination.preserveLocalFiles));
                    await qbittorrentClient.createTask(body);
                    added += 1;
                    setCreateResults(previous => [...previous, { label: input.label, error: null }]);
                } catch (cause) {
                    if (input.magnet) failedMagnets.push(input.magnet);
                    else if (input.torrent) failedTorrents.push(input.torrent);
                    setCreateResults(previous => [...previous, { label: input.label, error: errorMessage(cause) }]);
                }
                setCreateProgress({ completed: index + 1, total: inputs.length });
            }
            if (source === 'magnet') setMagnet(failedMagnets.join('\n'));
            else setTorrents(failedTorrents);
            if (fileInput.current) fileInput.current.value = '';
            if (added) {
                setTaskScope('active'); setQuery(''); setCreatedNotice(previous => previous + added);
                await load();
            }
            if (!failedMagnets.length && !failedTorrents.length) { setCreateOpen(false); setCreateResults([]); }
        } finally { setCreating(false); setCreateProgress(null); }
    };
    const control = async (task: QbTask, action: 'pause' | 'resume' | 'retry' | 'cancel') => {
        if (action === 'resume' || action === 'retry') setTaskScope('active');
        setActing(true); setError(null);
        try { await qbittorrentClient.controlTask(task.id, action); setCancelling(null); await load(); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setActing(false); }
    };
    const loadFiles = async (id: string) => {
        const request = ++filesGeneration.current;
        setFilesLoading(true); setFileError(null);
        try {
            const result = await qbittorrentClient.getFiles(id);
            if (request !== filesGeneration.current) return;
            setFiles(result.files); setSelected(result.files.filter(file => file.priority > 0).map(file => file.index));
        } catch (cause) { if (request === filesGeneration.current) setFileError(errorMessage(cause)); }
        finally { if (request === filesGeneration.current) setFilesLoading(false); }
    };
    const closeFiles = () => { filesGeneration.current += 1; setFileTaskId(null); setFilesLoading(false); };
    const applyFiles = async () => {
        if (!fileTask || !canSelect(fileTask)) return;
        setActing(true); setFileError(null);
        try { await qbittorrentClient.selectFiles(fileTask.id, selected); closeFiles(); await load(); }
        catch (cause) { setFileError(errorMessage(cause)); }
        finally { setActing(false); }
    };
    const prepareDismissal = async (selectedTasks: QbTask[]) => {
        setActing(true); setError(null);
        try { setDismissal(await fileApi.prepareTaskDismissal({ tasks: selectedTasks.map(task => ({ sourceType: 'qbittorrent', id: task.id })) })); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setActing(false); }
    };
    const dismissHistory = async () => {
        if (!dismissal) return;
        setActing(true); setError(null);
        try {
            const result = await fileApi.confirmTaskDismissal(dismissal);
            setDismissal(null);
            if (result.failed.length) setError(result.failed.map(item => item.reason).join('; '));
            await load();
        } catch (cause) { setError(errorMessage(cause)); }
        finally { setActing(false); }
    };
    return <section className="tv-operations qb-page" aria-labelledby="qb-title">
        <header className="qb-page-header">
            <div><span className="op-eyebrow"><Download size={14} aria-hidden="true" />qBittorrent</span><h1 id="qb-title">{t('qbittorrent.title')}</h1><p>{t('qbittorrent.pageDescription')}</p></div>
            <Button onClick={openCreate}><Plus size={18} aria-hidden="true" />{t('qbittorrent.create')}</Button>
        </header>
        {error && <div className="op-notice op-notice--danger" role="alert">{error}</div>}
        {loadError && <div className="op-notice op-notice--danger" role="alert">{loadError}</div>}
        {createdNotice > 0 && <div className="op-notice op-notice--success" role="status"><span>{t('qbittorrent.createdNotice', { count: createdNotice })}</span><Button size="icon" variant="ghost" aria-label={t('qbittorrent.close')} onClick={() => setCreatedNotice(0)}><X size={16} aria-hidden="true" /></Button></div>}
        <div className="tv-panel qb-overview" aria-label={t('qbittorrent.overview')}>
            <div><Download size={20} aria-hidden="true" /><span>{t('qbittorrent.downloadingNow')}</span><strong>{loading ? '—' : downloadingTasks.length}</strong></div>
            <div><UploadCloud size={20} aria-hidden="true" /><span>{t('qbittorrent.transferringNow')}</span><strong>{loading ? '—' : transferringTasks.length}</strong></div>
            <button type="button" className={taskScope === 'attention' ? 'is-active' : ''} aria-pressed={taskScope === 'attention'} onClick={() => { setTaskScope(previous => previous === 'attention' ? 'active' : 'attention'); setQuery(''); }}><AlertCircle size={20} aria-hidden="true" /><span>{t('qbittorrent.needsAttention')}</span><strong>{loading ? '—' : attentionTasks.length}</strong></button>
        </div>
        <div className="qb-task-workspace">
            <div className="qb-list-toolbar">
                <div className="qb-scopes" role="group" aria-label={t('qbittorrent.taskScope')}>
                    <Button variant="ghost" aria-pressed={taskScope !== 'history'} onClick={() => setTaskScope('active')}>{t('qbittorrent.activeTasks', { count: activeTasks.length })}</Button>
                    <Button variant="ghost" aria-pressed={taskScope === 'history'} onClick={() => setTaskScope('history')}>{t('qbittorrent.historyTasks', { count: historyTasks.length })}</Button>
                </div>
                <Button variant="ghost" disabled={refreshing} aria-label={t('qbittorrent.reload')} onClick={() => void refresh()}><RefreshCw size={17} aria-hidden="true" className={refreshing ? 'animate-spin' : ''} /><span>{t('qbittorrent.reload')}</span></Button>
            </div>
            <div className="qb-search-row">
                <label className="qb-search"><Search size={18} aria-hidden="true" /><input type="search" aria-label={t('qbittorrent.searchTasks')} placeholder={t('qbittorrent.searchTasks')} value={query} onChange={event => setQuery(event.target.value)} />{query && <Button size="icon" variant="ghost" aria-label={t('qbittorrent.clearSearch')} onClick={() => setQuery('')}><X size={16} aria-hidden="true" /></Button>}</label>
                {taskScope === 'attention' && <Button variant="secondary" className="qb-attention-filter" onClick={() => setTaskScope('active')}>{t('qbittorrent.needsAttention')}<X size={14} aria-hidden="true" /></Button>}
                {taskScope === 'history' && historyTasks.length > 0 && <Button variant="ghost" disabled={acting} onClick={() => void prepareDismissal(historyTasks)}><Trash2 size={16} aria-hidden="true" />{t('qbittorrent.clearHistory')}</Button>}
            </div>
            <div className="qb-task-list" aria-label={t('qbittorrent.tasks')} aria-busy={loading}>
                {loading ? <div className="qb-loading"><IndeterminateSpinner label={t('qbittorrent.loading')} /></div> : visibleTasks.length === 0 ? <div className="tv-panel op-empty qb-empty">
                    <span className="qb-empty-icon">{search ? <Search size={30} aria-hidden="true" /> : taskScope === 'history' ? <Clock3 size={30} aria-hidden="true" /> : <Download size={30} aria-hidden="true" />}</span>
                    <h2>{t(search ? 'qbittorrent.noSearchResults' : taskScope === 'history' ? 'qbittorrent.noHistory' : taskScope === 'attention' ? 'qbittorrent.noAttention' : 'qbittorrent.noActiveTasks')}</h2>
                    <p>{t(search ? 'qbittorrent.searchHelp' : taskScope === 'history' ? 'qbittorrent.historyHelp' : taskScope === 'attention' ? 'qbittorrent.attentionHelp' : 'qbittorrent.emptyHelp')}</p>
                    {search ? <Button variant="outline" onClick={() => setQuery('')}>{t('qbittorrent.clearSearch')}</Button> : taskScope === 'active' && <Button onClick={openCreate}><Plus size={16} aria-hidden="true" />{t('qbittorrent.create')}</Button>}
                </div> : visibleTasks.map(task => <article className={`tv-panel qb-task qb-task--${task.status}`} key={task.id}>
                    <div className="qb-task-heading"><h2>{task.title}</h2><span className={`op-badge ${task.status === 'failed' ? 'op-badge--danger' : task.status === 'completed' ? 'op-badge--success' : task.status === 'paused' ? 'op-badge--warning' : task.status === 'cancelled' ? '' : 'op-badge--info'}`}>{['paused', 'completed', 'cancelled'].includes(task.status) ? t(`qbittorrent.stages.${task.status}`) : <>{task.status === 'failed' && task.stage !== 'failed' ? `${t('qbittorrent.stages.failed')} · ` : ''}{t(`qbittorrent.stages.${task.stage}`)}</>}</span></div>
                    <p className="qb-task-target"><Folder size={15} aria-hidden="true" /><span>{t('qbittorrent.target', { storage: accounts.find(account => account.id === task.targetAccountId)?.name || (task.targetProvider === 'local' ? t('qbittorrent.local') : task.targetProvider), folder: task.targetFolder })}</span></p>
                    <div className="qb-task-progress">
                        <Progress label={t('qbittorrent.downloadStep')} value={task.downloadProgress} bytes={task.downloadedBytes} total={task.totalBytes} speed={task.status === 'running' && task.stage === 'downloading' ? task.downloadSpeed : undefined} complete={task.downloadProgress >= 100} />
                        <Progress label={t('qbittorrent.transferStep')} value={task.progress} bytes={task.transferredBytes} total={task.totalBytes} speed={task.status === 'running' && task.stage === 'uploading' ? task.uploadSpeed : undefined} complete={task.status === 'completed'} />
                    </div>
                    {task.error && <p className="qb-task-error"><AlertCircle size={16} aria-hidden="true" /><span>{task.error}</span></p>}
                    <details className="qb-task-details"><summary>{t('qbittorrent.taskDetails')}<ChevronDown size={14} aria-hidden="true" /></summary><dl><div><dt>{t('qbittorrent.createdAt')}</dt><dd><time dateTime={task.createdAt}>{formatDateTime(task.createdAt, i18n.resolvedLanguage || i18n.language)}</time></dd></div><div><dt>{t('qbittorrent.updatedAt')}</dt><dd><time dateTime={task.updatedAt}>{formatDateTime(task.updatedAt, i18n.resolvedLanguage || i18n.language)}</time></dd></div><div><dt>{t('qbittorrent.localPolicy')}</dt><dd>{t(task.preserveLocalFiles ? 'qbittorrent.preserved' : 'qbittorrent.deletedAfterTransfer')}</dd></div></dl></details>
                    <div className="qb-actions qb-task-actions">
                        {['pending', 'running', 'paused'].includes(task.status) && ['submitting', 'metadata', 'downloading', 'paused'].includes(task.stage) && <Button variant="outline" disabled={acting} onClick={() => void control(task, task.status === 'paused' ? 'resume' : 'pause')}>{task.status === 'paused' ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}<span>{t(task.status === 'paused' ? 'qbittorrent.resume' : 'qbittorrent.pause')}</span></Button>}
                        {task.retryable && <Button variant="outline" disabled={acting} onClick={() => void control(task, 'retry')}><RotateCcw size={16} aria-hidden="true" /><span>{t(task.stage === 'cancelling' ? 'qbittorrent.retryCancel' : 'qbittorrent.retry')}</span></Button>}
                        {canSelect(task) && <Button variant="outline" disabled={acting} onClick={() => { setFileTaskId(task.id); setFiles([]); setSelected([]); void loadFiles(task.id); }}><FileStack size={16} aria-hidden="true" /><span>{t('qbittorrent.files')}</span></Button>}
                        {!['cleaning', 'cancelling'].includes(task.stage) && ['pending', 'running', 'paused', 'failed'].includes(task.status) && <Button variant="ghost" disabled={acting} className="qb-task-cancel" onClick={() => { setError(null); setCancelling(task); }}><Ban size={16} aria-hidden="true" /><span>{t('qbittorrent.cancel')}</span></Button>}
                        {taskScope === 'history' && <Button variant="ghost" disabled={acting} onClick={() => void prepareDismissal([task])}><Trash2 size={16} aria-hidden="true" /><span>{t('qbittorrent.dismissRecord')}</span></Button>}
                    </div>
                </article>)}
            </div>
        </div>
        {createOpen && <Dialog open onClose={() => { if (!creating) setCreateOpen(false); }} labelledBy="qb-create-title" describedBy="qb-create-description" closeOnEscape={!creating} closeOnBackdrop={!creating} className="qb-sheet qb-create-sheet">
            <header className="qb-sheet-header"><div><h2 id="qb-create-title">{t('qbittorrent.create')}</h2><p id="qb-create-description">{t('qbittorrent.createDescription')}</p></div><Button size="icon" variant="ghost" disabled={creating} aria-label={t('qbittorrent.close')} onClick={() => setCreateOpen(false)}><X size={20} aria-hidden="true" /></Button></header>
            <form className="qb-create" onSubmit={event => { event.preventDefault(); void create(); }} onInvalidCapture={() => { if (targetDetails.current) targetDetails.current.open = true; }}>
                <div className="qb-create-scroll"><fieldset disabled={creating}><legend className="sr-only">{t('qbittorrent.inputType')}</legend>
                    <div className="qb-sheet-body">
                        <div className="qb-source-switch">{(['magnet', 'torrent'] as const).map(value => <label key={value} className={source === value ? 'is-active' : ''}><input type="radio" name="qb-source" checked={source === value} onChange={() => { setSource(value); setCreateResults([]); }} /><span>{t(`qbittorrent.${value}`)}</span></label>)}</div>
                        {source === 'magnet' ? <SettingsField label={t('qbittorrent.magnet')}><textarea className="qb-magnet" required rows={4} value={magnet} placeholder={'magnet:?xt=urn:btih:…\nmagnet:?xt=urn:btih:…'} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => { setMagnet(event.target.value); setCreateResults([]); }} /><span className="settings-help">{t('qbittorrent.magnetHelp')}</span></SettingsField> : <div className="qb-torrent-input"><div className="qb-torrent-picker"><label><FileStack size={28} aria-hidden="true" /><strong>{t('qbittorrent.chooseTorrent')}</strong><span>{t('qbittorrent.torrentHelp')}</span><input ref={fileInput} type="file" multiple accept=".torrent,application/x-bittorrent" aria-label={t('qbittorrent.torrent')} onChange={event => { const files = Array.from(event.target.files ?? []); if (files.length) { setTorrents(previous => [...previous, ...files]); setCreateResults([]); } event.target.value = ''; }} /></label></div>{torrents.length > 0 && <ul className="qb-torrent-selection">{torrents.map((file, index) => <li key={index}><span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span><Button type="button" size="icon" variant="ghost" aria-label={t('qbittorrent.removeTorrent', { name: file.name })} onClick={() => { setTorrents(previous => previous.filter((_, fileIndex) => fileIndex !== index)); setCreateResults([]); }}><X size={17} aria-hidden="true" /></Button></li>)}</ul>}</div>}
                        <details ref={targetDetails} className="qb-target-details"><summary><Folder size={20} aria-hidden="true" /><span><strong>{t('qbittorrent.saveTo')}</strong><small>{accounts.find(account => account.id === target.targetAccountId)?.name || (target.targetAccountId === 'local' ? t('qbittorrent.local') : target.targetAccountId)} · {target.targetFolder}</small></span><ChevronDown size={18} aria-hidden="true" /></summary><div><QbittorrentTargetFields value={target} accounts={accounts} onChange={patch => setTarget(previous => ({ ...previous, ...patch }))} /></div></details>
                        <p className="qb-create-hint"><Check size={16} aria-hidden="true" />{t('qbittorrent.autoTransferHelp')}</p>
                        {createResults.length > 0 && <div className="qb-batch-results" aria-live="polite"><h3>{t('qbittorrent.batchResults')}</h3><ul>{createResults.map((result, index) => <li className={result.error ? 'is-error' : 'is-success'} key={index}>{result.error ? <AlertCircle size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}<div><strong>{result.label}</strong><p>{result.error || t('qbittorrent.batchAdded')}</p></div></li>)}</ul>{!creating && createResults.some(result => result.error) && <p>{t('qbittorrent.batchRetryHint')}</p>}</div>}
                    </div>
                </fieldset></div>
                <footer className="qb-sheet-footer qb-create-footer"><p role="status">{creating && createProgress ? t('qbittorrent.batchProgress', createProgress) : t('qbittorrent.batchCount', { count: inputCount })}</p><div><Button type="button" variant="outline" disabled={creating} onClick={() => setCreateOpen(false)}>{t('qbittorrent.back')}</Button><Button type="submit" disabled={creating || !inputCount}>{creating ? <IndeterminateSpinner label={t('qbittorrent.creating')} size="sm" /> : <Plus size={17} aria-hidden="true" />}{t(creating ? 'qbittorrent.creating' : 'qbittorrent.create')}</Button></div></footer>
            </form>
        </Dialog>}
        {dismissal && <Dialog open onClose={() => { if (!acting) setDismissal(null); }} labelledBy="qb-dismiss-title" closeOnEscape={!acting} closeOnBackdrop={!acting} className="qb-sheet qb-confirm-sheet"><div className="qb-dialog"><h2 id="qb-dismiss-title">{t('qbittorrent.clearHistory')}</h2><p>{t('qbittorrent.dismissDescription', { count: dismissal.impact.count })}</p>{error && <p className="op-inline-error" role="alert">{error}</p>}<div className="qb-actions"><Button variant="outline" disabled={acting} onClick={() => setDismissal(null)}>{t('qbittorrent.back')}</Button><Button disabled={acting} onClick={() => void dismissHistory()}><Trash2 size={16} aria-hidden="true" />{t('qbittorrent.confirmDismiss')}</Button></div></div></Dialog>}
        {cancelling && <Dialog open onClose={() => { if (!acting) setCancelling(null); }} labelledBy="qb-cancel-title" closeOnEscape={!acting} closeOnBackdrop={!acting} className="qb-sheet qb-confirm-sheet"><div className="qb-dialog"><h2 id="qb-cancel-title">{t('qbittorrent.cancelTitle')}</h2><p className="qb-confirm-name">{cancelling.title}</p><p className="settings-help">{t('qbittorrent.cancelDescription')}</p>{error && <p className="op-inline-error" role="alert">{error}</p>}<div className="qb-actions"><Button variant="outline" disabled={acting} onClick={() => setCancelling(null)}>{t('qbittorrent.back')}</Button><Button variant="destructive" disabled={acting} onClick={() => void control(cancelling, 'cancel')}><Ban size={16} aria-hidden="true" />{t('qbittorrent.confirmCancel')}</Button></div></div></Dialog>}
        {fileTaskId && <Dialog open onClose={() => { if (!acting) closeFiles(); }} labelledBy="qb-files-title" closeOnEscape={!acting} closeOnBackdrop={!acting} className="qb-sheet qb-files-sheet">
            <header className="qb-sheet-header"><div><h2 id="qb-files-title">{t('qbittorrent.files')}</h2><p>{fileTask?.title ?? fileTaskId}</p></div><Button size="icon" variant="ghost" disabled={acting} aria-label={t('qbittorrent.close')} onClick={closeFiles}><X size={20} aria-hidden="true" /></Button></header>
            <div className="qb-sheet-body">
                {fileError && <p role="alert" className="op-notice op-notice--danger">{fileError}</p>}
                {fileTask && !canSelect(fileTask) && <p role="status" className="settings-help">{t('qbittorrent.filesLocked')}</p>}
                <div className="qb-actions"><Button variant="outline" disabled={filesLoading || acting} onClick={() => void loadFiles(fileTaskId)}><RefreshCw size={16} aria-hidden="true" />{t('qbittorrent.reload')}</Button><Button variant="ghost" disabled={acting || filesLoading || !fileTask || !canSelect(fileTask)} onClick={() => setSelected(files.map(file => file.index))}>{t('qbittorrent.selectAll')}</Button><Button variant="ghost" disabled={acting || filesLoading || !fileTask || !canSelect(fileTask)} onClick={() => setSelected([])}>{t('qbittorrent.clear')}</Button></div>
                {filesLoading ? <IndeterminateSpinner label={t('qbittorrent.loading')} /> : !files.length ? <p className="settings-help">{t('qbittorrent.filesWaiting')}</p> : <div className="qb-files">{files.map(file => <label className="qb-file" key={file.index}><input type="checkbox" checked={selected.includes(file.index)} disabled={acting || !fileTask || !canSelect(fileTask)} onChange={event => setSelected(previous => event.target.checked ? [...previous, file.index] : previous.filter(index => index !== file.index))} /><span><strong>{file.name}</strong><small>{t('qbittorrent.fileSize', { size: formatBytes(file.size), progress: Math.round(file.progress * 100) })}</small></span></label>)}</div>}
            </div>
            <footer className="qb-sheet-footer qb-files-footer"><p aria-live="polite">{t('qbittorrent.selectedFiles', { count: selectedFiles.length, size: formatBytes(selectedFiles.reduce((sum, file) => sum + file.size, 0)) })}</p><Button disabled={acting || filesLoading || !selected.length || !fileTask || !canSelect(fileTask)} onClick={() => void applyFiles()}><Check size={16} aria-hidden="true" />{t('qbittorrent.apply')}</Button></footer>
        </Dialog>}
    </section>;
}
