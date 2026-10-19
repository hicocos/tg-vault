import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import type { TelegramSubscription } from '../../services/apiTypes';
import { SubscriptionFileTypeFields } from './SubscriptionFileTypeFields';

export function SubscriptionFileTypeSettings({ subscription, disabled, onSave }: {
    subscription: TelegramSubscription;
    disabled: boolean;
    onSave: (mode: TelegramSubscription['file_filter_mode'], types: TelegramSubscription['file_filter_types']) => Promise<void>;
}) {
    const { t } = useTranslation();
    const [mode, setMode] = useState(subscription.file_filter_mode);
    const [types, setTypes] = useState(subscription.file_filter_types);
    const [saving, setSaving] = useState(false);
    const lock = useRef(false);
    const changed = mode !== subscription.file_filter_mode || (mode !== 'all' && (types.length !== subscription.file_filter_types.length || types.some(value => !subscription.file_filter_types.includes(value))));
    const valid = mode === 'all' || types.length > 0;
    return <section className="tv-panel op-panel" aria-label={t('subscriptionCenter.fileTypes.title')}>
        <div className="op-section-heading"><div><h2>{t('subscriptionCenter.fileTypes.title')}</h2><p>{t('subscriptionCenter.fileTypes.description')}</p></div></div>
        <form className="space-y-4" onSubmit={event => {
            event.preventDefault();
            if (lock.current || disabled || !valid || !changed) return;
            lock.current = true; setSaving(true);
            void onSave(mode, mode === 'all' ? [] : types).finally(() => { lock.current = false; setSaving(false); });
        }}>
            <SubscriptionFileTypeFields mode={mode} types={types} disabled={disabled || saving} onModeChange={setMode} onTypesChange={setTypes} />
            <Button type="submit" disabled={disabled || saving || !valid || !changed}>{t(saving ? 'subscriptionCenter.editor.saving' : 'subscriptionCenter.fileTypes.save')}</Button>
        </form>
    </section>;
}
