import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiJson } from '../../services/httpClient';
import type { StorageAccount } from '../../services/api';
import { getProviderMetadata } from '../../services/providerMetadata';
import { formatDateTime } from '../../i18n/format';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { KeyRound, LoaderCircle, Pencil, X } from '../ui/icons';

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
        <Button size="sm" variant="ghost" className="mt-1 max-w-full whitespace-normal text-left" onClick={() => setOpen(true)}>
            <Pencil className="mr-1.5 h-3.5 w-3.5 shrink-0" />{t('storageAccount.details')} · {t('storageAccount.rename')}
        </Button>
        <Dialog open={open} onClose={() => { if (!saving) setOpen(false); }} labelledBy={titleId} closeOnEscape={!saving} closeOnBackdrop={!saving} className="w-full max-w-2xl">
            <div className="settings-surface overflow-hidden rounded-xl border border-border bg-background shadow-xl">
                <header className="flex items-start justify-between gap-4 border-b border-border p-5">
                    <div className="min-w-0"><h3 id={titleId} className="break-words text-lg font-semibold">{t('storageAccount.details')}</h3><p className="mt-1 break-words text-sm text-muted-foreground">{getProviderMetadata(account.type).label} · {details?.name || account.name}</p></div>
                    <Button size="sm" variant="ghost" className="settings-icon-button p-0" disabled={saving} onClick={() => setOpen(false)} aria-label={t('storageAccount.close')}><X className="h-4 w-4" /></Button>
                </header>
                <div className="max-h-[70vh] space-y-5 overflow-y-auto p-5">
                    {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />{t('storageAccount.loading')}</p>}
                    {loadError && <div role="alert" className="space-y-2"><p>{t('storageAccount.loadFailed')}</p><Button variant="outline" onClick={() => setEpoch(value => value + 1)}>{t('storageAccount.retry')}</Button></div>}
                    {details && <>
                        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void save(); }}>
                            <label htmlFor={`${titleId}-name`} className="text-sm font-medium">{t('storageAccount.name')}</label>
                            <div className="flex flex-col gap-2 sm:flex-row"><input id={`${titleId}-name`} className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" value={name} disabled={saving} onChange={event => { setName(event.target.value); setSaved(false); }} aria-invalid={invalid} autoComplete="off" /><Button type="submit" disabled={invalid || saving || trimmedName === details.name}>{saving && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}{t('storageAccount.save')}</Button></div>
                            <p className="text-xs leading-5 text-muted-foreground">{t('storageAccount.nameHint')}</p>
                            {invalid && <p className="text-xs text-destructive">{t('storageAccount.invalidName')}</p>}
                            {saveError && <p role="alert" className="text-sm text-destructive">{t('storageAccount.saveFailed')}</p>}
                            {saved && <p role="status" className="text-sm text-emerald-600">{t('storageAccount.saved')}</p>}
                        </form>
                        <section><h4 className="mb-3 text-sm font-semibold">{t('storageAccount.configuration')}</h4><dl className="divide-y divide-border rounded-lg border border-border px-3">
                            {Object.entries(details.fields).map(([key, value]) => <div key={key} className="grid min-w-0 grid-cols-1 gap-1 py-3 text-sm sm:grid-cols-[150px_minmax(0,1fr)]"><dt className="min-w-0 text-muted-foreground">{t(`storageAccount.fields.${key}`)}</dt><dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{typeof value === 'boolean' ? t(value ? 'storageAccount.yes' : 'storageAccount.no') : value || '—'}</dd></div>)}
                            {!Object.keys(details.fields).length && <p className="py-3 text-sm text-muted-foreground">{t('storageAccount.empty')}</p>}
                        </dl></section>
                        <section><h4 className="mb-2 flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4 shrink-0" />{t('storageAccount.credentials')}</h4><p className="mb-3 text-xs leading-5 text-muted-foreground">{t('storageAccount.privacy')}</p><dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">{Object.entries(details.secrets).map(([key, present]) => <div key={key} className="flex min-w-0 flex-wrap justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs"><dt className="min-w-0">{t(`storageAccount.fields.${key}`)}</dt><dd className="min-w-0 font-medium">{t(present ? 'storageAccount.configured' : 'storageAccount.notConfigured')}</dd></div>)}</dl></section>
                        <dl className="space-y-2 border-t border-border pt-4 text-xs text-muted-foreground"><div><dt>{t('storageAccount.id')}</dt><dd className="mt-1 [overflow-wrap:anywhere]">{details.id}</dd></div>{(['createdAt', 'updatedAt'] as const).map(key => <div key={key}><dt>{t(`storageAccount.${key}`)}</dt><dd>{details[key] ? formatDateTime(details[key], i18n.resolvedLanguage || i18n.language) : '—'}</dd></div>)}</dl>
                    </>}
                </div>
            </div>
        </Dialog>
    </>;
}
