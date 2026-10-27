import { useTranslation } from 'react-i18next';
import type { StorageAccount } from '../../services/api';
import type { QbSettings } from '../../services/clients/qbittorrentClient';
import { SettingsField } from './SettingsPresentation';

type Target = Pick<QbSettings, 'targetAccountId' | 'targetFolder' | 'preserveLocalFiles'>;
export function QbittorrentTargetFields({ value, accounts, onChange, disabled = false }: {
    value: Target;
    accounts: StorageAccount[];
    onChange: (patch: Partial<Target>) => void;
    disabled?: boolean;
}) {
    const { t } = useTranslation();
    return <>
        <div className="qb-form-grid">
            <SettingsField label={t('qbittorrent.targetAccount')}><select value={value.targetAccountId} disabled={disabled} onChange={event => onChange({ targetAccountId: event.target.value })}>
                <option value="local">{t('qbittorrent.local')}</option>
                {accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.type}</option>)}
                {value.targetAccountId !== 'local' && !accounts.some(account => account.id === value.targetAccountId) && <option value={value.targetAccountId}>{value.targetAccountId}</option>}
            </select></SettingsField>
            <SettingsField label={t('qbittorrent.targetFolder')}><input required value={value.targetFolder} disabled={disabled} onChange={event => onChange({ targetFolder: event.target.value })} /></SettingsField>
        </div>
        <label className="qb-checkbox"><input type="checkbox" checked={value.preserveLocalFiles} disabled={disabled} onChange={event => onChange({ preserveLocalFiles: event.target.checked })} /><span>{t('qbittorrent.preserve')}</span></label>
        <p className="settings-help">{t('qbittorrent.cleanupDefault')}</p>
    </>;
}
