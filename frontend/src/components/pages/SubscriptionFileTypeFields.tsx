import { useTranslation } from 'react-i18next';
import { TELEGRAM_SUBSCRIPTION_FILE_TYPES, type TelegramSubscriptionFileFilterMode, type TelegramSubscriptionFileType } from '../../services/apiTypes';
import { Button } from '../ui/Button';

export function SubscriptionFileTypeFields({ mode, types, disabled, onModeChange, onTypesChange }: {
    mode: TelegramSubscriptionFileFilterMode;
    types: TelegramSubscriptionFileType[];
    disabled?: boolean;
    onModeChange: (mode: TelegramSubscriptionFileFilterMode) => void;
    onTypesChange: (types: TelegramSubscriptionFileType[]) => void;
}) {
    const { t } = useTranslation();
    return <fieldset className="min-w-0 space-y-3" disabled={disabled}>
        <label className="op-field"><span>{t('subscriptionCenter.fileTypes.mode')}</span><select className="tv-field op-input" value={mode} onChange={event => onModeChange(event.target.value as TelegramSubscriptionFileFilterMode)}>
            {(['all', 'include', 'exclude'] as const).map(value => <option key={value} value={value}>{t(`subscriptionCenter.fileTypes.modes.${value}`)}</option>)}
        </select></label>
        {mode !== 'all' && <>
            <div className="op-actions"><Button type="button" size="sm" variant="outline" onClick={() => onTypesChange([...TELEGRAM_SUBSCRIPTION_FILE_TYPES])}>{t('subscriptionCenter.fileTypes.selectAll')}</Button><Button type="button" size="sm" variant="outline" onClick={() => onTypesChange([])}>{t('subscriptionCenter.fileTypes.clear')}</Button></div>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('subscriptionCenter.fileTypes.categories')}>
                {TELEGRAM_SUBSCRIPTION_FILE_TYPES.map(fileType => <label key={fileType} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border p-3 text-sm">
                    <input type="checkbox" className="h-4 w-4 shrink-0" checked={types.includes(fileType)} onChange={event => onTypesChange(event.target.checked ? [...types, fileType] : types.filter(value => value !== fileType))} />
                    <span className="min-w-0 break-words">{t(`subscriptionCenter.fileTypes.types.${fileType}`)}</span>
                </label>)}
            </div>
            {!types.length && <p className="op-help" role="status">{t('subscriptionCenter.fileTypes.required')}</p>}
        </>}
        <p className="op-help">{t(mode === 'all' ? 'subscriptionCenter.fileTypes.defaultHint' : 'subscriptionCenter.fileTypes.explicitHint')}</p>
        <p className="op-help">{t('subscriptionCenter.fileTypes.noRecords')}</p>
    </fieldset>;
}
