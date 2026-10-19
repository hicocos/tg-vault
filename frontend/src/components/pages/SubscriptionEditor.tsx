import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import fileApi from '../../services/api';
import type { StorageAccount, TelegramAdFilterMode, TelegramSubscription, TelegramSubscriptionConfig, TelegramSubscriptionFileFilterMode, TelegramSubscriptionFileType } from '../../services/apiTypes';
import { errorMessage } from '../../services/unknownError';
import { isUnauthorizedError } from '../../services/apiActionError';
import { SubscriptionFileTypeFields } from './SubscriptionFileTypeFields';

const PROVIDERS: Record<string, string> = {
    google_drive: 'Google Drive', onedrive: 'OneDrive', s3: 'S3', aliyun_oss: 'OSS', webdav: 'WebDAV', openlist: 'OpenList',
};

export function SubscriptionEditor({ target, onClose, onSaved, onUnauthorized }: {
    target: TelegramSubscription | null;
    onClose: () => void;
    onSaved: (subscription: TelegramSubscription) => Promise<void>;
    onUnauthorized?: () => void;
}) {
    const { t } = useTranslation();
    const [source, setSource] = useState(target?.source_original || target?.source || '');
    const [userId, setUserId] = useState(String(target?.user_id || ''));
    const [folder, setFolder] = useState(target?.folder_override || '');
    const [destination, setDestination] = useState(target?.target_mode === 'fixed' ? target.target_account_id || (target.target_provider === 'local' ? 'local' : '') : 'follow_global');
    const [mode, setMode] = useState<TelegramAdFilterMode>(target?.ad_filter_mode || 'off');
    const [fileFilterMode, setFileFilterMode] = useState<TelegramSubscriptionFileFilterMode>(target?.file_filter_mode || 'all');
    const [fileFilterTypes, setFileFilterTypes] = useState<TelegramSubscriptionFileType[]>(target?.file_filter_types || []);
    const [recipients, setRecipients] = useState<Array<{ userId: string }>>([]);
    const [accounts, setAccounts] = useState<StorageAccount[]>([]);
    const [loading, setLoading] = useState(true);
    const [optionsReady, setOptionsReady] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const lock = useRef(false);
    const [attempt, setAttempt] = useState(0);
    const creating = target === null;

    useEffect(() => {
        let live = true;
        setLoading(true); setOptionsReady(false); setError(null);
        void Promise.all([fileApi.getAccounts(), creating ? fileApi.getSubscriptionOptions() : Promise.resolve({ recipients: [] })])
            .then(([storage, options]) => {
                if (!live) return;
                setAccounts(storage); setRecipients(options.recipients);
                if (creating) setUserId(current => options.recipients.some(recipient => recipient.userId === current) ? current : options.recipients[0]?.userId || '');
                setOptionsReady(true);
                setLoading(false);
            }).catch(caught => {
                if (!live) return;
                if (isUnauthorizedError(caught)) onUnauthorized?.();
                setError(errorMessage(caught, t('subscriptionCenter.editor.loadFailed')));
                setLoading(false);
            });
        return () => { live = false; };
    }, [attempt, creating, onUnauthorized, t]);

    const account = accounts.find(item => item.id === destination);
    const destinationAvailable = destination === 'follow_global' || destination === 'local' || !!account;
    const ready = optionsReady && !loading && destinationAvailable && (fileFilterMode === 'all' || fileFilterTypes.length > 0)
        && (!creating || (!!source.trim() && recipients.some(recipient => recipient.userId === userId)));
    const close = () => { if (!lock.current) onClose(); };
    const save = async () => {
        if (lock.current || !ready) return;
        lock.current = true; setSaving(true); setError(null);
        const config: TelegramSubscriptionConfig = {
            folderOverride: folder.trim() || null,
            targetMode: destination === 'follow_global' ? 'follow_global' : 'fixed',
            targetProvider: destination === 'local' ? 'local' : account?.type || null,
            targetAccountId: account?.id || null,
            adFilterMode: mode,
            fileFilterMode,
            fileFilterTypes: fileFilterMode === 'all' ? [] : fileFilterTypes,
        };
        try {
            const subscription = target
                ? await fileApi.updateSubscriptionConfig(target.id, config)
                : await fileApi.createSubscription({ ...config, source: source.trim(), userId });
            await onSaved(subscription);
        } catch (caught) {
            if (isUnauthorizedError(caught)) onUnauthorized?.();
            setError(errorMessage(caught, t('subscriptionCenter.editor.saveFailed')));
        } finally { lock.current = false; setSaving(false); }
    };

    return <Dialog open onClose={close} labelledBy="subscription-editor-title" describedBy="subscription-editor-description" closeOnEscape={!saving} closeOnBackdrop={!saving} className="w-full max-w-xl">
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
            <div className="tv-modal-header"><div className="tv-modal-heading">
                <h3 id="subscription-editor-title" className="tv-modal-title">{t(creating ? 'subscriptionCenter.editor.add' : 'subscriptionCenter.editor.edit')}</h3>
                <p id="subscription-editor-description" className="tv-modal-description">{t(creating ? 'subscriptionCenter.editor.createHint' : 'subscriptionCenter.editor.editHint')}</p>
            </div></div>
            <div className="tv-modal-body space-y-4">
                <label className="op-field"><span>{t('subscriptionCenter.editor.source')}</span><input className="tv-field op-input" value={source} onChange={event => setSource(event.target.value)} placeholder="https://t.me/channel" required readOnly={!creating} disabled={saving} /></label>
                {creating ? <label className="op-field"><span>{t('subscriptionCenter.editor.recipient')}</span><select className="tv-field op-input" value={userId} onChange={event => setUserId(event.target.value)} disabled={saving || loading} required>
                    {!recipients.length && <option value="">{t('subscriptionCenter.editor.noRecipients')}</option>}
                    {recipients.map(recipient => <option key={recipient.userId} value={recipient.userId}>{recipient.userId}</option>)}
                </select><small className="op-help">{t('subscriptionCenter.editor.recipientHint')}</small></label> : <p className="op-help">{t('subscriptionCenter.editor.owner', { userId })}</p>}
                {creating && !loading && recipients.length === 0 && <p className="op-help">{t('subscriptionCenter.editor.recipientRequired')} <a className="underline" href="/settings/telegram">{t('subscriptionCenter.editor.connectionSettings')}</a></p>}
                <label className="op-field"><span>{t('subscriptionCenter.editor.destination')}</span><select className="tv-field op-input" value={destination} onChange={event => setDestination(event.target.value)} disabled={saving || loading} required>
                    <option value="follow_global">{t('subscriptionCenter.editor.followGlobal')}</option>
                    <option value="local">{t('subscriptionCenter.editor.local')}</option>
                    {accounts.filter(item => item.type !== 'local').map(item => <option key={item.id} value={item.id}>{PROVIDERS[item.type] || item.type} / {item.name}</option>)}
                    {!destinationAvailable && <option value={destination} disabled>{t('subscriptionCenter.editor.destinationMissing')}</option>}
                </select><small className="op-help">{t('subscriptionCenter.editor.destinationHint')}</small></label>
                <label className="op-field"><span>{t('subscriptionCenter.editor.folder')}</span><input className="tv-field op-input" value={folder} onChange={event => setFolder(event.target.value)} placeholder={t('subscriptionCenter.editor.folderPlaceholder')} disabled={saving} /><small className="op-help">{t('subscriptionCenter.editor.folderHint')}</small></label>
                <label className="op-field"><span>{t('subscriptionCenter.editor.filter')}</span><select className="tv-field op-input" value={mode} onChange={event => setMode(event.target.value as TelegramAdFilterMode)} disabled={saving}>
                    {(['off', 'conservative', 'aggressive'] as const).map(value => <option key={value} value={value}>{t(`subscriptionCenter.filterModes.${value}.label`)}</option>)}
                </select></label>
                <div className="space-y-3"><h4 className="font-semibold">{t('subscriptionCenter.fileTypes.title')}</h4><SubscriptionFileTypeFields mode={fileFilterMode} types={fileFilterTypes} disabled={saving} onModeChange={setFileFilterMode} onTypesChange={setFileFilterTypes} /></div>
                {loading && <p role="status" className="op-help">{t('subscriptionCenter.loading')}</p>}
                {error && <div role="alert" className="op-notice op-notice--danger"><span>{error}</span><Button variant="outline" size="sm" type="button" disabled={saving || loading} onClick={() => setAttempt(current => current + 1)}>{t('subscriptionCenter.refresh')}</Button></div>}
            </div>
            <div className="tv-modal-footer">
                <Button variant="outline" type="button" disabled={saving} onClick={close}>{t('common.actions.cancel')}</Button>
                <Button type="submit" disabled={!ready || saving}>{t(saving ? 'subscriptionCenter.editor.saving' : creating ? 'subscriptionCenter.editor.create' : 'subscriptionCenter.editor.save')}</Button>
            </div>
        </form>
    </Dialog>;
}
