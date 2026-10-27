import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Download, RefreshCw, Settings, X } from '../ui/icons';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';
import { qbittorrentClient, qbDefaults } from '../../services/clients/qbittorrentClient';
import type { QbConfig, QbSettings, QbTestResult } from '../../services/clients/qbittorrentClient';
import { errorMessage } from '../../services/unknownError';
import { SettingsField, SettingsRow, SettingsSection } from './SettingsPresentation';
import './qbittorrent-settings.css';

type ConnectionDraft = Pick<QbSettings, 'apiUrl' | 'username' | 'downloadDir'>;

export function QbittorrentSettings() {
    const { t } = useTranslation();
    const [config, setConfig] = useState<QbConfig | null>(null);
    const [draft, setDraft] = useState<ConnectionDraft>({ apiUrl: qbDefaults.apiUrl, username: qbDefaults.username, downloadDir: qbDefaults.downloadDir });
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState<'toggle' | 'save' | 'test' | null>(null);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [test, setTest] = useState<QbTestResult | null>(null);
    const apply = (next: QbConfig) => {
        setConfig(next);
        if (next.enabled) {
            const { apiUrl, username, downloadDir } = next;
            setDraft({ apiUrl, username, downloadDir });
        }
        setPassword('');
    };
    useEffect(() => {
        let active = true;
        void qbittorrentClient.getConfig().then(next => { if (active) apply(next); }).catch(cause => { if (active) setError(errorMessage(cause)); });
        return () => { active = false; };
    }, []);
    const patch = (value: Partial<ConnectionDraft>) => {
        setDraft(previous => ({ ...previous, ...value })); setSaved(false); setTest(null);
    };
    const toggle = async (enabled: boolean) => {
        if (busy) return;
        setBusy('toggle'); setError(null);
        try { apply(await qbittorrentClient.saveConfig({ enabled })); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(null); }
    };
    const configInput = { ...draft, ...(password ? { password } : {}) };
    const save = async () => {
        if (busy) return;
        setBusy('save'); setError(null); setSaved(false); setTest(null);
        try { apply(await qbittorrentClient.saveConfig(configInput)); setSaved(true); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(null); }
    };
    const runTest = async () => {
        if (busy) return;
        setBusy('test'); setError(null); setTest(null);
        try { setTest(await qbittorrentClient.test(configInput)); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(null); }
    };
    const closeEditor = () => {
        if (busy) return;
        setOpen(false); setPassword(''); setError(null); setSaved(false); setTest(null);
    };
    return <SettingsSection title={t('qbittorrent.extension')} className="qb-extension-settings" sectionId="qbittorrent">
        <SettingsRow icon={Download} label={t('qbittorrent.enabled')} stackActionOnMobile={false} action={
            <div className="qb-extension-controls">
                {config?.enabled && <Button variant="outline" className="qb-config-trigger" disabled={busy !== null} onClick={() => {
                    const { apiUrl, username, downloadDir } = config;
                    setDraft({ apiUrl, username, downloadDir }); setPassword(''); setError(null); setSaved(false); setTest(null); setOpen(true);
                }}><Settings size={16} aria-hidden="true" />{t('qbittorrent.configure')}</Button>}
                <button type="button" role="switch" aria-label={t('qbittorrent.enabled')} aria-checked={config?.enabled ?? false} disabled={busy !== null || !config} className="settings-switch-target" onClick={() => void toggle(!config?.enabled)}>
                    <span aria-hidden="true" className={`settings-switch-track qb-extension-switch${config?.enabled ? ' is-enabled' : ''}`}><span /></span>
                </button>
            </div>
        } />
        {!open && error && <div className="qb-extension-feedback" role="alert"><span>{error}</span>{!config && <Button variant="outline" onClick={() => { setError(null); void qbittorrentClient.getConfig().then(apply).catch(cause => setError(errorMessage(cause))); }}>{t('qbittorrent.reload')}</Button>}</div>}
        {!config && !error && <div className="qb-extension-feedback"><IndeterminateSpinner label={t('qbittorrent.loading')} /></div>}
        {busy === 'toggle' && <p className="qb-extension-feedback" role="status">{t('qbittorrent.updating')}</p>}
        {open && config?.enabled && <Dialog open onClose={closeEditor} labelledBy="qb-connection-title" describedBy="qb-connection-description" closeOnEscape={!busy} closeOnBackdrop={!busy} className="qb-connection-dialog">
            <header className="qb-connection-header"><div><h2 id="qb-connection-title">{t('qbittorrent.connectionTitle')}</h2><p id="qb-connection-description">{t('qbittorrent.sameServer')}</p></div><Button size="icon" variant="ghost" disabled={busy !== null} aria-label={t('qbittorrent.close')} onClick={closeEditor}><X size={20} aria-hidden="true" /></Button></header>
            <form onSubmit={event => { event.preventDefault(); void save(); }}>
                <div className="qb-connection-scroll"><fieldset disabled={busy !== null}>
                    <SettingsField label={t('qbittorrent.apiUrl')}><input name="apiUrl" type="url" required value={draft.apiUrl} placeholder="http://127.0.0.1:8080" autoCapitalize="none" spellCheck={false} onChange={event => patch({ apiUrl: event.target.value })} /></SettingsField>
                    <SettingsField label={t('qbittorrent.username')}><input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={draft.username} onChange={event => patch({ username: event.target.value })} /></SettingsField>
                    <SettingsField label={t('qbittorrent.password')}><input name="password" type="password" autoComplete="new-password" value={password} placeholder={config.hasPassword ? t('qbittorrent.savedPassword') : ''} onChange={event => { setPassword(event.target.value); setSaved(false); setTest(null); }} /></SettingsField>
                    <SettingsField label={t('qbittorrent.downloadDir')}><input name="downloadDir" required value={draft.downloadDir} autoCapitalize="none" spellCheck={false} onChange={event => patch({ downloadDir: event.target.value })} /></SettingsField>
                    <Button type="button" variant="outline" className="qb-connection-test" onClick={event => { if (event.currentTarget.form?.reportValidity()) void runTest(); }}>{busy === 'test' ? <IndeterminateSpinner label={t('qbittorrent.testing')} size="sm" /> : <RefreshCw size={16} aria-hidden="true" />}{t(busy === 'test' ? 'qbittorrent.testing' : 'qbittorrent.test')}</Button>
                </fieldset>
                {test && <div className="qb-connection-results" role="status">{(['api', 'directory'] as const).map(key => <div key={key} className={test[key].ok ? 'is-success' : 'is-error'}><strong>{t(key === 'api' ? 'qbittorrent.apiTest' : 'qbittorrent.directoryTest')}: </strong>{t(test[key].ok ? 'qbittorrent.success' : 'qbittorrent.failed')}{key === 'api' && test.api.version ? ` · ${test.api.version}` : ''}{test[key].error ? ` · ${test[key].error}` : ''}</div>)}</div>}
                </div>
                {error && <p className="qb-connection-feedback is-error" role="alert">{error}</p>}
                {saved && <p className="qb-connection-feedback is-success" role="status">{t('qbittorrent.saved')}</p>}
                <footer className="qb-connection-footer"><Button type="button" variant="outline" disabled={busy !== null} onClick={closeEditor}>{t('qbittorrent.close')}</Button><Button type="submit" disabled={busy !== null}>{busy === 'save' ? <IndeterminateSpinner label={t('qbittorrent.saving')} size="sm" /> : <Check size={16} aria-hidden="true" />}{t(busy === 'save' ? 'qbittorrent.saving' : 'qbittorrent.save')}</Button></footer>
            </form>
        </Dialog>}
    </SettingsSection>;
}
