import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle, ChevronDown, CircleHelp, HardDrive, Plus, RefreshCw, Search, ShieldCheck, Trash2, X } from '../ui/icons';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';
import { fileApi, type StorageAccount, type StorageConfig, type StorageDeleteImpact, type StorageStats } from '../../services/api';
import { API_BASE } from '../../services/config';
import { getProviderMetadata } from '../../services/providerMetadata';
import { isTrustedOAuthPopupMessage } from '../../services/oauthPopupMessage';
import { monitorOAuthPopup } from '../../services/oauthPopupFlow';
import { errorMessage } from '../../services/unknownError';
import { invalidateSettingsRequests } from '../../services/settingsRequestCache';
import { formatDateTime } from '../../i18n/format';
import { formatBytes } from '../../services/formatBytes';
import { SettingsField } from './SettingsPresentation';
import { LocalStorageLocation } from './LocalStorageLocation';
import { StorageAccountDetails } from './StorageAccountDetails';
import './storage-settings.css';

const PROVIDERS = ['webdav', 's3', 'aliyun_oss', 'onedrive', 'google_drive', 'openlist'] as const;
type Provider = typeof PROVIDERS[number];
type StorageTarget = { id: string; name: string; provider: Provider | 'local' };
const EMPTY_DRAFT = { name: '', url: '', username: '', password: '', rootPath: '/', region: '', bucket: '', accessKeyId: '', accessKeySecret: '', forcePathStyle: false, clientId: '', clientSecret: '', tenantId: 'common', sharedDriveId: '' };
type DeletePreview = { account: StorageAccount; confirmationToken: string; impact: StorageDeleteImpact };

export function StorageSettings({ config, loadError, storageStats, onReload, onRefreshStats, onOpenTasksForAccount }: {
    config: StorageConfig | null;
    loadError: string | null;
    storageStats?: StorageStats | null;
    onReload: () => Promise<StorageConfig>;
    onRefreshStats?: (accountId: string | null) => Promise<void>;
    onOpenTasksForAccount?: (accountId: string) => void;
}) {
    const { t, i18n } = useTranslation();
    const [addOpen, setAddOpen] = useState(false);
    const [provider, setProvider] = useState<Provider | null>(null);
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
    const [query, setQuery] = useState('');
    const [refreshing, setRefreshing] = useState(false);
    const [probingId, setProbingId] = useState<string | null>(null);
    const [probeNotice, setProbeNotice] = useState<{ id: string; message: string; error: boolean } | null>(null);
    const [switchTarget, setSwitchTarget] = useState<StorageTarget | null>(null);
    const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [actionBusy, setActionBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const oauthCleanup = useRef<(() => void) | null>(null);
    const oauthPopup = useRef<Window | null>(null);
    const accounts = config?.accounts ?? [];
    const activeAccount = accounts.find(account => account.id === config?.activeAccountId);
    const defaultName = config?.provider === 'local' ? t('storageSettings.local') : activeAccount?.name || config?.activeAccountName || getProviderMetadata(config?.provider).label;
    const search = query.trim().toLocaleLowerCase();
    const visibleAccounts = accounts.filter(account => !search || `${account.name} ${getProviderMetadata(account.type).label}`.toLocaleLowerCase().includes(search));
    const localVisible = !search || t('storageSettings.local').toLocaleLowerCase().includes(search) || 'local'.includes(search);
    const localEntries: null[] = localVisible ? [null] : [];
    const visibleEntries = config?.provider === 'local' ? [...localEntries, ...visibleAccounts] : [
        ...visibleAccounts.filter(account => account.id === config?.activeAccountId),
        ...localEntries,
        ...visibleAccounts.filter(account => account.id !== config?.activeAccountId),
    ];
    const isOAuth = provider === 'google_drive' || provider === 'onedrive';
    const mutationBusy = saving || actionBusy || deletingId !== null;
    const selectedMetadata = getProviderMetadata(provider);

    useEffect(() => () => {
        oauthCleanup.current?.();
        oauthPopup.current?.close();
    }, []);

    const refresh = async () => {
        setRefreshing(true);
        invalidateSettingsRequests();
        try {
            const latest = await onReload();
            await onRefreshStats?.(latest.activeAccountId);
            setNotice(null);
        } catch (cause) { setNotice({ message: errorMessage(cause), error: true }); }
        finally { setRefreshing(false); }
    };
    const closeAdd = () => {
        if (saving) return;
        setAddOpen(false); setProvider(null); setDraft(EMPTY_DRAFT); setFormError(null);
    };
    const submit = async () => {
        if (!provider || saving) return;
        setSaving(true); setFormError(null);
        if (provider === 'onedrive' || provider === 'google_drive') {
            const oauthProvider = provider;
            try {
                oauthCleanup.current?.(); oauthPopup.current?.close();
                const popup = window.open('about:blank', oauthProvider === 'onedrive' ? 'OneDriveAuth' : 'GoogleDriveAuth', `width=600,height=700,left=${window.screenX + (window.innerWidth - 600) / 2},top=${window.screenY + (window.innerHeight - 700) / 2},status=yes,toolbar=no,menubar=no`);
                if (!popup) throw new Error(t('settings.remaining.copy.204'));
                oauthPopup.current = popup;
                const flow = oauthProvider === 'onedrive'
                    ? await fileApi.getOneDriveAuthUrl(draft.clientId.trim(), draft.tenantId.trim() || 'common', draft.clientSecret.trim(), draft.name.trim())
                    : await fileApi.getGoogleDriveAuthUrl(draft.clientId.trim(), draft.clientSecret, draft.name.trim(), draft.sharedDriveId.trim());
                if (popup.closed) throw new Error(t('storageSettings.authorizationCancelled'));
                let statisticsFresh = true;
                oauthCleanup.current = monitorOAuthPopup({
                    host: window, popup,
                    classifyMessage: event => {
                        if (!isTrustedOAuthPopupMessage(event, { callbackOrigin: flow.callbackOrigin, popup, provider: oauthProvider, flowNonce: flow.flowNonce })) return null;
                        return event.data.type === 'oauth_success' ? 'success' : 'failed';
                    },
                    onSuccess: async event => {
                        const payload: unknown = event.data;
                        if (!payload || typeof payload !== 'object' || !('accountId' in payload) || typeof payload.accountId !== 'string' || !payload.accountId) throw new Error(t('settings.remaining.copy.205'));
                        const accountId = payload.accountId;
                        const latest = await onReload();
                        if (latest.activeAccountId !== accountId) throw new Error(t('errors.services.storage.authorizationNotSynchronized'));
                        try { await onRefreshStats?.(latest.activeAccountId); } catch { statisticsFresh = false; }
                    },
                    onStateChange: (state, cause) => {
                        if (state === 'waiting') return;
                        setSaving(false); oauthPopup.current = null;
                        if (state === 'success') {
                            setAddOpen(false); setProvider(null); setDraft(EMPTY_DRAFT);
                            setNotice({ message: t(statisticsFresh ? 'storageSettings.authorized' : 'storageSettings.updatedStatsStale'), error: !statisticsFresh });
                        } else if (state === 'cancelled') setFormError(t('storageSettings.authorizationCancelled'));
                        else {
                            const payload: unknown = cause instanceof MessageEvent ? cause.data : null;
                            setFormError(payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : errorMessage(cause, t('storageSettings.authorizationFailed')));
                        }
                    },
                });
                popup.location.replace(flow.authUrl);
            } catch (cause) {
                oauthCleanup.current?.(); oauthPopup.current?.close(); oauthPopup.current = null;
                setSaving(false); setFormError(errorMessage(cause));
            }
            return;
        }
        let added = false;
        try {
            if (provider === 's3') await fileApi.addS3Account(draft.name.trim(), draft.url.trim(), draft.region.trim(), draft.accessKeyId.trim(), draft.accessKeySecret, draft.bucket.trim(), draft.forcePathStyle);
            else if (provider === 'aliyun_oss') await fileApi.addAliyunOSSAccount(draft.name.trim(), draft.region.trim(), draft.accessKeyId.trim(), draft.accessKeySecret, draft.bucket.trim());
            else if (provider === 'webdav') await fileApi.addWebDAVAccount(draft.name.trim(), draft.url.trim(), draft.username, draft.password);
            else await fileApi.addOpenListAccount(draft.name.trim(), draft.url.trim(), draft.rootPath.trim() || '/', draft.username, draft.password);
            added = true;
            await onReload();
            setAddOpen(false); setProvider(null); setDraft(EMPTY_DRAFT);
            setNotice({ message: t('storageSettings.added'), error: false });
        } catch (cause) {
            if (added) {
                setAddOpen(false); setProvider(null); setDraft(EMPTY_DRAFT);
                setNotice({ message: t('storageSettings.addedRefreshFailed'), error: true });
            } else setFormError(errorMessage(cause));
        } finally { setSaving(false); }
    };
    const probe = async (account: StorageAccount) => {
        if (probingId) return;
        setProbingId(account.id); setProbeNotice(null);
        try {
            await fileApi.probeStorageAccount(account.id);
            setProbeNotice({ id: account.id, message: t('storageSettings.probeSucceeded'), error: false });
            await onReload();
        } catch (cause) {
            setProbeNotice({ id: account.id, message: errorMessage(cause), error: true });
            await onReload().catch(() => undefined);
        } finally { setProbingId(null); }
    };
    const switchDefault = async () => {
        if (!switchTarget || actionBusy) return;
        setActionBusy(true); setActionError(null);
        let switched = false;
        try {
            await fileApi.switchStorageProvider(switchTarget.provider, switchTarget.provider === 'local' ? undefined : switchTarget.id);
            switched = true;
            const latest = await onReload();
            setSwitchTarget(null);
            try {
                await onRefreshStats?.(latest.activeAccountId);
                setNotice({ message: t('storageSettings.switched'), error: false });
            } catch { setNotice({ message: t('storageSettings.updatedStatsStale'), error: true }); }
        } catch (cause) {
            if (switched) {
                setSwitchTarget(null);
                setNotice({ message: t('storageSettings.updatedRefreshFailed'), error: true });
            } else setActionError(errorMessage(cause));
        } finally { setActionBusy(false); }
    };
    const prepareDelete = async (account: StorageAccount) => {
        if (mutationBusy) return;
        setDeletingId(account.id); setActionError(null);
        try {
            const preview = await fileApi.previewAccountDeletion(account.id);
            setDeletePreview({ account, confirmationToken: preview.confirmationToken, impact: preview.impact });
        } catch (cause) { setNotice({ message: errorMessage(cause), error: true }); }
        finally { setDeletingId(null); }
    };
    const removeAccount = async () => {
        if (!deletePreview || actionBusy) return;
        setActionBusy(true); setActionError(null);
        let removed = false;
        try {
            await fileApi.deleteAccount(deletePreview.account.id, deletePreview.confirmationToken);
            removed = true;
            const latest = await onReload();
            setDeletePreview(null);
            try {
                await onRefreshStats?.(latest.activeAccountId);
                setNotice({ message: t('storageSettings.removed'), error: false });
            } catch { setNotice({ message: t('storageSettings.updatedStatsStale'), error: true }); }
        } catch (cause) {
            if (removed) { setDeletePreview(null); setNotice({ message: t('storageSettings.updatedRefreshFailed'), error: true }); }
            else setActionError(errorMessage(cause));
        } finally { setActionBusy(false); }
    };
    const deletionBusy = deletePreview ? deletePreview.impact.activeLeaseCount + deletePreview.impact.activeTaskCount + deletePreview.impact.activeUploadCount : 0;
    return <section className="storage-settings" aria-label={t('storageSettings.title')}>
        <header className="st-workspace-heading"><div><h2>{t('storageSettings.title')}</h2>{config && <span className="st-account-count" aria-label={t('storageSettings.accounts')}>{accounts.length + 1}</span>}</div><Button disabled={!config || mutationBusy} onClick={() => { setAddOpen(true); setNotice(null); }}><Plus size={17} aria-hidden="true" />{t('storageSettings.add')}</Button></header>
        {notice && <div className={`st-notice${notice.error ? ' is-error' : ' is-success'}`} role={notice.error ? 'alert' : 'status'}><span>{notice.message}</span><Button size="icon" variant="ghost" aria-label={t('storageSettings.close')} onClick={() => setNotice(null)}><X size={17} aria-hidden="true" /></Button>{notice.error && <Button variant="outline" disabled={refreshing} onClick={() => void refresh()}>{t('storageSettings.refresh')}</Button>}</div>}
        {loadError && !config && <div className="st-notice is-error" role="alert"><span>{loadError}</span><Button variant="outline" disabled={refreshing} onClick={() => void refresh()}>{t('storageSettings.retry')}</Button></div>}
        {!config ? !loadError && <div className="st-loading"><IndeterminateSpinner label={t('storageSettings.loading')} /></div> : <>
            <section className="st-account-section" aria-label={t('storageSettings.accounts')}>
                <div className="st-list-filters"><label className="st-search"><Search size={18} aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t('storageSettings.search')} placeholder={t('storageSettings.search')} />{query && <Button size="icon" variant="ghost" aria-label={t('storageSettings.clearSearch')} onClick={() => setQuery('')}><X size={16} aria-hidden="true" /></Button>}</label><Button size="icon" variant="outline" disabled={refreshing || mutationBusy} onClick={() => void refresh()} aria-label={t('storageSettings.refresh')} title={t('storageSettings.refresh')}><RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" /></Button></div>
                <div className="st-account-list">
                    {visibleEntries.map(account => {
                        if (!account) return <article className={`tv-panel st-account${config.provider === 'local' ? ' is-default' : ''}`} key="local">
                            <div className="st-account-heading"><span className="st-provider-icon"><HardDrive size={22} aria-hidden="true" /></span><div><h3 data-current-storage={config.provider === 'local' ? '' : undefined}>{t('storageSettings.local')}</h3><p>{t('storageSettings.localDescription')}</p></div>{config.provider === 'local' && <span className="st-default-badge"><Check size={14} aria-hidden="true" />{t('storageSettings.defaultBadge')}</span>}</div>
                            <details className="st-local-details"><summary>{t('storageSettings.localLocation')}<ChevronDown size={15} aria-hidden="true" /></summary><LocalStorageLocation /></details>
                            {config.provider !== 'local' && <div className="st-account-actions"><Button variant="outline" disabled={mutationBusy} onClick={() => { setActionError(null); setSwitchTarget({ id: 'local', name: t('storageSettings.local'), provider: 'local' }); }}><ArrowRight size={16} aria-hidden="true" />{t('storageSettings.setDefault')}</Button></div>}
                        </article>;
                        const metadata = getProviderMetadata(account.type);
                        const Icon = metadata.icon;
                        const active = config.provider === account.type && config.activeAccountId === account.id;
                        const switchProvider = PROVIDERS.find(value => value === account.type);
                        const feedback = probeNotice?.id === account.id ? probeNotice : null;
                        return <article key={account.id} data-storage-account={account.id} className={`tv-panel st-account${active ? ' is-default' : ''}`}>
                            <div className="st-account-heading"><span className="st-provider-icon"><Icon size={22} aria-hidden="true" /></span><div><h3 data-current-storage={active ? '' : undefined}>{account.name || metadata.label}</h3><p>{metadata.label}</p></div>{active && <span className="st-default-badge"><Check size={14} aria-hidden="true" />{t('storageSettings.defaultBadge')}</span>}</div>
                            <div className="st-connection"><span className={account.last_probe_status === 'available' ? 'st-status is-success' : account.last_probe_status === 'failed' ? 'st-status is-error' : 'st-status'}>{account.last_probe_status === 'available' ? <CheckCircle size={15} aria-hidden="true" /> : account.last_probe_status === 'failed' ? <AlertCircle size={15} aria-hidden="true" /> : <CircleHelp size={15} aria-hidden="true" />}{t(account.last_probe_status === 'available' ? 'settings.probe.available' : account.last_probe_status === 'failed' ? 'settings.probe.failed' : 'settings.probe.notTested')}</span>{account.last_probed_at && <time dateTime={account.last_probed_at}>{formatDateTime(account.last_probed_at, i18n.resolvedLanguage || i18n.language)}</time>}</div>
                            {feedback ? <p className={`st-feedback${feedback.error ? ' is-error' : ' is-success'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p> : account.last_probe_status === 'failed' && account.last_probe_error && <p className="st-feedback is-error">{account.last_probe_error}</p>}
                            <div className="st-account-actions">
                                {!active && switchProvider && <Button variant="outline" disabled={mutationBusy} onClick={() => { setActionError(null); setSwitchTarget({ id: account.id, name: account.name || metadata.label, provider: switchProvider }); }}><ArrowRight size={16} aria-hidden="true" />{t('storageSettings.setDefault')}</Button>}
                                <Button variant="ghost" disabled={probingId !== null || mutationBusy} onClick={() => void probe(account)}>{probingId === account.id ? <IndeterminateSpinner label={t('settings.probe.testing')} size="sm" /> : <RefreshCw size={16} aria-hidden="true" />}{t(probingId === account.id ? 'settings.probe.testing' : 'settings.probe.test')}</Button>
                                <StorageAccountDetails account={account} onSaved={onReload} />
                            </div>
                            {!active && <details className="st-account-more"><summary>{t('storageSettings.more')}<ChevronDown size={14} aria-hidden="true" /></summary><p>{t('storageSettings.removeHint')}</p><Button variant="ghost" className="st-remove-button" disabled={mutationBusy} onClick={() => void prepareDelete(account)}><Trash2 size={16} aria-hidden="true" />{t(deletingId === account.id ? 'storageSettings.preparing' : 'storageSettings.remove')}</Button></details>}
                        </article>;
                    })}
                    {search && visibleEntries.length === 0 && <div className="tv-panel st-empty"><Search size={25} aria-hidden="true" /><p>{t('storageSettings.noResults')}</p><Button variant="outline" onClick={() => setQuery('')}>{t('storageSettings.clearSearch')}</Button></div>}
                </div>
                {accounts.length === 0 && <div className="st-first-account"><p>{t('storageSettings.emptyHelp')}</p></div>}
            </section>
            <details className="tv-panel st-capacity"><summary><HardDrive size={18} aria-hidden="true" />{t('storageSettings.capacity')}<ChevronDown size={16} aria-hidden="true" /></summary><div>{storageStats ? <><dl><div><dt>{t('storageSettings.serverDisk')}</dt><dd>{storageStats.server.used} / {storageStats.server.total}</dd><small>{t('storageSettings.freeSpace', { size: storageStats.server.free })}</small></div><div><dt>{t('storageSettings.indexedFiles')}</dt><dd>{storageStats.tgvault.used}</dd><small>{t('files.ui.storage.fileCount', { count: storageStats.tgvault.fileCount })}</small></div></dl><p>{t('storageSettings.capacityHint')}</p></> : <p>{t('storageSettings.noCapacity')}</p>}</div></details>
            <a className="st-guide-link" href="https://hicocos.github.io/tg-vault/storage.html" target="_blank" rel="noopener noreferrer"><BookOpen size={17} aria-hidden="true" />{t('storageSettings.guide')}<ArrowRight size={15} aria-hidden="true" /></a>
        </>}
        {addOpen && <Dialog open onClose={closeAdd} labelledBy="st-add-title" describedBy="st-add-description" closeOnEscape={!saving} closeOnBackdrop={!saving} className="st-sheet st-add-sheet">
            <header className="st-sheet-header"><div><h2 id="st-add-title">{provider ? t('storageSettings.connectProvider', { provider: selectedMetadata.label }) : t('storageSettings.add')}</h2><p id="st-add-description">{t(provider ? isOAuth ? 'storageSettings.oauthDescription' : 'storageSettings.connectionDescription' : 'storageSettings.chooseDescription')}</p></div><Button size="icon" variant="ghost" disabled={saving} aria-label={t('storageSettings.close')} onClick={closeAdd}><X size={20} aria-hidden="true" /></Button></header>
            {!provider ? <div className="st-sheet-body"><div className="st-provider-picker">{PROVIDERS.map(value => { const metadata = getProviderMetadata(value); const Icon = metadata.icon; return <button type="button" key={value} onClick={() => { setProvider(value); setFormError(null); setDraft(EMPTY_DRAFT); }}><span className="st-provider-icon"><Icon size={23} aria-hidden="true" /></span><span><strong>{metadata.label}</strong><small>{t(`storageSettings.providers.${value}`)}</small></span><ArrowRight size={17} aria-hidden="true" /></button>; })}</div><p className="st-privacy"><ShieldCheck size={16} aria-hidden="true" />{t('storageSettings.privacy')}</p></div> : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
                <div className="st-form-scroll"><fieldset disabled={saving}>
                    <div className="st-sheet-body">
                        <Button type="button" variant="ghost" className="st-change-type" onClick={() => { setProvider(null); setDraft(EMPTY_DRAFT); setFormError(null); }}><ArrowLeft size={16} aria-hidden="true" />{t('storageSettings.changeType')}</Button>
                        <SettingsField label={t(isOAuth ? 'storageSettings.optionalName' : 'storageSettings.name')}><input name="name" value={draft.name} maxLength={100} required={!isOAuth} placeholder={t('storageSettings.namePlaceholder')} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} autoComplete="off" /></SettingsField>
                        {isOAuth ? <>
                            <SettingsField label="Client ID"><input name="clientId" required value={draft.clientId} onChange={event => setDraft(previous => ({ ...previous, clientId: event.target.value }))} autoCapitalize="none" spellCheck={false} autoComplete="off" /></SettingsField>
                            <SettingsField label="Client Secret"><input name="clientSecret" type="password" required value={draft.clientSecret} onChange={event => setDraft(previous => ({ ...previous, clientSecret: event.target.value }))} autoComplete="new-password" /></SettingsField>
                            {provider === 'onedrive' ? <SettingsField label={t('storageSettings.tenant')}><input name="tenantId" value={draft.tenantId} onChange={event => setDraft(previous => ({ ...previous, tenantId: event.target.value }))} autoCapitalize="none" spellCheck={false} /><span className="st-field-help">{t('storageSettings.tenantHint')}</span></SettingsField> : <SettingsField label={t('storageSettings.sharedDrive')}><input name="sharedDriveId" value={draft.sharedDriveId} onChange={event => setDraft(previous => ({ ...previous, sharedDriveId: event.target.value }))} autoCapitalize="none" spellCheck={false} /><span className="st-field-help">{t('storageSettings.sharedDriveHint')}</span></SettingsField>}
                        </> : <>
                            {provider !== 'aliyun_oss' && <SettingsField label={t(provider === 's3' ? 'storageSettings.endpoint' : 'storageSettings.address')}><input name="url" type="url" required value={draft.url} placeholder={provider === 's3' ? 'https://s3.example.com' : provider === 'openlist' ? 'https://openlist.example.com' : 'https://dav.example.com/dav/'} onChange={event => setDraft(previous => ({ ...previous, url: event.target.value }))} autoCapitalize="none" spellCheck={false} autoComplete="off" /></SettingsField>}
                            {(provider === 's3' || provider === 'aliyun_oss') ? <>
                                <div className="st-form-grid"><SettingsField label={t('storageSettings.region')}><input name="region" required value={draft.region} placeholder={provider === 'aliyun_oss' ? 'oss-cn-hangzhou' : 'us-east-1'} onChange={event => setDraft(previous => ({ ...previous, region: event.target.value }))} autoCapitalize="none" spellCheck={false} /></SettingsField><SettingsField label={t('storageSettings.bucket')}><input name="bucket" required value={draft.bucket} onChange={event => setDraft(previous => ({ ...previous, bucket: event.target.value }))} autoCapitalize="none" spellCheck={false} /></SettingsField></div>
                                <SettingsField label="AccessKey ID"><input name="accessKeyId" required value={draft.accessKeyId} onChange={event => setDraft(previous => ({ ...previous, accessKeyId: event.target.value }))} autoComplete="off" autoCapitalize="none" spellCheck={false} /></SettingsField><SettingsField label="AccessKey Secret"><input name="accessKeySecret" required type="password" value={draft.accessKeySecret} onChange={event => setDraft(previous => ({ ...previous, accessKeySecret: event.target.value }))} autoComplete="new-password" /></SettingsField>
                                {provider === 's3' && <label className="st-checkbox"><input type="checkbox" checked={draft.forcePathStyle} onChange={event => setDraft(previous => ({ ...previous, forcePathStyle: event.target.checked }))} /><span>{t('storageSettings.pathStyle')}<small>{t('storageSettings.pathStyleHint')}</small></span></label>}
                            </> : <>
                                {provider === 'openlist' && <SettingsField label={t('storageSettings.rootPath')}><input name="rootPath" value={draft.rootPath} placeholder="/" onChange={event => setDraft(previous => ({ ...previous, rootPath: event.target.value }))} /><span className="st-field-help">{t('settings.openlist.rootHint')}</span></SettingsField>}
                                <SettingsField label={t(provider === 'webdav' ? 'storageSettings.optionalUsername' : 'storageSettings.username')}><input name="username" required={provider === 'openlist'} value={draft.username} onChange={event => setDraft(previous => ({ ...previous, username: event.target.value }))} autoComplete="username" autoCapitalize="none" spellCheck={false} /></SettingsField><SettingsField label={t(provider === 'webdav' ? 'storageSettings.optionalPassword' : 'storageSettings.password')}><input name="password" required={provider === 'openlist'} type="password" value={draft.password} onChange={event => setDraft(previous => ({ ...previous, password: event.target.value }))} autoComplete="new-password" /></SettingsField>
                            </>}
                        </>}
                        <details className="st-setup-help"><summary><BookOpen size={16} aria-hidden="true" />{t('storageSettings.setupHelp')}<ChevronDown size={15} aria-hidden="true" /></summary><div>{isOAuth ? <><p>{t(provider === 'onedrive' ? 'storageSettings.oneDriveGuide' : 'storageSettings.googleGuide')}</p><a href={provider === 'onedrive' ? 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' : 'https://console.cloud.google.com/apis/credentials'} target="_blank" rel="noopener noreferrer">{t('storageSettings.openConsole')}<ArrowRight size={14} aria-hidden="true" /></a><p>{t('storageSettings.callback')}</p><code>{provider === 'onedrive' ? config?.redirectUri || `${API_BASE || window.location.origin}/api/storage/onedrive/callback` : config?.googleDriveRedirectUri || `${window.location.origin}/api/storage/google-drive/callback`}</code></> : <p>{t(`storageSettings.setup.${provider}`)}</p>}<a href="https://hicocos.github.io/tg-vault/storage.html" target="_blank" rel="noopener noreferrer">{t('storageSettings.guide')}<ArrowRight size={14} aria-hidden="true" /></a></div></details>
                        <p className="st-privacy"><ShieldCheck size={16} aria-hidden="true" />{t(isOAuth ? 'storageSettings.oauthDefaultHint' : 'storageSettings.addDefaultHint')}</p>
                    </div>
                </fieldset></div>
                {formError && <div className="st-notice st-authorization-status is-error" role="alert">{formError}</div>}
                {saving && isOAuth && <div className="st-notice st-authorization-status" role="status"><span>{t('storageSettings.waitingAuthorization')}</span><Button type="button" variant="outline" onClick={() => { oauthCleanup.current?.(); oauthPopup.current?.close(); oauthPopup.current = null; setSaving(false); setFormError(t('storageSettings.authorizationCancelled')); }}>{t('storageSettings.cancelAuthorization')}</Button></div>}
                <footer className="st-sheet-footer"><Button type="button" variant="outline" disabled={saving} onClick={closeAdd}>{t('storageSettings.cancel')}</Button><Button type="submit" disabled={saving}>{saving ? <IndeterminateSpinner label={t(isOAuth ? 'storageSettings.authorizing' : 'storageSettings.connecting')} size="sm" /> : isOAuth ? <ArrowRight size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}{t(saving ? isOAuth ? 'storageSettings.authorizing' : 'storageSettings.connecting' : isOAuth ? 'storageSettings.authorize' : 'storageSettings.connect')}</Button></footer>
            </form>}
        </Dialog>}
        {switchTarget && <Dialog open onClose={() => { if (!actionBusy) setSwitchTarget(null); }} labelledBy="st-switch-title" closeOnEscape={!actionBusy} closeOnBackdrop={!actionBusy} className="st-sheet st-confirm-sheet"><header className="st-sheet-header"><h2 id="st-switch-title">{t('storageSettings.switchTitle')}</h2><Button size="icon" variant="ghost" disabled={actionBusy} aria-label={t('storageSettings.close')} onClick={() => setSwitchTarget(null)}><X size={20} aria-hidden="true" /></Button></header><div className="st-sheet-body"><dl className="st-switch-preview"><div><dt>{t('storageSettings.from')}</dt><dd>{defaultName}</dd></div><ArrowRight size={18} aria-hidden="true" /><div><dt>{t('storageSettings.to')}</dt><dd>{switchTarget.name}</dd></div></dl><p>{t('storageSettings.switchHint')}</p>{actionError && <p className="st-notice is-error" role="alert">{actionError}</p>}</div><footer className="st-sheet-footer"><Button variant="outline" disabled={actionBusy} onClick={() => setSwitchTarget(null)}>{t('storageSettings.cancel')}</Button><Button disabled={actionBusy} onClick={() => void switchDefault()}>{t(actionBusy ? 'storageSettings.switching' : 'storageSettings.confirmSwitch')}</Button></footer></Dialog>}
        {deletePreview && <Dialog open onClose={() => { if (!actionBusy) setDeletePreview(null); }} labelledBy="st-remove-title" closeOnEscape={!actionBusy} closeOnBackdrop={!actionBusy} className="st-sheet st-confirm-sheet"><header className="st-sheet-header"><h2 id="st-remove-title">{t(deletionBusy ? 'storageSettings.removeBlocked' : 'storageSettings.removeTitle')}</h2><Button size="icon" variant="ghost" disabled={actionBusy} aria-label={t('storageSettings.close')} onClick={() => setDeletePreview(null)}><X size={20} aria-hidden="true" /></Button></header><div className="st-sheet-body"><strong className="st-confirm-name">{deletePreview.account.name}</strong><dl className="st-impact"><div><dt>{t('storageSettings.fileCount')}</dt><dd>{deletePreview.impact.fileCount}</dd></div><div><dt>{t('storageSettings.fileSize')}</dt><dd>{formatBytes(deletePreview.impact.totalSizeBytes)}</dd></div><div><dt>{t('storageSettings.folderCount')}</dt><dd>{deletePreview.impact.folderCount}</dd></div></dl><p>{t('storageSettings.removeWarning')}</p>{deletionBusy > 0 && <p className="st-notice is-error">{t('storageSettings.removeBusy', { count: deletionBusy })}</p>}{actionError && <p className="st-notice is-error" role="alert">{actionError}</p>}</div><footer className="st-sheet-footer"><Button variant="outline" disabled={actionBusy} onClick={() => setDeletePreview(null)}>{t('storageSettings.cancel')}</Button>{deletionBusy ? onOpenTasksForAccount && <Button onClick={() => { const id = deletePreview.account.id; setDeletePreview(null); onOpenTasksForAccount(id); }}>{t('storageSettings.viewTasks')}</Button> : <Button variant="destructive" disabled={actionBusy} onClick={() => void removeAccount()}><Trash2 size={16} aria-hidden="true" />{t(actionBusy ? 'storageSettings.removing' : 'storageSettings.confirmRemove')}</Button>}</footer></Dialog>}
    </section>;
}
