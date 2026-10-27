import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiJson } from '../../services/httpClient';
import type { StorageAccount } from '../../services/api';
import { getProviderMetadata } from '../../services/providerMetadata';
import { formatDateTime } from '../../i18n/format';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { ChevronDown, KeyRound, LoaderCircle, Pencil, X } from '../ui/icons';
import './storage-account-details.css';

interface AccountDetails {
    id: string;
    name: string;
    type: string;
    isActive: boolean;
    createdAt: string | null;
    updatedAt: string | null;
    fields: Record<string, string | boolean>;
    secrets: Record<string, boolean>;
}

export function StorageAccountDetails({ account, onSaved }: { account: StorageAccount; onSaved: () => Promise<unknown> }) {
    const { t, i18n } = useTranslation();
    const [open, setOpen] = useState(false);
    const [details, setDetails] = useState<AccountDetails | null>(null);
    const [name, setName] = useState(account.name);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [saveError, setSaveError] = useState(false);
    const [saved, setSaved] = useState(false);
    const [epoch, setEpoch] = useState(0);
    const titleId = `storage-account-${account.id}`;
    const trimmedName = name.trim();
    const invalid = !trimmedName || trimmedName.length > 100;

    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        setLoading(true);
        setDetails(null);
        setLoadError(false);
        setSaveError(false);
        setSaved(false);
        void apiJson<AccountDetails>(`/api/storage/accounts/${encodeURIComponent(account.id)}/details`, { signal: controller.signal }).then(data => {
            if (controller.signal.aborted) return;
            setDetails(data);
            setName(data.name);
        }).catch(() => { if (!controller.signal.aborted) setLoadError(true); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [open, account.id, epoch]);

    const save = async () => {
        if (invalid || saving || !details || trimmedName === details.name) return;
        setSaving(true);
        setSaveError(false);
        setSaved(false);
        try {
            const result = await apiJson<{ name: string }>(`/api/storage/accounts/${encodeURIComponent(account.id)}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: trimmedName }),
            });
            setDetails(previous => previous ? { ...previous, name: result.name } : previous);
            setName(result.name);
            await onSaved();
            setSaved(true);
        } catch { setSaveError(true); }
        finally { setSaving(false); }
    };

    return <>
        <Button size="sm" variant="ghost" className="storage-account-details-trigger" onClick={() => setOpen(true)}>
            <Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />{t('storageAccount.detailsRename')}
        </Button>
        <Dialog open={open} onClose={() => { if (!saving) setOpen(false); }} labelledBy={titleId} closeOnEscape={!saving} closeOnBackdrop={!saving} className="storage-account-details">
            <header className="storage-account-details__header">
                <div>
                    <h3 id={titleId}>{t('storageAccount.details')}</h3>
                    <p>{getProviderMetadata(account.type).label} · {details?.name || account.name}</p>
                </div>
                <Button size="icon" variant="ghost" disabled={saving} onClick={() => setOpen(false)} aria-label={t('storageAccount.close')}><X className="h-5 w-5" aria-hidden="true" /></Button>
            </header>
            <div className="storage-account-details__body" aria-busy={loading}>
                {loading && <p role="status" className="storage-account-details__loading"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />{t('storageAccount.loading')}</p>}
                {loadError && <div role="alert" className="space-y-3"><p>{t('storageAccount.loadFailed')}</p><Button variant="outline" onClick={() => setEpoch(value => value + 1)}>{t('storageAccount.retry')}</Button></div>}
                {details && <>
                    <form id={`${titleId}-rename`} className="storage-account-details__rename" onSubmit={event => { event.preventDefault(); void save(); }}>
                        <label htmlFor={`${titleId}-name`}>{t('storageAccount.name')}</label>
                        <p id={`${titleId}-name-hint`}>{t('storageAccount.nameHint')}</p>
                        <input id={`${titleId}-name`} value={name} disabled={saving} maxLength={100} onChange={event => { setName(event.target.value); setSaved(false); }} aria-invalid={invalid} aria-describedby={`${titleId}-name-hint${invalid ? ` ${titleId}-name-error` : ''}`} autoComplete="off" />
                        {invalid && <p id={`${titleId}-name-error`} className="storage-account-details__error">{t('storageAccount.invalidName')}</p>}
                    </form>
                    <div className="storage-account-details__secondary">
                        <p className="storage-account-details__privacy">{t('storageAccount.privacy')}</p>
                        <details className="storage-account-details__disclosure">
                            <summary tabIndex={0}><span>{t('storageAccount.configuration')}</span><ChevronDown className="h-4 w-4" aria-hidden="true" /></summary>
                            <div className="storage-account-details__disclosure-body">
                                <p className="storage-account-details__hint">{t('storageAccount.readOnly')}</p>
                                <dl className="storage-account-details__fields">
                                    {Object.entries(details.fields).map(([key, value]) => <div key={key}><dt>{t(`storageAccount.fields.${key}`)}</dt><dd>{typeof value === 'boolean' ? t(value ? 'storageAccount.yes' : 'storageAccount.no') : value || '—'}</dd></div>)}
                                </dl>
                                {!Object.keys(details.fields).length && <p className="storage-account-details__hint">{t('storageAccount.empty')}</p>}
                            </div>
                        </details>
                        <details className="storage-account-details__disclosure">
                            <summary tabIndex={0}><KeyRound className="h-4 w-4" aria-hidden="true" /><span>{t('storageAccount.credentials')}</span><ChevronDown className="h-4 w-4" aria-hidden="true" /></summary>
                            <dl className="storage-account-details__secrets storage-account-details__disclosure-body">
                                {Object.entries(details.secrets).map(([key, present]) => <div key={key}><dt>{t(`storageAccount.fields.${key}`)}</dt><dd>{t(present ? 'storageAccount.configured' : 'storageAccount.notConfigured')}</dd></div>)}
                            </dl>
                        </details>
                    </div>
                    <dl className="storage-account-details__metadata">
                        <div><dt>{t('storageAccount.id')}</dt><dd>{details.id}</dd></div>
                        {(['createdAt', 'updatedAt'] as const).map(key => <div key={key}><dt>{t(`storageAccount.${key}`)}</dt><dd>{details[key] ? formatDateTime(details[key], i18n.resolvedLanguage || i18n.language) : '—'}</dd></div>)}
                    </dl>
                </>}
            </div>
            {details && <footer className="storage-account-details__footer">
                <div className="storage-account-details__feedback">
                    {saving && <p role="status">{t('storageAccount.saving')}</p>}
                    {saveError && <p role="alert" className="storage-account-details__error">{t('storageAccount.saveFailed')}</p>}
                    {saved && <p role="status" className="storage-account-details__success">{t('storageAccount.saved')}</p>}
                </div>
                <Button type="submit" form={`${titleId}-rename`} disabled={invalid || saving || trimmedName === details.name}>
                    {saving && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}{t('storageAccount.save')}
                </Button>
            </footer>}
        </Dialog>
    </>;
}
