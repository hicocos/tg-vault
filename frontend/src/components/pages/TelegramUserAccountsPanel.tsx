import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CheckCircle2, Clock3, KeyRound, LoaderCircle, Plus, Power, PowerOff, RefreshCw, ShieldAlert, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { fileApi, type TelegramPermissionSummary, type TelegramUserAccount, type TelegramUserAccountsOverview, type TelegramUserLoginStatus } from '../../services/api';
import { errorMessage } from '../../services/unknownError';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

const EMPTY_PERMISSIONS: TelegramPermissionSummary = {
    allowed: 0,
    denied: 0,
    unknown: 0,
    total: 0,
    lastCheckedAt: null,
};

function blankOverview(): TelegramUserAccountsOverview {
    return {
        accounts: [],
        summary: { total: 0, enabled: 0, ready: 0, coolingDown: 0, permissions: EMPTY_PERMISSIONS },
        scheduling: {
            strategy: 'weighted_least_connections',
            description: '',
        },
    };
}

function statusView(account: TelegramUserAccount, t: TFunction): { label: string; className: string } {
    if (!account.enabled || account.health === 'disabled') return { label: t('management.telegramAccounts.status.disabled'), className: 'border-border bg-muted text-muted-foreground' };
    if (account.health === 'ready' && account.connected) return { label: t('management.telegramAccounts.status.ready'), className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300' };
    if (account.health === 'cooldown') return { label: t('management.telegramAccounts.status.cooldown'), className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300' };
    if (account.health === 'permission_denied') return { label: t('management.telegramAccounts.status.permissionDenied'), className: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950/30 dark:text-orange-300' };
    if (account.health === 'connecting') return { label: t('management.telegramAccounts.status.connecting'), className: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300' };
    return { label: account.health === 'expired' ? t('management.telegramAccounts.status.expired') : t('management.telegramAccounts.status.error'), className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300' };
}

function accountName(account: TelegramUserAccount, t: TFunction): string {
    return account.displayName || (account.username ? `@${account.username}` : t('management.telegramAccounts.fallbackName', { id: account.userId }));
}

function formatTime(value: string | null | undefined, locale: string): string | null {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toLocaleString(locale, { hour12: false });
}

function PermissionSummary({ summary, compact = false }: { summary: TelegramPermissionSummary; compact?: boolean }) {
    const { t } = useTranslation();
    if (!summary.total) return <span className="text-muted-foreground">{t('management.telegramAccounts.permissions.notChecked')}</span>;
    return (
        <span className={cn('inline-flex flex-wrap items-center gap-x-2 gap-y-1', compact ? 'text-xs' : 'text-sm')}>
            <span className="text-emerald-700 dark:text-emerald-300">{t('management.telegramAccounts.permissions.allowed', { count: summary.allowed })}</span>
            <span className="text-red-700 dark:text-red-300">{t('management.telegramAccounts.permissions.denied', { count: summary.denied })}</span>
            <span className="text-muted-foreground">{t('management.telegramAccounts.permissions.unknown', { count: summary.unknown })}</span>
        </span>
    );
}

function LoginDialog({
    open,
    onClose,
    onComplete,
}: {
    open: boolean;
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

    const clearSecrets = useCallback(() => {
        setPhone('');
        setCode('');
        setPassword('');
    }, []);

    const startQr = useCallback(async () => {
        setBusy(true);
        setFailure(null);
        try {
            if (login?.flowId) await fileApi.cancelTelegramUserLogin(login.flowId).catch(() => undefined);
            const result = await fileApi.startTelegramUserQrLogin();
            setLogin(result);
        } catch (error) {
            setFailure(errorMessage(error) || t('management.telegramAccounts.errors.qrCreate'));
        } finally {
            setBusy(false);
        }
    }, [login?.flowId]);

    useEffect(() => {
        if (!open) {
            pollGenerationRef.current += 1;
            return;
        }
        closedRef.current = false;
        setMethod('choose');
        setSelectedMethod(null);
        setLogin(null);
        setFailure(null);
        clearSecrets();
        return () => { closedRef.current = true; };
    }, [open, clearSecrets]);

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
                if (next.status === 'complete') {
                    clearSecrets();
                    await onComplete();
                    return;
                }
                if (next.status === 'expired') setFailure(t('management.telegramAccounts.errors.qrExpired'));
                if (next.status === 'error') setFailure(next.message || t('management.telegramAccounts.errors.login'));
                if (!stopped && next.status === 'waiting_for_scan') timer = window.setTimeout(() => { void poll(); }, 1_500);
            } catch (error) {
                if (!closedRef.current && !stopped) {
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
    }, [open, login?.flowId, clearSecrets, onComplete]);

    const close = () => {
        const flowId = login?.flowId;
        closedRef.current = true;
        clearSecrets();
        setLogin(null);
        setFailure(null);
        if (flowId && login?.status !== 'complete') void fileApi.cancelTelegramUserLogin(flowId).catch(() => undefined);
        onClose();
    };

    const usePhone = () => {
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
            const result = await fileApi.startTelegramUserPhoneLogin(phone.trim());
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
            if (result.status === 'complete') await onComplete();
        } catch (error) {
            setFailure(errorMessage(error) || t('management.telegramAccounts.errors.codeVerify'));
        } finally { setBusy(false); }
    };

    const submitPassword = async () => {
        if (!login || !password) return;
        setBusy(true);
        setFailure(null);
        try {
            const result = await fileApi.submitTelegramUserLoginPassword(login.flowId, password);
            setPassword('');
            setLogin(result);
            if (result.status === 'complete') await onComplete();
        } catch (error) {
            setFailure(errorMessage(error) || t('management.telegramAccounts.errors.password'));
        } finally { setBusy(false); }
    };

    const complete = login?.status === 'complete';
    return (
        <Dialog open={open} onClose={close} labelledBy="telegram-account-login-title" describedBy="telegram-account-login-description" closeOnEscape={!busy} closeOnBackdrop={!busy} className="w-full max-w-xl">
            <div className="overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
                <div className="flex items-start gap-3 border-b border-border bg-muted/30 px-5 py-4 sm:px-6">
                    <div className="rounded-full bg-primary/10 p-2 text-primary"><UserRound className="h-5 w-5" /></div>
                    <div className="min-w-0 flex-1">
                        <h3 id="telegram-account-login-title" className="text-lg font-semibold">{t('management.telegramAccounts.login.title')}</h3>
                        <p id="telegram-account-login-description" className="mt-1 text-sm text-muted-foreground">{t('management.telegramAccounts.login.description')}</p>
                    </div>
                    <button type="button" onClick={close} disabled={busy} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted" aria-label={t('management.telegramAccounts.login.closeAria')}><X className="h-4 w-4" /></button>
                </div>
                <div className="space-y-5 p-5 sm:p-6">
                    {failure && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{failure}</div>}

                    {method === 'choose' && <div className="space-y-4">
                        <div>
                            <h4 className="font-semibold">{t('management.telegramAccounts.login.chooseTitle')}</h4>
                            <p className="mt-1 text-sm text-muted-foreground">{t('management.telegramAccounts.login.chooseDescription')}</p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <button type="button" aria-pressed={selectedMethod === 'qr'} onClick={() => chooseMethod('qr')} className={cn('rounded-xl border p-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/5', selectedMethod === 'qr' ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'border-border')}>
                                <div className="flex items-center gap-2 font-medium"><RefreshCw className="h-4 w-4 text-primary" />{t('management.telegramAccounts.login.qr')}</div>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('management.telegramAccounts.login.qrDescription')}</p>
                            </button>
                            <button type="button" aria-pressed={selectedMethod === 'phone'} onClick={() => chooseMethod('phone')} className={cn('rounded-xl border p-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/5', selectedMethod === 'phone' ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'border-border')}>
                                <div className="flex items-center gap-2 font-medium"><KeyRound className="h-4 w-4 text-primary" />{t('management.telegramAccounts.login.phone')}</div>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('management.telegramAccounts.login.phoneDescription')}</p>
                            </button>
                        </div>
                        <div className="flex justify-end">
                            <Button onClick={continueWithSelectedMethod} disabled={!selectedMethod || busy}>{t('management.telegramAccounts.login.next')}</Button>
                        </div>
                    </div>}

                    {method === 'qr' && !complete && <div className="space-y-4 text-center">
                        <div>
                            <h4 className="font-semibold">{t('management.telegramAccounts.login.qr')}</h4>
                            <p className="mt-1 text-sm text-muted-foreground">{t('management.telegramAccounts.login.qrInstructions')}</p>
                        </div>
                        <div className="mx-auto flex min-h-56 w-56 items-center justify-center rounded-2xl border border-border bg-white p-4 shadow-sm">
                            {login?.qrCode ? <QRCodeSVG value={login.qrCode} size={192} level="M" aria-label={t('management.telegramAccounts.login.qrAria')} /> : <LoaderCircle className="h-8 w-8 animate-spin text-primary" aria-label={t('management.telegramAccounts.login.generatingQr')} />}
                        </div>
                        <div className="flex flex-col justify-center gap-2 sm:flex-row">
                            <Button variant="outline" onClick={() => void startQr()} disabled={busy}><RefreshCw className="mr-2 h-4 w-4" />{t('management.telegramAccounts.login.refreshQr')}</Button>
                            <Button variant="ghost" onClick={usePhone} disabled={busy}>{t('management.telegramAccounts.login.usePhone')}</Button>
                        </div>
                        <Button variant="ghost" size="sm" onClick={backToMethodChoice} disabled={busy}>{t('management.telegramAccounts.login.back')}</Button>
                    </div>}

                    {method === 'phone' && !login && <div className="space-y-3">
                        <label htmlFor="telegram-login-phone" className="text-sm font-medium">{t('management.telegramAccounts.login.phoneLabel')}</label>
                        <p className="text-xs text-muted-foreground">{t('management.telegramAccounts.login.phoneHint')}</p>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <input id="telegram-login-phone" value={phone} onChange={event => setPhone(event.target.value)} autoComplete="tel" inputMode="tel" placeholder={t('management.telegramAccounts.login.phonePlaceholder')} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                            <Button onClick={() => void submitPhone()} disabled={busy || !phone.trim()}>{t('management.telegramAccounts.login.sendCode')}</Button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button variant="ghost" size="sm" onClick={backToMethodChoice}>{t('management.telegramAccounts.login.back')}</Button>
                            <Button variant="ghost" size="sm" onClick={() => { setSelectedMethod('qr'); setMethod('qr'); void startQr(); }}>{t('management.telegramAccounts.login.backQr')}</Button>
                        </div>
                    </div>}

                    {login?.status === 'code_required' && <div className="space-y-3">
                        <label htmlFor="telegram-login-code" className="text-sm font-medium">{t('management.telegramAccounts.login.codeLabel')}</label>
                        <p className="text-xs text-muted-foreground">{t('management.telegramAccounts.login.codeSent')}{login.message ? `: ${login.message}` : ''}</p>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <input id="telegram-login-code" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" inputMode="numeric" placeholder={t('management.telegramAccounts.login.codePlaceholder')} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                            <Button onClick={() => void submitCode()} disabled={busy || !code.trim()}>{t('management.telegramAccounts.login.verify')}</Button>
                        </div>
                    </div>}

                    {login?.status === 'password_required' && <div className="space-y-3">
                        <label htmlFor="telegram-login-password" className="text-sm font-medium">{t('management.telegramAccounts.login.passwordLabel')}</label>
                        <p className="text-xs text-muted-foreground">{t('management.telegramAccounts.login.passwordHint')}</p>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <input id="telegram-login-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder={t('management.telegramAccounts.login.passwordPlaceholder')} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                            <Button onClick={() => void submitPassword()} disabled={busy || !password}>{t('management.telegramAccounts.login.signIn')}</Button>
                        </div>
                    </div>}

                    {complete && <div role="status" className="flex flex-col items-center gap-3 py-6 text-center">
                        <CheckCircle2 className="h-10 w-10 text-emerald-600" />
                        <div><h4 className="font-semibold">{t('management.telegramAccounts.login.completeTitle')}</h4><p className="mt-1 text-sm text-muted-foreground">{t('management.telegramAccounts.login.completeDescription')}</p></div>
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

    const reload = useCallback(async () => {
        setLoadError(null);
        try {
            setOverview(await fileApi.getTelegramUserAccounts());
        } catch (error) {
            setLoadError(errorMessage(error) || t('management.telegramAccounts.errors.load'));
        } finally { setLoading(false); }
    }, [t]);

    useEffect(() => { void reload(); }, [reload]);

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
            await reload();
            if (operation === 'enable') await onNotice(t('management.telegramAccounts.notices.enabled'));
            if (operation === 'disable') await onNotice(t('management.telegramAccounts.notices.disabled'));
            if (operation === 'unlink') await onNotice(t('management.telegramAccounts.notices.unlinked'));
        } catch (error) {
            await onNotice(errorMessage(error) || t('management.telegramAccounts.errors.operation'), t('management.telegramAccounts.errors.operationTitle'));
        } finally { setBusyAccountId(null); }
    };

    return (
        <div className="space-y-4 p-4 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-semibold">{t('management.telegramAccounts.title')}</h4>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{t('management.telegramAccounts.count', { count: overview.summary.total })}</span>
                    </div>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t('management.telegramAccounts.description')}</p>
                </div>
                <Button className="w-full sm:w-auto" onClick={() => setLoginOpen(true)} disabled={!configured}><Plus className="mr-2 h-4 w-4" />{t('management.telegramAccounts.add')}</Button>
            </div>

            {!configured && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"><ShieldAlert className="mr-2 inline h-4 w-4" />{t('management.telegramAccounts.botRequired')}</div>}
            {loadError && <div role="alert" className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"><span>{loadError}</span><Button variant="outline" size="sm" onClick={() => void reload()}>{t('management.telegramAccounts.retry')}</Button></div>}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-border bg-background p-3"><p className="text-xs text-muted-foreground">{t('management.telegramAccounts.summary.enabled')}</p><p className="mt-1 text-xl font-semibold tabular-nums">{overview.summary.enabled}<span className="ml-1 text-sm font-normal text-muted-foreground">/ {overview.summary.total}</span></p></div>
                <div className="rounded-xl border border-border bg-background p-3"><p className="text-xs text-muted-foreground">{t('management.telegramAccounts.summary.ready')}</p><p className="mt-1 text-xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{overview.summary.ready}</p></div>
                <div className="rounded-xl border border-border bg-background p-3"><p className="text-xs text-muted-foreground">{t('management.telegramAccounts.summary.cooldown')}</p><p className="mt-1 text-xl font-semibold tabular-nums text-amber-700 dark:text-amber-300">{overview.summary.coolingDown}</p></div>
                <div className="rounded-xl border border-border bg-background p-3"><p className="text-xs text-muted-foreground">{t('management.telegramAccounts.summary.permissions')}</p><div className="mt-1"><PermissionSummary summary={overview.summary.permissions} compact /></div></div>
            </div>

            <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-200">
                <p className="font-medium">{t('management.telegramAccounts.scheduling.title')}</p>
                <p className="mt-1 text-xs leading-5 text-blue-800/80 dark:text-blue-300/80">{overview.scheduling.description || t('management.telegramAccounts.scheduling.description')}</p>
            </div>

            {loading ? <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" />{t('management.telegramAccounts.loading')}</div> : !loadError && overview.accounts.length === 0 ? <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center"><UserRound className="mx-auto h-8 w-8 text-muted-foreground/60" /><p className="mt-3 text-sm font-medium">{t('management.telegramAccounts.empty.title')}</p><p className="mt-1 text-xs text-muted-foreground">{t('management.telegramAccounts.empty.description')}</p></div> : <div className="space-y-3">
                {overview.accounts.map(account => {
                    const status = statusView(account, t);
                    const busy = busyAccountId === account.id;
                    return <article key={account.id} className="rounded-xl border border-border bg-background p-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h5 className="truncate font-semibold">{accountName(account, t)}</h5>
                                    <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold', status.className)}>{status.label}</span>
                                </div>
                                <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                                    <p><ShieldCheck className="mr-1 inline h-3.5 w-3.5" />{t('management.telegramAccounts.account.permissions')}: <PermissionSummary summary={account.permissionSummary} compact /></p>
                                    <p><Power className="mr-1 inline h-3.5 w-3.5" />{t('management.telegramAccounts.account.activeDownloads', { count: account.scheduling.activeDownloads })}</p>
                                    <p><Clock3 className="mr-1 inline h-3.5 w-3.5" />{t('management.telegramAccounts.account.lastChecked')}: {formatTime(account.checkedAt, locale) || t('management.telegramAccounts.permissions.notChecked')}</p>
                                    <p>{t('management.telegramAccounts.account.weight', { value: account.scheduling.weight })}</p>
                                </div>
                                {account.cooldownUntil && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t('management.telegramAccounts.account.cooldownUntil', { time: formatTime(account.cooldownUntil, locale) || t('management.telegramAccounts.account.pendingUpdate') })}</p>}
                                {account.lastError && account.health !== 'disabled' && <p className="mt-2 break-words text-xs text-red-700 dark:text-red-300">{t('management.telegramAccounts.account.lastError')}: {account.lastError}</p>}
                                {!account.enabled && <p className="mt-2 text-xs text-muted-foreground">{t('management.telegramAccounts.account.disabledHint')}</p>}
                            </div>
                            <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:max-w-sm lg:justify-end">
                                {account.enabled ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutateAccount(account, 'disable')}><PowerOff className="mr-1.5 h-3.5 w-3.5" />{t('management.telegramAccounts.account.disable')}</Button> : <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutateAccount(account, 'enable')}><Power className="mr-1.5 h-3.5 w-3.5" />{t('management.telegramAccounts.account.enable')}</Button>}
                                <Button size="sm" variant="destructive" disabled={busy} onClick={() => void mutateAccount(account, 'unlink')}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{t('management.telegramAccounts.account.delete')}</Button>
                            </div>
                        </div>
                    </article>;
                })}
            </div>}

            <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"><KeyRound className="mr-1 inline h-3.5 w-3.5" />{t('management.telegramAccounts.privacy')}</div>
            <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} onComplete={async () => { await reload(); await onNotice(t('management.telegramAccounts.notices.bound')); }} />
        </div>
    );
}
