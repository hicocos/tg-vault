import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';
import { Copy, Network, Plus, RefreshCw, Shield, X } from '../ui/icons';
import { SettingsField, SettingsRow, SettingsSection, SettingsWorkspace } from './SettingsPresentation';
import { mcpClient, type McpAuditEntry, type McpClientRecord, type McpConfiguration, type McpConnectionResult } from '../../services/clients/mcpClient';
import { errorMessage } from '../../services/unknownError';
import { formatDateTime } from '../../i18n/format';
import './mcp-settings.css';

interface ClientDraft { name: string; permissions: string[]; storageIds: string[]; expiresAt: string }
const PAGE_SIZE = 25;

function localDateTime(value: string): string {
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function McpSettings() {
    const { t } = useTranslation();
    const [config, setConfig] = useState<McpConfiguration | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [editing, setEditing] = useState<McpClientRecord | 'new' | null>(null);
    const [draft, setDraft] = useState<ClientDraft>({ name: '', permissions: [], storageIds: [], expiresAt: '' });
    const [editorError, setEditorError] = useState<string | null>(null);
    const [revoke, setRevoke] = useState<McpClientRecord | null>(null);
    const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
    const [verifyToken, setVerifyToken] = useState('');
    const [verification, setVerification] = useState<McpConnectionResult | null>(null);
    const [audit, setAudit] = useState<{ items: McpAuditEntry[]; total: number } | null>(null);
    const [offset, setOffset] = useState(0);
    const [auditEpoch, setAuditEpoch] = useState(0);
    const [auditError, setAuditError] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        let active = true;
        void mcpClient.getConfiguration().then(value => { if (active) setConfig(value); }).catch(cause => { if (active) setError(errorMessage(cause)); });
        return () => { active = false; };
    }, []);

    useEffect(() => {
        let active = true;
        setAudit(null); setAuditError(null);
        void mcpClient.listAudit(offset, PAGE_SIZE).then(value => { if (active) setAudit(value); }).catch(cause => { if (active) setAuditError(errorMessage(cause)); });
        return () => { active = false; };
    }, [offset, auditEpoch]);

    const reload = async () => {
        setBusy('reload'); setError(null);
        try { setConfig(await mcpClient.getConfiguration()); setAuditEpoch(value => value + 1); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(null); }
    };
    const toggle = async () => {
        if (!config || busy) return;
        setBusy('toggle'); setError(null); setNotice(null);
        try {
            await mcpClient.setEnabled(!config.enabled);
            setConfig(await mcpClient.getConfiguration());
            setVerification(null);
        } catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(null); }
    };
    const openEditor = (client: McpClientRecord | 'new') => {
        setEditing(client); setEditorError(null); setError(null); setNotice(null);
        setDraft(client === 'new'
            ? { name: '', permissions: [], storageIds: [], expiresAt: localDateTime(new Date(Date.now() + 30 * 86400_000).toISOString()) }
            : { name: client.name, permissions: [...client.permissions], storageIds: [...client.storageIds], expiresAt: localDateTime(client.expiresAt) });
    };
    const save = async () => {
        if (!editing || busy) return;
        if (!draft.permissions.length || !draft.storageIds.length) { setEditorError(t('mcp.chooseScope')); return; }
        if (new Date(draft.expiresAt).getTime() <= Date.now()) { setEditorError(t('mcp.futureExpiry')); return; }
        setBusy('save'); setEditorError(null);
        try {
            const input = { ...draft, name: draft.name.trim(), expiresAt: new Date(draft.expiresAt).toISOString() };
            if (editing === 'new') {
                const result = await mcpClient.createClient(input);
                setIssued({ name: result.client.name, token: result.token });
            } else {
                await mcpClient.updateClient(editing.id, input);
            }
            setEditing(null);
            setConfig(await mcpClient.getConfiguration());
            setNotice(t('mcp.saved'));
        } catch (cause) { setEditorError(errorMessage(cause)); setError(errorMessage(cause)); }
        finally { setBusy(null); }
    };
    const revokeClient = async () => {
        if (!revoke || busy) return;
        setBusy('revoke'); setError(null);
        try {
            await mcpClient.revokeClient(revoke.id);
            setRevoke(null); setVerification(null);
            setConfig(await mcpClient.getConfiguration());
            setNotice(t('mcp.revokedNotice'));
        } catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(null); }
    };
    const verify = async () => {
        if (busy) return;
        setBusy('verify'); setError(null); setVerification(null);
        const token = verifyToken.trim();
        setVerifyToken('');
        try { setVerification(await mcpClient.verify(token)); setAuditEpoch(value => value + 1); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(null); }
    };
    const copy = async (text: string) => {
        try { await navigator.clipboard.writeText(text); setNotice(t('mcp.copied')); }
        catch { setError(t('mcp.copyFailed')); }
    };
    const permissionLabel = (permission: string) => t(`mcp.permission.${permission.replace(':', '_')}`, { defaultValue: permission });
    const storageLabel = (id: string) => config?.storages.find(storage => storage.id === id)?.name || id;
    const visibleClients = config ? config.clients.filter(client => !client.revokedAt) : [];
    const configText = config ? `[mcp_servers.tg_vault]\nurl = ${JSON.stringify(config.endpoint)}\nbearer_token_env_var = "TG_VAULT_MCP_TOKEN"` : '';
    const checked = (key: 'permissions' | 'storageIds', value: string, enabled: boolean) => setDraft(previous => ({ ...previous, [key]: enabled ? [...previous[key], value] : previous[key].filter(item => item !== value) }));

    return <SettingsWorkspace guide={null} className="mcp-settings">
        {error && <div className="mcp-feedback is-error" role="alert">{error}{!config && <Button variant="outline" disabled={busy !== null} onClick={() => void reload()}>{t('mcp.reload')}</Button>}</div>}
        {notice && <p className="mcp-feedback" role="status">{notice}</p>}
        {!config && !error && <IndeterminateSpinner label={t('mcp.loading')} />}
        {config && <>
            <SettingsSection title={t('mcp.title')} sectionId="mcp">
                <SettingsRow icon={Network} label={t('mcp.enabled')} description={t('mcp.description')} stackActionOnMobile={false} action={
                    <button type="button" role="switch" aria-label={t('mcp.enabled')} aria-checked={config.enabled} disabled={busy !== null} className="settings-switch-target" onClick={() => void toggle()}>
                        <span aria-hidden="true" className={`settings-switch-track${config.enabled ? ' is-enabled' : ''}`}><span /></span>
                    </button>
                } />
                {!config.enabled && <p className="mcp-help">{t('mcp.disabledHint')}</p>}
                <div className="mcp-connection">
                    <SettingsField label={t('mcp.endpoint')}><input readOnly value={config.endpoint} spellCheck={false} /></SettingsField>
                    <Button variant="outline" onClick={() => void copy(config.endpoint)}><Copy size={16} aria-hidden="true" />{t('mcp.copyEndpoint')}</Button>
                </div>
                <details className="mcp-instructions"><summary>{t('mcp.codex')}</summary>
                    <p>{t('mcp.codexHelp')}</p><pre><code>{configText}</code></pre>
                    <Button variant="outline" onClick={() => void copy(configText)}><Copy size={16} aria-hidden="true" />{t('mcp.copyConfig')}</Button>
                    <p>{t('mcp.tokenEnvironment')}</p>
                </details>
            </SettingsSection>

            <SettingsSection title={t('mcp.clients')} actions={<Button disabled={busy !== null} onClick={() => openEditor('new')}><Plus size={16} aria-hidden="true" />{t('mcp.create')}</Button>}>
                <p className="mcp-help">{t('mcp.clientsHelp')}</p>
                {!visibleClients.length && <p className="mcp-empty">{t('mcp.noClients')}</p>}
                <div className="mcp-client-list">{visibleClients.map(client => {
                    const state = new Date(client.expiresAt).getTime() <= now ? 'expired' : 'active';
                    return <article key={client.id} className="mcp-client">
                        <header><h4>{client.name}</h4><span className={`mcp-state is-${state}`}>{t(`mcp.${state}`)}</span></header>
                        <dl>
                            <div><dt>{t('mcp.permissions')}</dt><dd>{client.permissions.map(permissionLabel).join(' · ')}</dd></div>
                            <div><dt>{t('mcp.storages')}</dt><dd>{client.storageIds.map(storageLabel).join(' · ')}</dd></div>
                            <div><dt>{t('mcp.expires')}</dt><dd>{formatDateTime(client.expiresAt)}</dd></div>
                            <div><dt>{t('mcp.lastUsed')}</dt><dd>{client.lastUsedAt ? formatDateTime(client.lastUsedAt) : t('mcp.never')}</dd></div>
                        </dl>
                        <div className="mcp-actions"><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => openEditor(client)}>{t('mcp.edit')}</Button><Button variant="destructive-outline" size="sm" disabled={busy !== null} onClick={() => { setError(null); setRevoke(client); }}>{t('mcp.revoke')}</Button></div>
                    </article>;
                })}</div>
            </SettingsSection>

            <SettingsSection title={t('mcp.verify')}>
                <p className="mcp-help">{t('mcp.verifyHelp')}</p>
                <form className="mcp-connection" onSubmit={event => { event.preventDefault(); void verify(); }}>
                    <SettingsField label={t('mcp.token')}><input type="password" autoComplete="off" required value={verifyToken} onChange={event => { setVerifyToken(event.target.value); setVerification(null); }} spellCheck={false} /></SettingsField>
                    <Button type="submit" variant="outline" disabled={!config.enabled || !verifyToken.trim() || busy !== null}><Shield size={16} aria-hidden="true" />{t(busy === 'verify' ? 'mcp.verifying' : 'mcp.verify')}</Button>
                </form>
                {verification && <div className="mcp-feedback" role="status"><p>{t('mcp.verified', { name: verification.server.name, version: verification.server.version, count: verification.toolCount })}</p><p>{t('mcp.storages')}: {verification.storages.map(storage => storage.name).join(' · ')}</p></div>}
            </SettingsSection>
        </>}

        <SettingsSection title={t('mcp.audit')} actions={<Button size="sm" variant="outline" onClick={() => setAuditEpoch(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />{t('mcp.refresh')}</Button>}>
            {auditError && <p className="mcp-feedback is-error" role="alert">{auditError}</p>}
            {!audit && !auditError && <IndeterminateSpinner label={t('mcp.loading')} />}
            {audit && <>
                {!audit.items.length ? <p className="mcp-empty">{t('mcp.noAudit')}</p> : <div className="mcp-audit-scroll" tabIndex={0} role="region" aria-label={t('mcp.audit')}><table className="mcp-audit"><thead><tr>{['time', 'client', 'tool', 'storage', 'result', 'duration'].map(key => <th key={key} scope="col">{t(`mcp.${key}`)}</th>)}</tr></thead><tbody>{audit.items.map(entry => <tr key={entry.id}><td>{formatDateTime(entry.createdAt)}</td><td>{entry.clientName || t('mcp.unknownClient')}</td><td><code>{entry.tool}</code></td><td>{entry.storageId ? storageLabel(entry.storageId) : '—'}</td><td>{t(`mcp.auditStatus.${entry.status}`, { defaultValue: entry.status })}{entry.code && <small>{entry.code}</small>}</td><td>{entry.durationMs} ms</td></tr>)}</tbody></table></div>}
                <div className="mcp-pagination"><span>{t('mcp.page', { page: Math.floor(offset / PAGE_SIZE) + 1, count: audit.total })}</span><Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}>{t('mcp.previous')}</Button><Button variant="outline" size="sm" disabled={offset + PAGE_SIZE >= audit.total} onClick={() => setOffset(value => value + PAGE_SIZE)}>{t('mcp.next')}</Button></div>
            </>}
        </SettingsSection>

        {editing && config && <Dialog open onClose={() => { if (!busy) setEditing(null); }} labelledBy="mcp-client-title" closeOnEscape={!busy} closeOnBackdrop={!busy} className="mcp-dialog">
            <header><h2 id="mcp-client-title">{t(editing === 'new' ? 'mcp.create' : 'mcp.editClient')}</h2><Button size="icon" variant="ghost" disabled={busy !== null} aria-label={t('mcp.close')} onClick={() => setEditing(null)}><X size={20} aria-hidden="true" /></Button></header>
            <form onSubmit={event => { event.preventDefault(); void save(); }}><div className="mcp-dialog-body"><fieldset disabled={busy !== null}>
                <SettingsField label={t('mcp.name')}><input required maxLength={100} value={draft.name} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} /></SettingsField>
                <SettingsField label={t('mcp.expires')}><input type="datetime-local" required value={draft.expiresAt} onChange={event => setDraft(previous => ({ ...previous, expiresAt: event.target.value }))} /><span className="mcp-help">{t('mcp.expiryHelp')}</span></SettingsField>
                <fieldset className="mcp-options"><legend>{t('mcp.permissions')}</legend>{config.permissions.map(permission => <label key={permission}><input type="checkbox" checked={draft.permissions.includes(permission)} onChange={event => checked('permissions', permission, event.target.checked)} /><span>{permissionLabel(permission)}<small>{permission}</small></span></label>)}</fieldset>
                <fieldset className="mcp-options"><legend>{t('mcp.storages')}</legend>{config.storages.map(storage => <label key={storage.id}><input type="checkbox" checked={draft.storageIds.includes(storage.id)} onChange={event => checked('storageIds', storage.id, event.target.checked)} /><span>{storage.name}<small>{storage.provider} · {storage.id}</small></span></label>)}</fieldset>
            </fieldset>{editorError && <p role="alert" className="mcp-feedback is-error">{editorError}</p>}</div><footer><Button variant="outline" type="button" disabled={busy !== null} onClick={() => setEditing(null)}>{t('mcp.cancel')}</Button><Button type="submit" disabled={busy !== null || !draft.name.trim() || !draft.permissions.length || !draft.storageIds.length}>{t(busy === 'save' ? 'mcp.saving' : 'mcp.save')}</Button></footer></form>
        </Dialog>}

        {issued && <Dialog open onClose={() => setIssued(null)} labelledBy="mcp-token-title" describedBy="mcp-token-help" closeOnBackdrop={false} className="mcp-dialog">
            <header><h2 id="mcp-token-title">{t('mcp.tokenCreated', { name: issued.name })}</h2></header><div className="mcp-dialog-body"><p id="mcp-token-help">{t('mcp.tokenOnce')}</p><SettingsField label={t('mcp.token')}><textarea readOnly rows={3} spellCheck={false} value={issued.token} /></SettingsField><Button variant="outline" onClick={() => void copy(issued.token)}><Copy size={16} aria-hidden="true" />{t('mcp.copyToken')}</Button>{notice && <p role="status">{notice}</p>}{error && <p className="mcp-feedback is-error" role="alert">{error}</p>}<p className="mcp-help">{t('mcp.tokenEnvironment')}</p></div><footer><Button onClick={() => setIssued(null)}>{t('mcp.tokenSaved')}</Button></footer>
        </Dialog>}

        {revoke && <Dialog open alert onClose={() => { if (!busy) setRevoke(null); }} labelledBy="mcp-revoke-title" describedBy="mcp-revoke-help" closeOnEscape={!busy} closeOnBackdrop={!busy} className="mcp-dialog">
            <header><h2 id="mcp-revoke-title">{t('mcp.revokeTitle')}</h2></header><div className="mcp-dialog-body"><p id="mcp-revoke-help">{t('mcp.revokeHelp', { name: revoke.name })}</p>{error && <p className="mcp-feedback is-error" role="alert">{error}</p>}</div><footer><Button variant="outline" disabled={busy !== null} onClick={() => setRevoke(null)}>{t('mcp.cancel')}</Button><Button variant="destructive" disabled={busy !== null} onClick={() => void revokeClient()}>{t('mcp.revoke')}</Button></footer>
        </Dialog>}
    </SettingsWorkspace>;
}
