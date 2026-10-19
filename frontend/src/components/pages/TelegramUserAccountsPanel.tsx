import { formatDateTime } from '../../i18n/format';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CheckCircle2, KeyRound, LoaderCircle, Plus, Power, PowerOff, RefreshCw, Server, ShieldAlert, ShieldCheck, Trash2, UserRound, X } from '../ui/icons';
import { QRCodeSVG } from 'qrcode.react';
import { fileApi, type TelegramUserAccount, type TelegramUserAccountsOverview, type TelegramUserLoginStatus } from '../../services/api';
import { errorMessage } from '../../services/unknownError';
import { invalidateSettingsRequests } from '../../services/settingsRequestCache';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { SettingsGuide, SettingsMetric } from './SettingsPresentation';

function blankOverview(): TelegramUserAccountsOverview {
    return {
        accounts: [],
        summary: { total: 0, enabled: 0, ready: 0, coolingDown: 0 },
        scheduling: {
            strategy: 'weighted_least_connections',
            description: '',
        },
    };
}

function isLongRateLimit(account: TelegramUserAccount, now: number): boolean {
    return account.enabled && account.health === 'cooldown'
        && account.scheduling.activeDownloads === 0
        && Date.parse(account.cooldownUntil || '') - now > 5 * 60_000;
}

function statusView(account: TelegramUserAccount, t: TFunction, now: number): { label: string; className: string } {
    if (!account.enabled || account.health === 'disabled') return { label: t('management.telegramAccounts.status.disabled'), className: 'settings-status--muted' };
    if (account.health === 'ready' && account.connected) return { label: t('management.telegramAccounts.status.ready'), className: 'settings-status--success' };
    if (account.health === 'cooldown') {
        if (isLongRateLimit(account, now)) return { label: t('management.telegramAccounts.status.cooldown'), className: 'settings-status--warning' };
        return account.connected
            ? { label: t('management.telegramAccounts.status.ready'), className: 'settings-status--success' }
            : { label: t('management.telegramAccounts.status.connecting'), className: 'settings-status--info' };
    }
    if (account.health === 'permission_denied') return { label: t('management.telegramAccounts.status.permissionDenied'), className: 'settings-status--warning' };
    if (account.health === 'connecting') return { label: t('management.telegramAccounts.status.connecting'), className: 'settings-status--info' };
    return { label: account.health === 'expired' ? t('management.telegramAccounts.status.expired') : t('management.telegramAccounts.status.error'), className: 'settings-status--danger' };
}

function accountName(account: TelegramUserAccount, t: TFunction): string {
    return account.displayName || (account.username ? `@${account.username}` : t('management.telegramAccounts.fallbackName', { id: account.userId }));
}

function formatTime(value: string | null | undefined, locale: string): string | null {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : formatDateTime(timestamp, locale);
}

function LoginDialog({
    open,
    target,
    onClose,
    onComplete,
}: {
    open: boolean;
    target: TelegramUserAccount | null;
    onClose: () => void;
    onComplete: () => Promise<void>;
}) {
    const { t } = useTranslation();
    const [method, setMethod] = useState<'choose' | 'qr' | 'phone'>('choose');
    const [selectedMethod, setSelectedMethod] = useState<'qr' | 'phone' | null>(null);
    const [login, setLogin] = useState<TelegramUserLoginStatus | null>(null);
    const [phone, setPhone] = useState('');
    const [code, setCode] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const closedRef = useRef(false);
    const pollGenerationRef = useRef(0);
    const completedFlowRef = useRef<string | null>(null);

    const clearSecrets = useCallback(() => {
        setPhone('');
        setCode('');
        setPassword('');
    }, []);

    const loginFlowId = login?.flowId;
    const targetAccountId = target?.id;

    const startQr = useCallback(async () => {
        setBusy(true);
        setFailure(null);
        pollGenerationRef.current += 1;
        setPassword('');
        try {
            if (loginFlowId) await fileApi.cancelTelegramUserLogin(loginFlowId).catch(() => undefined);
            setLogin(null);
            const result = await fileApi.startTelegramUserQrLogin(targetAccountId);
            if (closedRef.current) return;
            setLogin(result);
        } catch (error) {
            setFailure(errorMessage(error) || t('management.telegramAccounts.errors.qrCreate'));
        } finally {
            setBusy(false);
        }
    }, [loginFlowId, targetAccountId, t]);

    useEffect(() => {
        if (!open) {
            pollGenerationRef.current += 1;
            return;
        }
        closedRef.current = false;
        completedFlowRef.current = null;
        setMethod('choose');
        setSelectedMethod(null);
        setLogin(null);
        setFailure(null);
        clearSecrets();
        return () => { closedRef.current = true; };
    }, [open, target?.id, clearSecrets]);

    useEffect(() => {
        if (!open || closedRef.current || !login) return;
        if (login.status === 'error' || login.status === 'expired') {
            setPassword('');
            setFailure(login.message || t(login.status === 'expired' ? 'management.telegramAccounts.errors.qrExpired' : 'management.telegramAccounts.errors.login'));
        }
        if (login.status === 'complete' && completedFlowRef.current !== login.flowId) {
            completedFlowRef.current = login.flowId;
            clearSecrets();
            void onComplete().catch(error => {
                if (!closedRef.current) setFailure(errorMessage(error) || t('management.telegramAccounts.errors.login'));
            });
        }
    }, [open, login, clearSecrets, onComplete, t]);

    useEffect(() => {
        const flowId = open && login?.status === 'waiting_for_scan' ? login.flowId : null;
        if (!flowId) return;
        const generation = ++pollGenerationRef.current;
        let stopped = false;
        let timer: number | undefined;
        const poll = async () => {
            try {
                const next = await fileApi.getTelegramUserLoginStatus(flowId);
                if (closedRef.current || stopped || generation !== pollGenerationRef.current) return;
                setLogin(next);
                if (next.status === 'error' || next.status === 'expired') setPassword('');
                if (!stopped && next.status === 'waiting_for_scan') timer = window.setTimeout(() => { void poll(); }, 1_500);
            } catch (error) {
                if (!closedRef.current && !stopped && generation === pollGenerationRef.current) {
                    setFailure(errorMessage(error) || t('management.telegramAccounts.errors.status'));
                    timer = window.setTimeout(() => { void poll(); }, 3_000);
                }
            }
        };
        timer = window.setTimeout(() => { void poll(); }, 1_500);
        return () => {
            stopped = true;
            pollGenerationRef.current += 1;
            if (timer !== undefined) window.clearTimeout(timer);
        };
    }, [open, login?.flowId, login?.status, t]);

    const close = () => {
        const flowId = login?.flowId;
        closedRef.current = true;
        pollGenerationRef.current += 1;
        clearSecrets();
        setLogin(null);
        setFailure(null);
        if (flowId && login?.status !== 'complete') void fileApi.cancelTelegramUserLogin(flowId).catch(() => undefined);
        onClose();
    };

    const usePhone = () => {
        pollGenerationRef.current += 1;
        clearSecrets();
        const flowId = login?.flowId;
        if (flowId) void fileApi.cancelTelegramUserLogin(flowId).catch(() => undefined);
        setLogin(null);
        setFailure(null);
        setSelectedMethod('phone');
        setMethod('phone');
    };

    const chooseMethod = (next: 'qr' | 'phone') => {
        setSelectedMethod(next);
        setFailure(null);
    };

    const continueWithSelectedMethod = () => {
        if (!selectedMethod) return;
        setFailure(null);
        setMethod(selectedMethod);
        if (selectedMethod === 'qr') void startQr();
    };

    const backToMethodChoice = () => {
        pollGenerationRef.current += 1;
        clearSecrets();
        const flowId = login?.flowId;
        if (flowId && login?.status !== 'complete') void fileApi.cancelTelegramUserLogin(flowId).catch(() => undefined);
        setLogin(null);
        setFailure(null);
        setSelectedMethod(null);
        setMethod('choose');
    };

    const submitPhone = async () => {
        if (!phone.trim()) return;
        setBusy(true);
        setFailure(null);
        try {
            const result = await fileApi.startTelegramUserPhoneLogin(phone.trim(), target?.id);
            setLogin(result);
            setPhone('');
        } catch (error) {
            setFailure(errorMessage(error) || t('management.telegramAccounts.errors.codeSend'));
        } finally { setBusy(false); }
    };

    const submitCode = async () => {
        if (!login || !code.trim()) return;
        setBusy(true);
        setFailure(null);
        try {
            const result = await fileApi.submitTelegramUserLoginCode(login.flowId, code.trim());
            setCode('');
            setLogin(result);
        } catch (error) {
            setFailure(errorMessage(error) || t('management.telegramAccounts.errors.codeVerify'));
        } finally { setPassword(''); setBusy(false); }
    };

    const submitPassword = async () => {
        if (!login || !password) return;
        setBusy(true);
        setFailure(null);
        try {
            const result = await fileApi.submitTelegramUserLoginPassword(login.flowId, password);
            setLogin(result);
        } catch (error) {
            setFailure(errorMessage(error) || t('management.telegramAccounts.errors.password'));
        } finally { setPassword(''); setBusy(false); }
    };

    const complete = login?.status === 'complete';
    return (
        <Dialog open={open} onClose={close} labelledBy="telegram-account-login-title" describedBy="telegram-account-login-description" closeOnEscape={!busy} closeOnBackdrop={!busy} className="w-full max-w-xl">
            <div className="settings-surface tv-panel settings-login">
                <div className="settings-login__header">
                    <div className="settings-icon"><UserRound className="h-5 w-5" /></div>
                    <div className="min-w-0 flex-1">
                        <h3 id="telegram-account-login-title" className="text-lg font-semibold">{target ? t('management.telegramAccounts.reauth.title', { name: accountName(target, t) }) : t('management.telegramAccounts.login.title')}</h3>
                        <p id="telegram-account-login-description" className="mt-1 text-[13px] text-muted-foreground">{target ? t('management.telegramAccounts.reauth.description', { name: accountName(target, t), id: target.userId }) : t('management.telegramAccounts.login.description')}</p>
                    </div>
                    <button type="button" onClick={close} disabled={busy} className="settings-icon-button rounded-lg text-muted-foreground hover:bg-muted" aria-label={t(target ? 'management.telegramAccounts.reauth.closeAria' : 'management.telegramAccounts.login.closeAria')}><X className="h-4 w-4" /></button>
                </div>
                <div className="settings-login__body">
                    {failure && <div role="alert" className="settings-notice settings-status--danger">{failure}</div>}

                    {method === 'choose' && <div className="space-y-4">
                        <div>
                            <h4 className="font-semibold">{t('management.telegramAccounts.login.chooseTitle')}</h4>
                            <p className="mt-1 text-[13px] text-muted-foreground">{t('management.telegramAccounts.login.chooseDescription')}</p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <button type="button" aria-pressed={selectedMethod === 'qr'} onClick={() => chooseMethod('qr')} className={cn('settings-login__method', selectedMethod === 'qr' ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'border-border')}>
                                <div className="flex items-center gap-2 font-medium"><RefreshCw className="h-4 w-4 text-primary" />{t('management.telegramAccounts.login.qr')}</div>
                                <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{t('management.telegramAccounts.login.qrDescription')}</p>
                            </button>
                            <button type="button" aria-pressed={selectedMethod === 'phone'} onClick={() => chooseMethod('phone')} className={cn('settings-login__method', selectedMethod === 'phone' ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'border-border')}>
                                <div className="flex items-center gap-2 font-medium"><KeyRound className="h-4 w-4 text-primary" />{t('management.telegramAccounts.login.phone')}</div>
                                <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{t('management.telegramAccounts.login.phoneDescription')}</p>
                            </button>
                        </div>
                        <div className="flex justify-end">
                            <Button onClick={continueWithSelectedMethod} disabled={!selectedMethod || busy}>{t('management.telegramAccounts.login.next')}</Button>
                        </div>
                    </div>}

                    {method === 'qr' && !complete && login?.status !== 'password_required' && login?.status !== 'code_required' && <div className="space-y-4 text-center">
                        <div>
                            <h4 className="font-semibold">{t('management.telegramAccounts.login.qr')}</h4>
                            <p className="mt-1 text-[13px] text-muted-foreground">{t('management.telegramAccounts.login.qrInstructions')}</p>
                        </div>
                        {(busy || login?.status === 'waiting_for_scan') && <div className="settings-qr settings-qr--login">
                            {login?.status === 'waiting_for_scan' && login.qrCode ? <QRCodeSVG value={login.qrCode} size={192} level="M" marginSize={4} aria-label={t('management.telegramAccounts.login.qrAria')} /> : <LoaderCircle className="h-8 w-8 animate-spin text-primary" aria-label={t('management.telegramAccounts.login.generatingQr')} />}
                        </div>}
                        <div className="flex flex-col flex-wrap justify-center gap-2 sm:flex-row">
                            <Button variant="outline" onClick={() => void startQr()} disabled={busy}><RefreshCw className="mr-2 h-4 w-4" />{t('management.telegramAccounts.login.refreshQr')}</Button>
                            <Button variant="ghost" onClick={usePhone} disabled={busy}>{t('management.telegramAccounts.login.usePhone')}</Button>
                        </div>
                        <Button variant="ghost" size="sm" onClick={backToMethodChoice} disabled={busy}>{t('management.telegramAccounts.login.back')}</Button>
                    </div>}

                    {method === 'phone' && !login && <div className="space-y-3">
                        <label htmlFor="telegram-login-phone" className="text-[13px] font-medium">{t('management.telegramAccounts.login.phoneLabel')}</label>
                        <p className="text-[12px] text-muted-foreground">{t('management.telegramAccounts.login.phoneHint')}</p>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <input id="telegram-login-phone" value={phone} onChange={event => setPhone(event.target.value)} autoComplete="tel" inputMode="tel" placeholder={t('management.telegramAccounts.login.phonePlaceholder')} className="min-w-0 flex-1 px-3 py-2" />
                            <Button onClick={() => void submitPhone()} disabled={busy || !phone.trim()}>{t('management.telegramAccounts.login.sendCode')}</Button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button variant="ghost" size="sm" onClick={backToMethodChoice} disabled={busy}>{t('management.telegramAccounts.login.back')}</Button>
                            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setSelectedMethod('qr'); setMethod('qr'); void startQr(); }}>{t('management.telegramAccounts.login.backQr')}</Button>
                        </div>
                    </div>}

                    {login?.status === 'code_required' && <div className="space-y-3">
                        <label htmlFor="telegram-login-code" className="text-[13px] font-medium">{t('management.telegramAccounts.login.codeLabel')}</label>
                        <p className="text-[12px] text-muted-foreground">{t('management.telegramAccounts.login.codeSent')}{login.message ? `: ${login.message}` : ''}</p>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <input id="telegram-login-code" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" inputMode="numeric" placeholder={t('management.telegramAccounts.login.codePlaceholder')} className="min-w-0 flex-1 px-3 py-2" />
                            <Button onClick={() => void submitCode()} disabled={busy || !code.trim()}>{t('management.telegramAccounts.login.verify')}</Button>
                        </div>
                    </div>}

                    {login?.status === 'password_required' && <div className="space-y-3">
                        <label htmlFor="telegram-login-password" className="text-[13px] font-medium">{t('management.telegramAccounts.login.passwordLabel')}</label>
                        <p className="text-[12px] text-muted-foreground">{t('management.telegramAccounts.login.passwordHint')}</p>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <input id="telegram-login-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder={t('management.telegramAccounts.login.passwordPlaceholder')} className="min-w-0 flex-1 px-3 py-2" />
                            <Button onClick={() => void submitPassword()} disabled={busy || !password}>{t('management.telegramAccounts.login.signIn')}</Button>
                        </div>
                    </div>}

                    {!complete && login && (method === 'phone' || login.status === 'password_required' || login.status === 'code_required') && <div className="flex flex-wrap gap-2">
                        <Button variant="ghost" size="sm" onClick={backToMethodChoice} disabled={busy}>{t('management.telegramAccounts.login.back')}</Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setSelectedMethod('qr'); setMethod('qr'); void startQr(); }}>{t('management.telegramAccounts.login.backQr')}</Button>
                    </div>}

                    {complete && <div role="status" className="flex flex-col items-center gap-3 py-6 text-center">
                        <CheckCircle2 className="h-10 w-10 settings-text-success" />
                        <div><h4 className="font-semibold">{t(target ? 'management.telegramAccounts.reauth.completeTitle' : 'management.telegramAccounts.login.completeTitle')}</h4><p className="mt-1 text-[13px] text-muted-foreground">{t(target ? 'management.telegramAccounts.reauth.completeDescription' : 'management.telegramAccounts.login.completeDescription')}</p></div>
                        <Button onClick={close}>{t('management.telegramAccounts.login.done')}</Button>
                    </div>}
                </div>
            </div>
        </Dialog>
    );
}

export function TelegramUserAccountsPanel({
    configured,
    onNotice,
    requestConfirmation,
}: {
    configured: boolean;
    onNotice: (message: string, title?: string) => Promise<void> | void;
    requestConfirmation: (message: string, title?: string, options?: { tone?: 'default' | 'danger'; dangerDescription?: string; cancelLabel?: string; confirmLabel?: string }) => Promise<boolean>;
}) {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || i18n.language;
    const [overview, setOverview] = useState<TelegramUserAccountsOverview>(blankOverview);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
    const [loginOpen, setLoginOpen] = useState(false);
    const [loginTarget, setLoginTarget] = useState<TelegramUserAccount | null>(null);

    const reload = useCallback(async (fresh = false) => {
        if (fresh) invalidateSettingsRequests();
        setLoadError(null);
        try {
            setOverview(await fileApi.getTelegramUserAccounts());
        } catch (error) {
            setLoadError(errorMessage(error) || t('management.telegramAccounts.errors.load'));
        } finally { setLoading(false); }
    }, [t]);

    useEffect(() => {
        let stopped = false;
        let timer: number | undefined;
        const poll = async () => {
            if (document.visibilityState === 'visible') await reload(true);
            if (!stopped) timer = window.setTimeout(poll, 5000);
        };
        void poll();
        return () => { stopped = true; window.clearTimeout(timer); };
    }, [reload]);

    const mutateAccount = async (account: TelegramUserAccount, operation: 'enable' | 'disable' | 'unlink') => {
        if (busyAccountId) return;
        if (operation === 'unlink') {
            const confirmed = await requestConfirmation(
                t('management.telegramAccounts.unlink.message', { name: accountName(account, t) }),
                t('management.telegramAccounts.unlink.title'),
                { tone: 'danger', dangerDescription: t('management.telegramAccounts.unlink.danger'), cancelLabel: t('management.telegramAccounts.unlink.cancel'), confirmLabel: t('management.telegramAccounts.unlink.confirm') },
            );
            if (!confirmed) return;
        }
        setBusyAccountId(account.id);
        try {
            if (operation === 'enable') await fileApi.setTelegramUserAccountEnabled(account.id, true);
            if (operation === 'disable') await fileApi.setTelegramUserAccountEnabled(account.id, false);
            if (operation === 'unlink') await fileApi.unlinkTelegramUserAccountById(account.id);
            await reload(true);
            if (operation === 'enable') await onNotice(t('management.telegramAccounts.notices.enabled'));
            if (operation === 'disable') await onNotice(t('management.telegramAccounts.notices.disabled'));
            if (operation === 'unlink') await onNotice(t('management.telegramAccounts.notices.unlinked'));
        } catch (error) {
            await onNotice(errorMessage(error) || t('management.telegramAccounts.errors.operation'), t('management.telegramAccounts.errors.operationTitle'));
        } finally { setBusyAccountId(null); }
    };

    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 15_000);
        return () => window.clearInterval(timer);
    }, []);
    const limitedCount = overview.accounts.filter(account => isLongRateLimit(account, now)).length;
    const readyCount = overview.accounts.filter(account => account.enabled && account.connected
        && (account.health === 'ready' || (account.health === 'cooldown' && !isLongRateLimit(account, now)))).length;

    return (
        <div className="settings-surface settings-telegram">
            <div className="settings-telegram__header">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-semibold">{t('management.telegramAccounts.title')}</h4>
                        <span className="tv-badge settings-status settings-status--muted">{t('management.telegramAccounts.count', { count: overview.summary.total })}</span>
                    </div>
                    <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted-foreground">{t('management.telegramAccounts.description')}</p>
                </div>
                <Button className="w-full sm:w-auto" onClick={() => { setLoginTarget(null); setLoginOpen(true); }} disabled={!configured || busyAccountId !== null}><Plus className="mr-2 h-4 w-4" />{t('management.telegramAccounts.add')}</Button>
            </div>

            {!configured && <div className="settings-notice settings-status--warning"><ShieldAlert className="mr-2 inline h-4 w-4" />{t('management.telegramAccounts.botRequired')}</div>}
            {loadError && <div role="alert" className="settings-notice settings-status--danger settings-action-row"><span>{loadError}</span><Button variant="outline" size="sm" onClick={() => void reload(true)}>{t('management.telegramAccounts.retry')}</Button></div>}

            <div className="settings-metrics">
                <SettingsMetric label={t('management.telegramAccounts.summary.enabled')}>{overview.summary.enabled}<span className="settings-metric__denominator">/ {overview.summary.total}</span></SettingsMetric>
                <SettingsMetric label={t('management.telegramAccounts.summary.ready')} tone="success">{readyCount}</SettingsMetric>
                {limitedCount > 0 && <SettingsMetric label={t('management.telegramAccounts.summary.cooldown')} tone="warning">{limitedCount}</SettingsMetric>}
            </div>

            <div className="settings-telegram__workspace">
            <SettingsGuide title={t('management.telegramAccounts.scheduling.title')} icon={ShieldCheck}>
                <p>{t('management.telegramAccounts.scheduling.description')}</p>
                <p className="settings-guide__privacy"><KeyRound className="mr-1 inline h-3.5 w-3.5" />{t('management.telegramAccounts.privacy')}</p>
            </SettingsGuide>

            {loading ? <div className="flex min-h-32 items-center justify-center text-[13px] text-muted-foreground"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" />{t('management.telegramAccounts.loading')}</div> : !loadError && overview.accounts.length === 0 ? <div className="settings-empty"><UserRound className="mx-auto h-8 w-8 text-muted-foreground/60" /><p className="mt-3 text-[13px] font-medium">{t('management.telegramAccounts.empty.title')}</p><p className="mt-1 text-[12px] text-muted-foreground">{t('management.telegramAccounts.empty.description')}</p></div> : <div className="space-y-3">
                {overview.accounts.map(account => {
                    const status = statusView(account, t, now);
                    const busy = busyAccountId === account.id;
                    return <article key={account.id} className="settings-telegram-account">
                        <div className="settings-telegram-account__layout">
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h5 className="settings-telegram-account__name">{accountName(account, t)}</h5>
                                    <span className={cn('tv-badge settings-status', status.className)}>{status.label}</span>
                                </div>
                                <div className="settings-telegram-account__facts">
                                    <p title={t('management.telegramAccounts.account.dcHint')}><Server className="mr-1 inline h-3.5 w-3.5" />{t('management.telegramAccounts.account.dc', { value: account.dcId ? `DC ${account.dcId}` : t('management.telegramAccounts.account.dcUnknown') })}</p>
                                    <p><Power className="mr-1 inline h-3.5 w-3.5" />{t('management.telegramAccounts.account.activeDownloads', { count: account.scheduling.activeDownloads })}</p>
                                    <p>{t('management.telegramAccounts.account.weight', { value: account.scheduling.weight })}</p>
                                </div>
                                {isLongRateLimit(account, now) && <div className="mt-2 text-[12px] leading-5 text-muted-foreground">
                                    <p>{t('management.telegramAccounts.account.rateLimitHint')}</p>
                                    {account.cooldownUntil && <p>{t('management.telegramAccounts.account.cooldownUntil', { time: formatTime(account.cooldownUntil, locale) || t('management.telegramAccounts.account.pendingUpdate') })}</p>}
                                </div>}
                                {account.enabled && account.lastError && (account.health === 'error' || account.health === 'expired') && <p className="mt-2 break-words text-[12px] settings-text-danger">{account.lastError}</p>}
                                {account.health === 'expired' && <p className="mt-2 text-[12px] settings-text-danger">{t('management.telegramAccounts.reauth.expiredHint')}</p>}
                                {!account.enabled && <p className="mt-2 text-[12px] text-muted-foreground">{t('management.telegramAccounts.account.disabledHint')}</p>}
                            </div>
                            <div className="settings-actions settings-telegram-account__actions">
                                {account.enabled && !account.connected && (account.health === 'expired' || account.health === 'error') && <Button size="sm" variant={account.health === 'expired' ? 'default' : 'outline'} disabled={!configured || busyAccountId !== null} onClick={() => { setLoginTarget(account); setLoginOpen(true); }}><KeyRound className="mr-1.5 h-3.5 w-3.5" />{t('management.telegramAccounts.reauth.action')}</Button>}
                                {account.enabled ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutateAccount(account, 'disable')}><PowerOff className="mr-1.5 h-3.5 w-3.5" />{t('management.telegramAccounts.account.disable')}</Button> : <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutateAccount(account, 'enable')}><Power className="mr-1.5 h-3.5 w-3.5" />{t('management.telegramAccounts.account.enable')}</Button>}
                                <Button size="sm" variant="destructive" disabled={busy} onClick={() => void mutateAccount(account, 'unlink')}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{t('management.telegramAccounts.account.delete')}</Button>
                            </div>
                        </div>
                    </article>;
                })}
            </div>}

            </div>
            <LoginDialog open={loginOpen} target={loginTarget} onClose={() => setLoginOpen(false)} onComplete={async () => { await reload(true); await onNotice(t(loginTarget ? 'management.telegramAccounts.reauth.notice' : 'management.telegramAccounts.notices.bound')); }} />
        </div>
    );
}
