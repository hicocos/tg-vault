import { AppearanceSettings } from './AppearanceSettings';
import { BotFaultDetails } from './BotFaultDetails';
import { botFaultPresentation, publishBotStatus } from '../../services/botFaultPresentation';
import { formatDateTime } from '../../i18n/format';
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { Palette, Globe, Cloud, Database, CheckCircle, Trash2, Network, Shield, ShieldAlert, ShieldCheck, ExternalLink, KeyRound, CircleHelp, XCircle, RefreshCw, Gauge, Copy, X } from "../ui/icons";
import { Button } from "../ui/Button";
import { LanguageToggle } from "../ui/LanguageToggle";
import { cn } from "../../lib/utils";
import { fileApi, type AdvancedTaskSettings, type StorageConfig, type StorageStats, type TelegramBotPublicConfig, type UpdateStatus } from "../../services/api";
import { synchronizeStorageConfig } from "../../services/storageConfigSynchronization";
import { authService } from "../../services/auth";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settingsSections";
import { IndeterminateSpinner } from "../ui/IndeterminateSpinner";
import { errorCode, errorMessage } from "../../services/unknownError";
import { Dialog } from "../ui/Dialog";
import { TelegramUserAccountsPanel } from "./TelegramUserAccountsPanel";
import { StorageSettings } from './StorageSettings';
import { SettingsField, SettingsFormLayout, SettingsRow, SettingsSection, SettingsWorkspace } from "./SettingsPresentation";
import { QbittorrentSettings } from './QbittorrentSettings';

interface SettingsPageProps {
    storageStats?: StorageStats | null;
    onSignedOut?: () => void;
    onOpenTasksForAccount?: (accountId: string) => void;
    onStorageConfigChanged?: (config: StorageConfig) => void;
    onStorageStatsRefresh?: (accountId: string | null) => Promise<void>;
    activeSection: SettingsSectionId;
    onSectionChange: (section: SettingsSectionId) => void;
}

interface ActionNoticeState {
    title: string;
    message: string;
    tone: 'success' | 'error' | 'info';
}
interface ActionDialogState {
    mode: 'confirm' | 'prompt';
    title: string;
    message: string;
    inputType?: 'text' | 'password';
    tone?: 'default' | 'danger';
    dangerDescription?: string;
    cancelLabel?: string;
    confirmLabel?: string;
    resolve?: (value: boolean | string | null) => void;
}

const ActionNotice = ({ state, onClose }: { state: ActionNoticeState; onClose: () => void }) => {
    const { t } = useTranslation();
    return createPortal(
        <motion.div
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -12, scale: 0.98 }}
        className="pointer-events-none fixed inset-x-0 top-20 z-[120] flex justify-center px-4"
    >
        <div
            className={cn(
                "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border bg-background/95 px-4 py-3 shadow-xl backdrop-blur",
                state.tone === 'success' && "border-emerald-200",
                state.tone === 'error' && "border-red-200",
                state.tone === 'info' && "border-border",
            )}
            role="status"
            aria-live="polite"
        >
            {state.tone === 'success' ? <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /> : state.tone === 'error' ? <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" /> : <CircleHelp className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{state.title}</p>
                <p className="mt-0.5 whitespace-pre-line break-words text-sm text-muted-foreground">{state.message}</p>
            </div>
            <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" onClick={onClose} aria-label={t('settings.remaining.copy.124')} title={t('settings.remaining.copy.124')}><X className="h-4 w-4" /></button>
        </div>
        </motion.div>,
        document.body,
    );
};

const ActionDialog = ({ state, input, onInput, onCancel, onConfirm }: {
    state: ActionDialogState;
    input: string;
    onInput: (value: string) => void;
    onCancel: () => void;
    onConfirm: () => void;
}) => {
    const { t } = useTranslation();
    const danger = state.tone === 'danger';
    return (
        <Dialog open onClose={onCancel} labelledBy="settings-action-title" describedBy="settings-action-message" alert={danger} className="w-full max-w-lg">
            <motion.div
                initial={{ opacity: 0, y: 12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className={cn("settings-surface w-full overflow-hidden rounded-2xl border bg-background shadow-2xl", danger ? "border-destructive/40" : "border-border")}
            >
                <div className={cn("flex items-start gap-3 border-b px-5 py-4 sm:px-6", danger ? "border-destructive/20 bg-destructive/10" : "border-border bg-muted/30")}>
                    <div className={cn("mt-0.5 shrink-0 rounded-full p-2", danger ? "bg-destructive/15 text-destructive" : "bg-primary/10 text-primary")}>
                        {danger ? <ShieldAlert className="h-5 w-5" /> : <CircleHelp className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 id="settings-action-title" className="text-base font-semibold sm:text-lg">{state.title}</h3>
                        {danger && <p className="mt-1 text-xs font-medium text-destructive">{state.dangerDescription || t('settings.dialog.irreversible')}</p>}
                    </div>
                    <button type="button" onClick={onCancel} className="settings-icon-button rounded-lg text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground" aria-label={t('settings.dialog.close')}><X className="h-4 w-4" /></button>
                </div>
                <div className="max-h-[min(60vh,32rem)] overflow-y-auto px-5 py-5 sm:px-6">
                    <p id="settings-action-message" className="whitespace-pre-line text-sm leading-6 text-muted-foreground">{state.message}</p>
                    {state.mode === 'prompt' && (
                        <input
                            type={state.inputType || 'text'}
                            value={input}
                            onChange={event => onInput(event.target.value)}
                            onKeyDown={event => { if (event.key === 'Enter') onConfirm(); }}
                            className="mt-4 h-11 w-full rounded-lg border border-border bg-background px-3"
                        />
                    )}
                </div>
                <div className="flex flex-col-reverse flex-wrap gap-2 border-t border-border bg-muted/20 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
                    <Button variant="outline" onClick={onCancel}>{state.cancelLabel || t('settings.remaining.copy.124')}</Button>
                    <Button variant={danger ? 'destructive' : 'default'} onClick={onConfirm}>{state.confirmLabel || t('settings.remaining.copy.125')}</Button>
                </div>
            </motion.div>
        </Dialog>
    );
};

export const SettingsPage = ({ storageStats, onSignedOut, onOpenTasksForAccount, onStorageConfigChanged, onStorageStatsRefresh, activeSection, onSectionChange }: SettingsPageProps) => {
    const { t, i18n } = useTranslation();

    const [actionDialog, setActionDialog] = useState<ActionDialogState | null>(null);
    const [actionNotice, setActionNotice] = useState<ActionNoticeState | null>(null);
    const [actionDialogInput, setActionDialogInput] = useState('');
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
    const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);

    const closeActionNotice = useCallback(() => {
        setActionNotice(null);
    }, []);
    useEffect(() => {
        if (!actionNotice) return;
        const timer = window.setTimeout(() => closeActionNotice(), 4_000);
        return () => window.clearTimeout(timer);
    }, [actionNotice, closeActionNotice]);
    const showNotice = (message: string, title = t('settings.remaining.copy.126'), tone?: ActionNoticeState['tone']) => {
        const inferredError = /失败|错误|不完整|被引用|阻止|failed|error|incomplete|blocked|could not/i.test(title);
        setActionNotice({ title, message, tone: tone ?? (inferredError ? 'error' : 'success') });
        return Promise.resolve();
    };
    const requestConfirmation = (message: string, title = t('settings.remaining.copy.127'), options?: { tone?: 'default' | 'danger'; dangerDescription?: string; cancelLabel?: string; confirmLabel?: string }) => new Promise<boolean>(resolve => {
        setActionDialog({ mode: 'confirm', title, message, ...options, resolve: value => resolve(value === true) });
    });
    const requestInput = (message: string, title = t('settings.remaining.copy.128'), inputType: 'text' | 'password' = 'text') => new Promise<string | null>(resolve => {
        setActionDialogInput('');
        setActionDialog({ mode: 'prompt', title, message, inputType, resolve: value => resolve(typeof value === 'string' ? value : null) });
    });
    const closeActionDialog = (confirmed: boolean) => {
        if (!actionDialog) return;
        const value = actionDialog.mode === 'prompt' ? (confirmed ? actionDialogInput : null) : confirmed;
        actionDialog.resolve?.(value);
        setActionDialog(null);
        setActionDialogInput('');
    };

    // Storage Configuration State
    const [config, setConfig] = useState<StorageConfig | null>(null);
    const [storageLoadError, setStorageLoadError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isSavingWebdavSecurity, setIsSavingWebdavSecurity] = useState(false);

    // 2FA State
    const [twoFAQrCode, setTwoFAQrCode] = useState<string | null>(null);
    const [show2FA, setShow2FA] = useState(false);
    const [isLoading2FA, setIsLoading2FA] = useState(false);
    const [twoFAError, setTwoFAError] = useState<string | null>(null);
    const [is2FAActivated, setIs2FAActivated] = useState(false);
    const [activationCode, setActivationCode] = useState("");
    const [isActivating2FA, setIsActivating2FA] = useState(false);
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [isChangingPassword, setIsChangingPassword] = useState(false);
    const [passwordError, setPasswordError] = useState<string | null>(null);

    // Telegram Bot and User Download State
    const [telegramBotConfig, setTelegramBotConfig] = useState<TelegramBotPublicConfig | null>(null);
    useEffect(() => { if (telegramBotConfig) publishBotStatus(telegramBotConfig); }, [telegramBotConfig]);
    const [telegramBotToken, setTelegramBotToken] = useState("");
    const [telegramApiId, setTelegramApiId] = useState("");
    const [telegramApiHash, setTelegramApiHash] = useState("");
    const [telegramPin, setTelegramPin] = useState("");
    const [showTelegramBotForm, setShowTelegramBotForm] = useState(false);
    const [isSavingTelegramBot, setIsSavingTelegramBot] = useState(false);
    const [showTelegramPinForm, setShowTelegramPinForm] = useState(false);
    const [telegramPinVerificationMethod, setTelegramPinVerificationMethod] = useState<'current_pin' | 'web_password'>('current_pin');
    const [telegramPinVerificationSecret, setTelegramPinVerificationSecret] = useState("");
    const [newTelegramPin, setNewTelegramPin] = useState("");
    const [confirmNewTelegramPin, setConfirmNewTelegramPin] = useState("");
    const [isChangingTelegramPin, setIsChangingTelegramPin] = useState(false);
    const [showTelegramUserDownload, setShowTelegramUserDownload] = useState(false);
    const [telegramAllowedUserIdsInput, setTelegramAllowedUserIdsInput] = useState("");
    const [isSavingTelegramAllowedUsers, setIsSavingTelegramAllowedUsers] = useState(false);
    const [cleanupRetentionDays, setCleanupRetentionDays] = useState(7);
    const [isCleaningDownloadItems, setIsCleaningDownloadItems] = useState(false);
    const [advancedTasks, setAdvancedTasks] = useState<AdvancedTaskSettings | null>(null);

    const reloadAdvancedTasks = useCallback(async () => {
        const data = await fileApi.getAdvancedTaskSettings();
        setAdvancedTasks(data);
        return data;
    }, []);

    useEffect(() => {
        if (activeSection !== 'maintenance') return;
        void reloadAdvancedTasks().catch((error: unknown) => {
            setActionNotice({ title: t('settings.remaining.copy.139'), message: errorMessage(error), tone: 'error' });
        });
    }, [activeSection, reloadAdvancedTasks, t]);

    const updateAdvancedTask = async (patch: Partial<Pick<AdvancedTaskSettings, 'telegramDownloadWorkers' | 'telegramFileConcurrency' | 'duplicateMode' | 'autoCleanupOrphans' | 'skipTelegramPhotosInBatch' | 'telegramDownloadHistoryPolicy'>>) => {
        try {
            let result: { success: boolean; deletedCount?: number };
            try {
                result = await fileApi.updateAdvancedTaskSetting(patch);
            } catch (error: unknown) {
                if (errorCode(error) !== 'CONFIRMATION_REQUIRED') throw error;
                const enablingPhotoFilter = patch.skipTelegramPhotosInBatch === true;
                const confirmationMessage = enablingPhotoFilter
                    ? t('settings.remaining.copy.129')
                    : t('settings.remaining.copy.130');
                const confirmationTitle = enablingPhotoFilter ? t('settings.remaining.copy.131') : t('settings.remaining.copy.132');
                if (!(await requestConfirmation(confirmationMessage, confirmationTitle))) return;
                result = await fileApi.updateAdvancedTaskSetting(patch, true);
            }
            await reloadAdvancedTasks();
            if ('telegramDownloadHistoryPolicy' in patch) {
                const message = patch.telegramDownloadHistoryPolicy === 'errors_only'
                    ? t('settings.remaining.copy.133', { value1: result.deletedCount || 0 })
                    : t('settings.remaining.copy.134');
                await showNotice(message);
            }
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || t('telegramDownloadHistoryPolicy' in patch ? 'settings.cards.maintenance.history.updateFailed' : 'settings.remaining.shared.unknownError'), t('settings.remaining.copy.139'), 'error');
            await reloadAdvancedTasks().catch(() => undefined);
        }
    };

    const handleCleanupDownloadItems = async () => {
        if (isCleaningDownloadItems) return;
        if (!(await requestConfirmation(t('settings.remaining.copy.135', { value1: cleanupRetentionDays }), t('settings.remaining.copy.136')))) return;
        setIsCleaningDownloadItems(true);
        try {
            const result = await fileApi.cleanupDownloadItems(cleanupRetentionDays);
            await showNotice(t('settings.remaining.copy.137', { value1: result.deletedCount }));
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || t('settings.remaining.copy.138'), t('settings.remaining.copy.139'));
        } finally {
            setIsCleaningDownloadItems(false);
        }
    };

    const botStatusRequest = useRef<AbortController | null>(null);
    const botRetryRequest = useRef<AbortController | null>(null);
    const [isRefreshingBot, setIsRefreshingBot] = useState(false);
    const [isRetryingBot, setIsRetryingBot] = useState(false);
    const [botStatusError, setBotStatusError] = useState(false);
    const [botRetryError, setBotRetryError] = useState('');
    const [botPollEpoch, setBotPollEpoch] = useState(0);
    const botSectionVisible = useRef(false);

    const reloadTelegramBotConfig = useCallback(async () => {
        if (!botSectionVisible.current) return;
        botStatusRequest.current?.abort();
        const controller = new AbortController();
        botStatusRequest.current = controller;
        setIsRefreshingBot(true);
        const timeout = window.setTimeout(() => controller.abort(), 15_000);
        try {
            const data = await fileApi.getTelegramBotConfig(controller.signal);
            if (!controller.signal.aborted) {
                setTelegramBotConfig(data);
                setBotStatusError(false);
            }
            return data;
        } catch {
            if (botStatusRequest.current === controller && botSectionVisible.current) setBotStatusError(true);
        } finally {
            window.clearTimeout(timeout);
            if (botStatusRequest.current === controller) {
                botStatusRequest.current = null;
                if (botSectionVisible.current) setIsRefreshingBot(false);
            }
        }
    }, []);

    useEffect(() => {
        if (activeSection !== 'telegram') return;
        let timer: number | undefined;
        let disposed = false;
        let pollGeneration = 0;
        const deadline = Date.now() + 120_000;
        const stop = () => {
            window.clearTimeout(timer);
            pollGeneration += 1;
            botSectionVisible.current = false;
            const request = botStatusRequest.current;
            botStatusRequest.current = null;
            request?.abort();
            botRetryRequest.current?.abort();
        };
        const poll = async () => {
            if (disposed || !botSectionVisible.current) return;
            const generation = pollGeneration;
            if (!botRetryRequest.current) await reloadTelegramBotConfig();
            if (!disposed && generation === pollGeneration && botSectionVisible.current && Date.now() + 5_000 < deadline) timer = window.setTimeout(poll, 5_000);
        };
        const visibilityChanged = () => {
            stop();
            if (document.visibilityState === 'visible') {
                botSectionVisible.current = true;
                setIsRefreshingBot(false);
                setIsRetryingBot(false);
                if (Date.now() < deadline) void poll();
            }
        };
        visibilityChanged();
        document.addEventListener('visibilitychange', visibilityChanged);
        return () => {
            disposed = true;
            stop();
            document.removeEventListener('visibilitychange', visibilityChanged);
        };
    }, [activeSection, botPollEpoch, reloadTelegramBotConfig]);

    const botFault = telegramBotConfig ? botFaultPresentation(telegramBotConfig) : null;
    const botRetryBlockReason = isSavingTelegramBot || isChangingTelegramPin ? 'configuring' : botFault?.retryBlockedReason;
    const botRetryBlocked = !botFault || Boolean(botRetryBlockReason);
    const botRetryLabel = t(isRetryingBot ? 'settings.botConnection.retrying' : 'settings.botConnection.retry');

    useEffect(() => {
        const remaining = Date.parse(telegramBotConfig?.retryAllowedAt || '') - Date.now();
        if (!(remaining > 0)) return;
        const timer = window.setTimeout(() => setBotPollEpoch(value => value + 1), Math.min(remaining, 2_147_483_647));
        return () => window.clearTimeout(timer);
    }, [telegramBotConfig?.retryAllowedAt]);

    const handleRetryTelegramBot = async () => {
        if (botRetryRequest.current || botRetryBlocked || !botFault?.offline) return;
        const controller = new AbortController();
        botRetryRequest.current = controller;
        botStatusRequest.current?.abort();
        setIsRetryingBot(true);
        setBotRetryError('');
        const timeout = window.setTimeout(() => controller.abort(), 20_000);
        try {
            await fileApi.retryTelegramBotConnection(controller.signal);
        } catch (error: unknown) {
            const code = errorCode(error);
            const reason = code === 'BOT_CLEANUP_UNCONFIRMED' ? 'cleanupBlocked'
                : code === 'BOT_RETRY_IN_PROGRESS' ? 'busy' : code === 'BOT_RETRY_COOLDOWN' ? 'retryCooldown'
                : code === 'BOT_DISABLED' ? 'disabledAction' : code === 'BOT_NOT_CONFIGURED' ? 'configureAction' : 'retryFailed';
            if (botSectionVisible.current) setBotRetryError(t(`settings.botConnection.${reason}`));
        } finally {
            window.clearTimeout(timeout);
            if (botSectionVisible.current) {
                // Read authoritative runtime state even when the retry request failed.
                await reloadTelegramBotConfig();
                if (botSectionVisible.current) {
                    setIsRetryingBot(false);
                    setBotPollEpoch(value => value + 1);
                }
            }
            botRetryRequest.current = null;
        }
    };

    const botStatus = !telegramBotConfig ? 'loading'
        : botFault?.quarantined ? 'quarantined'
        : !telegramBotConfig.configured ? 'not_configured'
        : !telegramBotConfig.enabled ? 'disabled'
        : telegramBotConfig.status === 'ready' ? botFault?.offline ? 'offline' : 'ready'
        : telegramBotConfig.status === 'starting' ? 'connecting'
        : telegramBotConfig.nextRetryAt ? 'waiting'
        : telegramBotConfig.status === 'reconnecting' ? 'connecting'
        : telegramBotConfig.status === 'auth_failed' ? 'auth_failed'
        : telegramBotConfig.status === 'stopped' ? 'stopped' : 'error';

    const clearTelegramBotInputs = () => {
        setTelegramBotToken('');
        setTelegramApiId('');
        setTelegramApiHash('');
        setTelegramPin('');
    };

    const handleCancelTelegramBotEdit = () => {
        clearTelegramBotInputs();
        setShowTelegramBotForm(false);
    };

    const clearTelegramPinChangeInputs = () => {
        setTelegramPinVerificationSecret('');
        setNewTelegramPin('');
        setConfirmNewTelegramPin('');
    };

    const handleCancelTelegramPinChange = () => {
        clearTelegramPinChangeInputs();
        setShowTelegramPinForm(false);
    };

    const handleChangeTelegramPin = async () => {
        if (!telegramPinVerificationSecret) {
            await showNotice(t('settings.remaining.copy.140', { value1: telegramPinVerificationMethod === 'current_pin' ? t('settings.remaining.copy.038') : t('settings.remaining.copy.039') }), t('settings.remaining.copy.141'));
            return;
        }
        if (!/^\d{4}$/.test(newTelegramPin)) {
            await showNotice(t('settings.remaining.copy.142'), t('settings.remaining.copy.141'));
            return;
        }
        if (newTelegramPin !== confirmNewTelegramPin) {
            await showNotice(t('settings.remaining.copy.144'), t('settings.remaining.copy.141'));
            return;
        }
        setIsChangingTelegramPin(true);
        try {
            const result = await fileApi.changeTelegramBotPin({
                verificationMethod: telegramPinVerificationMethod,
                verificationSecret: telegramPinVerificationSecret,
                newPin: newTelegramPin,
            });
            handleCancelTelegramPinChange();
            await reloadTelegramBotConfig();
            await showNotice(result.message || t('settings.remaining.copy.146'));
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || t('settings.remaining.copy.147'), t('settings.remaining.copy.141'));
        } finally {
            setIsChangingTelegramPin(false);
        }
    };

    const handleTestTelegramBot = async () => {
        setIsSavingTelegramBot(true);
        try {
            const result = await fileApi.testTelegramBotConfig({ botToken: telegramBotToken, apiId: telegramApiId, apiHash: telegramApiHash });
            await showNotice(t('settings.botConnection.probeSuccess', { value1: result.bot.username ? `: @${result.bot.username}` : '' }));
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || t('settings.remaining.copy.150'), t('settings.remaining.copy.151'));
        } finally { setIsSavingTelegramBot(false); }
    };

    const handleSaveTelegramBot = async () => {
        if (!telegramBotConfig?.pinConfigured && !/^\d{4}$/.test(telegramPin)) {
            await showNotice(t('settings.remaining.copy.152'), t('settings.remaining.copy.153'));
            return;
        }
        setIsSavingTelegramBot(true);
        try {
            const result = await fileApi.saveTelegramBotConfig({ botToken: telegramBotToken, apiId: telegramApiId, apiHash: telegramApiHash, enabled: true, required: false, telegramPin: telegramBotConfig?.pinConfigured ? undefined : telegramPin });
            setTelegramBotConfig(result.config);
            clearTelegramBotInputs();
            setShowTelegramBotForm(false);
            await showNotice(t('settings.remaining.copy.154'));
        } catch (error: unknown) {
            await reloadTelegramBotConfig();
            setBotPollEpoch(value => value + 1);
            await showNotice(errorMessage(error) || t('settings.remaining.copy.155'), t('settings.remaining.copy.153'));
        } finally { setIsSavingTelegramBot(false); }
    };

    const handleMigrateTelegramBot = async () => {
        if (!telegramBotConfig?.pinConfigured && !/^\d{4}$/.test(telegramPin)) {
            await showNotice(t('settings.remaining.copy.157'), t('settings.remaining.copy.158'));
            return;
        }
        if (!(await requestConfirmation(t('settings.remaining.copy.159'), t('settings.remaining.copy.160')))) return;
        setIsSavingTelegramBot(true);
        try {
            const result = await fileApi.migrateTelegramBotConfig({ telegramPin: telegramBotConfig?.pinConfigured ? undefined : telegramPin });
            setTelegramBotConfig(result.config);
            setTelegramPin('');
            await showNotice(t('settings.remaining.copy.161'));
        } catch (error: unknown) { await showNotice(errorMessage(error) || t('settings.remaining.copy.162'), t('settings.remaining.copy.162')); }
        finally { setIsSavingTelegramBot(false); }
    };

    const handleDeleteTelegramBot = async () => {
        if (!(await requestConfirmation(
            t('settings.remaining.copy.164'),
            t('settings.remaining.copy.165'),
            { tone: 'danger', dangerDescription: t('settings.remaining.copy.166'), cancelLabel: t('settings.remaining.copy.167'), confirmLabel: t('settings.remaining.copy.168') },
        ))) return;
        setIsSavingTelegramBot(true);
        try { const result = await fileApi.deleteTelegramBotConfig(); setTelegramBotConfig(result.config); clearTelegramBotInputs(); setShowTelegramBotForm(true); await showNotice(t('settings.remaining.copy.169')); }
        catch (error: unknown) { await showNotice(errorMessage(error) || t('settings.remaining.copy.170'), t('settings.remaining.copy.139')); }
        finally { setIsSavingTelegramBot(false); }
    };

    const handleSaveTelegramAllowedUsers = async () => {
        if (isSavingTelegramAllowedUsers) return;
        setIsSavingTelegramAllowedUsers(true);
        try {
            const result = await fileApi.setTelegramAllowedUserIds(telegramAllowedUserIdsInput);
            setTelegramAllowedUserIdsInput(result.userIds.join(', '));
            await reloadStorageConfig();
            await showNotice(t('settings.remaining.copy.172'));
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || t('settings.remaining.copy.173'), t('settings.remaining.copy.153'));
        } finally {
            setIsSavingTelegramAllowedUsers(false);
        }
    };

    const reloadStorageConfig = async () => {
        const data = await synchronizeStorageConfig({
            loadConfig: () => fileApi.getStorageConfig(),
            publishConfig: nextConfig => {
                setConfig(nextConfig);
                onStorageConfigChanged?.(nextConfig);
            },
        });
        setStorageLoadError(null);
        setShowTelegramUserDownload(!!data.telegramUserDownloadEnabled);
        setTelegramAllowedUserIdsInput((data.telegramAllowedUserIds || []).join(', '));
        return data;
    };


    const handleCheckForUpdates = async () => {
        if (isCheckingUpdates) return;
        setIsCheckingUpdates(true);
        try {
            const status = await fileApi.checkForUpdates();
            setUpdateStatus(status);
            window.dispatchEvent(new CustomEvent('tgvault:update-status', { detail: status }));
            await showNotice(status.updateAvailable
                ? t('updates.found', { version: status.latestVersion })
                : t('updates.alreadyLatest', { version: status.currentVersion }));
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || t('settings.remaining.copy.175'), t('settings.remaining.copy.176'));
        } finally {
            setIsCheckingUpdates(false);
        }
    };


    // Load initial config
    useEffect(() => {
        const loadConfig = async () => {
            try {
                const [, versionStatus] = await Promise.all([reloadStorageConfig(), fileApi.getUpdateStatus()]);
                setUpdateStatus(versionStatus);
            } catch (error) {
                setStorageLoadError(errorMessage(error));
            }
        };
        loadConfig();
    }, []);



    const handleUnsafeWebdavToggle = async () => {
        if (!config || isSavingWebdavSecurity) return;
        const enabled = !config.allowUnsafeWebdavEndpoints;
        let confirmed = false;
        if (enabled) {
            confirmed = await requestConfirmation(
                t('settings.cards.security.unsafeWebdav.confirmation'),
                t('settings.cards.security.unsafeWebdav.confirmationTitle'),
                { tone: 'danger', dangerDescription: t('settings.cards.security.unsafeWebdav.dangerDescription'), cancelLabel: t('settings.cards.security.unsafeWebdav.keepDisabled'), confirmLabel: t('settings.cards.security.unsafeWebdav.confirmEnable') },
            );
            if (!confirmed) return;
        }
        setIsSavingWebdavSecurity(true);
        try {
            const result = await fileApi.setUnsafeWebdavEndpointsAllowed(enabled, confirmed);
            setConfig(previous => previous ? { ...previous, allowUnsafeWebdavEndpoints: result.allowUnsafeWebdavEndpoints } : previous);
            await showNotice(t(enabled ? 'settings.cards.security.unsafeWebdav.enabledNotice' : 'settings.cards.security.unsafeWebdav.disabledNotice'));
        } catch (error: unknown) {
            if (errorCode(error) === 'CONFIRMATION_REQUIRED') {
                await showNotice(t('settings.cards.security.unsafeWebdav.confirmationRequired'), t('settings.cards.security.unsafeWebdav.confirmationIncomplete'));
            } else {
                await showNotice(errorMessage(error) || t('settings.cards.security.unsafeWebdav.updateFailed'), t('settings.remaining.copy.139'));
            }
        } finally {
            setIsSavingWebdavSecurity(false);
        }
    };


    const handleSetup2FA = async () => {
        if (show2FA) {
            setShow2FA(false);
            return;
        }

        setIsLoading2FA(true);
        setTwoFAError(null);
        try {
            const data = await authService.get2FASetupInfo();
            setTwoFAQrCode(data.qrDataUrl);
            setIs2FAActivated(data.enabled);
            setShow2FA(true);
        } catch (error: unknown) {
            setTwoFAError(errorMessage(error));
        } finally {
            setIsLoading2FA(false);
        }
    };

    const handleActivate2FA = async () => {
        if (!activationCode) return;
        setIsActivating2FA(true);
        setTwoFAError(null);
        try {
            const result = await authService.activate2FA(activationCode);
            if (result.success) {
                setIs2FAActivated(true);
                setActivationCode("");
            } else {
                setTwoFAError(result.error || t('settings.cards.security.twoFactor.verificationFailed'));
            }
        } catch (error: unknown) {
            setTwoFAError(errorMessage(error));
        } finally {
            setIsActivating2FA(false);
        }
    };

    const handleDisable2FA = async () => {
        const password = await requestInput(t('settings.cards.security.twoFactor.disablePrompt'), t('settings.cards.security.twoFactor.disableTitle'), 'password');
        if (!password) return;

        setIsLoading2FA(true);
        try {
            const result = await authService.disable2FA(password);
            if (result.success) {
                setIs2FAActivated(false);
                setShow2FA(false);
            } else {
                await showNotice(result.error || t('settings.cards.security.twoFactor.disableFailed'), t('settings.remaining.copy.139'));
            }
        } catch (error: unknown) {
            await showNotice(errorMessage(error), t('settings.remaining.copy.139'));
        } finally {
            setIsLoading2FA(false);
        }
    };

    const handleChangePassword = async () => {
        if (isChangingPassword) return;
        if (newPassword.length < 8) return setPasswordError(t('settings.cards.security.changePassword.tooShort'));
        if (newPassword !== confirmPassword) return setPasswordError(t('settings.cards.security.changePassword.mismatch'));
        setIsChangingPassword(true);
        setPasswordError(null);
        try {
            const result = await authService.changePassword(currentPassword, newPassword);
            if (!result.success) return setPasswordError(result.error || t('settings.cards.security.changePassword.failed'));
            onSignedOut?.();
        } finally {
            setIsChangingPassword(false);
        }
    };

    return (
        <motion.div
            data-testid="settings-page"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="settings-surface settings-page"
        >
            <AnimatePresence>
                {actionNotice && <ActionNotice state={actionNotice} onClose={closeActionNotice} />}
            </AnimatePresence>
            {actionDialog && (
                <ActionDialog
                    state={actionDialog}
                    input={actionDialogInput}
                    onInput={setActionDialogInput}
                    onCancel={() => closeActionDialog(false)}
                    onConfirm={() => closeActionDialog(true)}
                />
            )}
            <header className="tv-page-header settings-page__header">
                <span className="settings-icon" aria-hidden="true"><Palette className="h-5 w-5" /></span>
                <div className="min-w-0">
                    <h2>{t(SETTINGS_SECTIONS.find(section => section.id === activeSection)!.labelKey)}</h2>
                </div>
            </header>

            <nav
                data-testid="settings-tabs"
                className="settings-nav"
                aria-label={t('settings.title')}
            >
                {SETTINGS_SECTIONS.map(section => (
                    <Button
                        key={section.id}
                        size="sm"
                        variant="ghost"
                        className="settings-nav__item"
                        onClick={() => onSectionChange(section.id)}
                        ref={element => { if (element && activeSection === section.id) { const nav = element.parentElement; if (nav) nav.scrollLeft = Math.max(0, element.offsetLeft - nav.offsetLeft - 8); } }}
                        aria-current={activeSection === section.id ? 'page' : undefined}
                    >
                        {t(section.labelKey)}
                    </Button>
                ))}
            </nav>

            {activeSection === 'general' && <SettingsWorkspace guide={null} className="settings-workspace--general">
            {/* General Section: Language & Theme */}
            <div className="tv-panel settings-section">
                <SettingsRow
                    icon={Globe}
                    label={t("settings.general.language")}
                    action={<LanguageToggle />}
                />
            <AppearanceSettings />
            </div>
            <QbittorrentSettings />
            <SettingsSection title={t('updates.settingsTitle')}>
                <div className="settings-version-compact">
                    <div className="settings-version-compact__facts">
                            <span className="text-[12px] text-muted-foreground">{t('updates.current', { version: updateStatus?.currentVersion || '—' })}</span>
                            <span className={cn("rounded-full px-2 py-1 text-[12px] font-semibold", updateStatus?.updateAvailable ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-200" : "bg-muted text-muted-foreground")}>
                                {updateStatus?.updateAvailable ? t('updates.latest', { version: updateStatus.latestVersion }) : updateStatus?.latestVersion ? t('updates.upToDate') : t('updates.waiting')}
                            </span>
                    </div>
                    <p className="settings-help">{updateStatus?.checkedAt
                        ? `${t('updates.lastChecked', { time: formatDateTime(updateStatus.checkedAt, i18n.resolvedLanguage || i18n.language) })}${updateStatus.stale ? t('updates.staleSuffix') : ''}`
                        : updateStatus?.enabled === false ? t('updates.disabled') : t('updates.notChecked')}</p>
                    <div className="settings-version-compact__actions">
                            {updateStatus?.releaseUrl && (
                                <a href={updateStatus.releaseUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-[12px] font-medium hover:bg-muted">
                                    {t('updates.releaseNotes')} <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                            )}
                            <Button size="sm" variant="outline" disabled={isCheckingUpdates || updateStatus?.enabled === false} onClick={() => void handleCheckForUpdates()}>
                                {isCheckingUpdates ? <IndeterminateSpinner label={t('updates.checking')} size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                {t('updates.checkNow')}
                            </Button>
                    </div>
                </div>
            </SettingsSection>
            </SettingsWorkspace>}

            {activeSection === 'security' && <SettingsWorkspace guide={null}>
            {/* Security Section */}
            {/* i18n source: 安全设置 */}
            <SettingsSection title={t('settings.security.title')}>
                <div className="border-b border-border/50 p-4 space-y-4">
                    <div className="flex items-start gap-3">
                        <div className="settings-icon"><KeyRound className="h-4 w-4" /></div>
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium">{t('settings.cards.security.changePassword.title')}</p>
                            <p className="text-[12px] text-muted-foreground mt-1">{t('settings.cards.security.changePassword.description')}</p>
                        </div>
                    </div>
                    <div className="settings-form-grid settings-form-grid--password">
                        <SettingsField label={t('settings.cards.security.changePassword.currentPassword')}>
                            <input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} placeholder={t('settings.cards.security.changePassword.currentPassword')} className="h-10 px-3" />
                        </SettingsField>
                        <SettingsField label={t('settings.cards.security.changePassword.newPassword')}>
                            <input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder={t('settings.cards.security.changePassword.newPassword')} className="h-10 px-3" />
                        </SettingsField>
                        <SettingsField label={t('settings.cards.security.changePassword.confirmPassword')}>
                            <input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder={t('settings.cards.security.changePassword.confirmPassword')} className="h-10 px-3" />
                        </SettingsField>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                        <p className="text-[12px] text-destructive">{passwordError}</p>
                        <Button size="sm" onClick={handleChangePassword} disabled={isChangingPassword || !currentPassword || !newPassword || !confirmPassword}>
                            {t(isChangingPassword ? 'settings.cards.security.changePassword.changing' : 'settings.cards.security.changePassword.changeAndSignOut')}
                        </Button>
                    </div>
                </div>
                <SettingsRow
                    icon={Shield}
                    label={t('settings.cards.security.twoFactor.title')}
                    description={t('settings.cards.security.twoFactor.description')}
                    action={
                        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                            {is2FAActivated && (
                                <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 settings-text-success">
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                    <span className="text-[12px] font-semibold">{t('settings.cards.security.twoFactor.enabled')}</span>
                                </div>
                            )}
                            <Button
                                size="sm"
                                variant={show2FA ? "outline" : "default"}
                                onClick={handleSetup2FA}
                                disabled={isLoading2FA}
                            >
                                {isLoading2FA ? t('settings.cards.security.twoFactor.loading') : (show2FA ? t('settings.cards.security.twoFactor.hide') : (is2FAActivated ? t('settings.cards.security.twoFactor.reconfigure') : t('settings.cards.security.twoFactor.setup')))}
                            </Button>
                            {is2FAActivated && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-destructive hover:bg-destructive/10"
                                    onClick={handleDisable2FA}
                                    disabled={isLoading2FA}
                                >
                                    {t('settings.cards.security.twoFactor.disable')}
                                </Button>
                            )}
                        </div>
                    }
                />

                <AnimatePresence>
                    {show2FA && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="bg-muted/30 border-t border-border/50 overflow-hidden"
                        >
                            <div className="p-6 flex flex-col items-center text-center space-y-4">
                                {twoFAQrCode ? (
                                    <div className="w-full max-w-xs space-y-4">
                                        <div className="settings-qr">
                                            <img src={twoFAQrCode} alt={t('settings.cards.security.twoFactor.qrAlt')} className="w-48 h-48" />
                                        </div>

                                        <div className="space-y-2">
                                            <p className="text-[13px] font-medium">{t('settings.cards.security.twoFactor.scanTitle')}</p>
                                            <p className="text-[12px] text-muted-foreground">
                                                {t('settings.cards.security.twoFactor.scanDescription')}
                                            </p>
                                        </div>

                                        {!is2FAActivated ? (
                                            <div className="pt-2 space-y-3">
                                                <p className="text-[13px] font-medium">{t('settings.cards.security.twoFactor.verifyTitle')}</p>
                                                <p className="text-[12px] text-muted-foreground">
                                                    {t('settings.cards.security.twoFactor.verifyDescription')}
                                                </p>
                                                <div className="settings-actions justify-center">
                                                    <input
                                                        type="text"
                                                        maxLength={6}
                                                        aria-label={t('settings.cards.security.twoFactor.verifyTitle')}
                                                        autoComplete="one-time-code"
                                                        inputMode="numeric"
                                                        value={activationCode}
                                                        onChange={(e) => setActivationCode(e.target.value.replace(/\D/g, ''))}
                                                        className="w-32 px-3 py-2 text-center text-lg tracking-widest font-mono"
                                                        placeholder="000000"
                                                    />
                                                    <Button
                                                        onClick={handleActivate2FA}
                                                        disabled={isActivating2FA || activationCode.length !== 6}
                                                    >
                                                        {t(isActivating2FA ? 'settings.cards.security.twoFactor.activating' : 'settings.cards.security.twoFactor.activate')}
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="pt-2">
                                                <div className="flex items-center gap-2 justify-center settings-text-success">
                                                    <ShieldCheck className="h-4 w-4" />
                                                    <p className="text-[13px] font-medium">{t('settings.cards.security.twoFactor.activeStatus')}</p>
                                                </div>
                                                <p className="text-[12px] text-muted-foreground mt-1">
                                                    {t('settings.cards.security.twoFactor.activeDescription')}
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="py-4 text-destructive flex flex-col items-center gap-2">
                                        <ShieldAlert className="h-8 w-8" />
                                        <p className="text-[13px]">{twoFAError || t('settings.cards.security.twoFactor.loadFailed')}</p>
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </SettingsSection>
            {/* i18n source: 网络与存储安全 */}
            <SettingsSection title={t('settings.security.networkTitle')}>
                <div className={cn("p-4 sm:p-5", config?.allowUnsafeWebdavEndpoints && "bg-destructive/[0.035]")}>
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3">
                            <div className={cn("rounded-[7px] p-2", config?.allowUnsafeWebdavEndpoints ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                                <Network className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-[13px] font-medium">{t('settings.cards.security.unsafeWebdav.title')}</p>
                                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", config?.allowUnsafeWebdavEndpoints ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                                        {t(config?.allowUnsafeWebdavEndpoints ? 'settings.cards.security.unsafeWebdav.highRisk' : 'settings.cards.security.unsafeWebdav.recommendedOff')}
                                    </span>
                                </div>
                                <p className="mt-1 max-w-2xl text-[12px] leading-5 text-muted-foreground">{t('settings.cards.security.unsafeWebdav.description')}</p>
                            </div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={!!config?.allowUnsafeWebdavEndpoints}
                            aria-label={t('settings.cards.security.unsafeWebdav.title')}
                            onClick={handleUnsafeWebdavToggle}
                            disabled={!config || isSavingWebdavSecurity}
                            className="settings-switch-target disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <span aria-hidden="true" className={cn("settings-switch-track", config?.allowUnsafeWebdavEndpoints ? "border-destructive bg-destructive" : "border-border bg-muted")}>
                                <span className={cn("settings-switch-thumb absolute left-0 top-0.5 h-[22px] w-[22px] rounded-full shadow-sm transition-transform", config?.allowUnsafeWebdavEndpoints ? "translate-x-6" : "translate-x-0.5")} />
                            </span>
                            <span className="sr-only">{t(isSavingWebdavSecurity ? 'settings.cards.security.unsafeWebdav.saving' : config?.allowUnsafeWebdavEndpoints ? 'settings.cards.security.unsafeWebdav.enabled' : 'settings.cards.security.unsafeWebdav.disabled')}</span>
                        </button>
                    </div>
                </div>
            </SettingsSection>
            </SettingsWorkspace>}

            {activeSection === 'maintenance' && <SettingsWorkspace guide={null}>
            {/* i18n source: 高级任务设置 */}
            <SettingsSection title={t('settings.maintenance.advancedTasks')}>
                {advancedTasks ? <div className="divide-y divide-border/50">
                    <SettingsRow icon={Gauge} label={t('settings.cards.maintenance.chunkConcurrency.title')} description={t('settings.cards.maintenance.chunkConcurrency.description')} action={
                        <select aria-label={t('settings.cards.maintenance.chunkConcurrency.title')} className="h-10 px-3" value={advancedTasks.telegramDownloadWorkers} onChange={event => void updateAdvancedTask({ telegramDownloadWorkers: Number(event.target.value) })}>
                            {[4, 6, 8, 10, 12].map(value => <option key={value} value={value}>{value}</option>)}
                        </select>
                    } />
                    <SettingsRow icon={Gauge} label={t('settings.cards.maintenance.fileConcurrency.title')} description={`${t('settings.cards.maintenance.fileConcurrency.description')} ${t('settings.cards.maintenance.fileConcurrency.limitDescription', { enabledAccounts: advancedTasks.telegramEnabledAccounts, limit: advancedTasks.telegramFileConcurrencyLimit })}`} action={
                        <select aria-label={t('settings.cards.maintenance.fileConcurrency.title')} className="h-10 px-3" value={advancedTasks.telegramFileConcurrency} onChange={event => void updateAdvancedTask({ telegramFileConcurrency: Number(event.target.value) })}>
                            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(value => <option key={value} value={value} disabled={value > advancedTasks.telegramFileConcurrencyLimit}>{value}</option>)}
                        </select>
                    } />
                    <SettingsRow icon={Copy} label={t('settings.cards.maintenance.duplicateMode.title')} description={t('settings.cards.maintenance.duplicateMode.description')} action={
                        <select aria-label={t('settings.cards.maintenance.duplicateMode.title')} className="h-10 px-3" value={advancedTasks.duplicateMode} onChange={event => void updateAdvancedTask({ duplicateMode: event.target.value as 'copy' | 'skip' })}>
                            <option value="copy">{t('settings.cards.maintenance.duplicateMode.copy')}</option><option value="skip">{t('settings.cards.maintenance.duplicateMode.skip')}</option>
                        </select>
                    } />
                    <SettingsRow className="settings-row--maintenance-toggle" icon={Copy} label={t('settings.cards.maintenance.skipPhotos.title')} description={t('settings.cards.maintenance.skipPhotos.description')} action={
                        <button type="button" role="switch" className="settings-switch-target settings-maintenance-switch" aria-label={t('settings.cards.maintenance.skipPhotos.title')} aria-checked={advancedTasks.skipTelegramPhotosInBatch} onClick={() => void updateAdvancedTask({ skipTelegramPhotosInBatch: !advancedTasks.skipTelegramPhotosInBatch })}>
                            <span aria-hidden="true" className={cn('settings-switch-track', advancedTasks.skipTelegramPhotosInBatch && 'is-enabled')}><span /></span>
                            <span className="sr-only">{t(advancedTasks.skipTelegramPhotosInBatch ? 'settings.cards.maintenance.enabled' : 'settings.cards.maintenance.disabled')}</span>
                        </button>
                    } />
                    <SettingsRow className="settings-row--maintenance-toggle" icon={Trash2} label={t('settings.cards.maintenance.cleanupOrphans.title')} description={t('settings.cards.maintenance.cleanupOrphans.description')} action={
                        <button type="button" role="switch" className="settings-switch-target settings-maintenance-switch" aria-label={t('settings.cards.maintenance.cleanupOrphans.title')} aria-checked={advancedTasks.autoCleanupOrphans} onClick={() => void updateAdvancedTask({ autoCleanupOrphans: !advancedTasks.autoCleanupOrphans })}>
                            <span aria-hidden="true" className={cn('settings-switch-track', advancedTasks.autoCleanupOrphans && 'is-enabled')}><span /></span>
                            <span className="sr-only">{t(advancedTasks.autoCleanupOrphans ? 'settings.cards.maintenance.enabled' : 'settings.cards.maintenance.disabled')}</span>
                        </button>
                    } />
                </div> : <div className="p-6 text-[13px] text-muted-foreground">{t('settings.cards.maintenance.loadingAdvanced')}</div>}
            </SettingsSection>
            {/* i18n source: 数据维护 */}
            <SettingsSection title={t('settings.maintenance.title')}>
                <SettingsRow
                    icon={Database}
                    label={t('settings.cards.maintenance.history.title')}
                    description={t('settings.cards.maintenance.history.description')}
                    stackActionOnMobile
                    action={advancedTasks ? (
                        <select
                            value={advancedTasks.telegramDownloadHistoryPolicy}
                            onChange={(event) => void updateAdvancedTask({ telegramDownloadHistoryPolicy: event.target.value as AdvancedTaskSettings['telegramDownloadHistoryPolicy'] })}
                            className="h-10 w-full px-3 sm:w-auto sm:min-w-48"
                            aria-label={t('settings.cards.maintenance.history.policyLabel')}
                        >
                            <option value="errors_only">{t('settings.cards.maintenance.history.errorsOnly')}</option>
                            <option value="all">{t('settings.cards.maintenance.history.all')}</option>
                        </select>
                    ) : <span className="text-[13px] text-muted-foreground">{t('settings.cards.maintenance.loading')}</span>}
                />
                <SettingsRow
                    className="settings-row--maintenance-cleanup"
                    icon={Trash2}
                    label={t('settings.cards.maintenance.cleanupHistory.title')}
                    description={t('settings.cards.maintenance.cleanupHistory.description')}
                    stackActionOnMobile
                    action={
                        <div className="settings-maintenance-cleanup-actions">
                            <select
                                aria-label={t('settings.cards.maintenance.cleanupHistory.title')}
                                value={cleanupRetentionDays}
                                onChange={(e) => setCleanupRetentionDays(Number(e.target.value))}
                                className="settings-maintenance-retention"
                                disabled={isCleaningDownloadItems}
                            >
                                {[1, 7, 30, 90].map(days => <option key={days} value={days}>{t('settings.cards.maintenance.cleanupHistory.keepDays', { count: days })}</option>)}
                            </select>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={handleCleanupDownloadItems}
                                disabled={isCleaningDownloadItems}
                            >
                                {t(isCleaningDownloadItems ? 'settings.cards.maintenance.cleanupHistory.cleaning' : 'settings.cards.maintenance.cleanupHistory.cleanNow')}
                            </Button>
                        </div>
                    }
                />
            </SettingsSection>
            </SettingsWorkspace>}

            {activeSection === 'telegram' && <div className="settings-group settings-group--telegram">
            {/* Telegram Download Section */}
            {/* i18n source: Telegram Bot 连接 */}
            <SettingsSection title={t('settings.telegram.botConnection')} actions={
                <Button size="icon" variant="ghost"
                    aria-label={t(isRefreshingBot ? 'settings.botConnection.refreshing' : 'settings.botConnection.refresh')}
                    title={t('settings.botConnection.refresh')}
                    disabled={isRefreshingBot || isRetryingBot || isSavingTelegramBot}
                    onClick={() => setBotPollEpoch(value => value + 1)}>
                    <RefreshCw className={cn('h-4 w-4', isRefreshingBot && 'animate-spin')} aria-hidden="true" />
                </Button>
            }>
                <div className="p-4 space-y-4">
                    <div className="settings-bot-overview">
                        <div className="flex min-w-0 items-start gap-3">
                            <div className="settings-icon"><KeyRound className="h-4 w-4" /></div>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-[13px] font-medium">{t('settings.remaining.copy.021')}</span>
                                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", botStatus === 'ready' ? "bg-green-500/10 settings-text-success" : telegramBotConfig?.configured ? "bg-amber-500/10 settings-text-warning" : "bg-muted text-muted-foreground")}>{t(`settings.botConnection.${botStatus}`)}</span>
                                    {telegramBotConfig?.source === 'environment' && <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-semibold text-primary">{t('settings.remaining.copy.022')}</span>}
                                    {telegramBotConfig?.source === 'web' && <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold settings-text-success">{t('settings.remaining.copy.023')}</span>}
                                </div>
                                {telegramBotConfig?.configured && <div className="mt-2 text-[12px] leading-5 text-muted-foreground">
                                    {telegramBotConfig.bot?.username && <p>Bot：@{telegramBotConfig.bot.username}</p>}
                                    <BotFaultDetails config={telegramBotConfig} />
                                    {telegramBotConfig.enabled && botFault?.offline && <p>{t('settings.remaining.shared.runtimeNotReady')}</p>}
                                    {telegramBotConfig.nextRetryAt && telegramBotConfig.enabled && <p>{t('settings.botConnection.nextRetryAt')}: {formatDateTime(telegramBotConfig.nextRetryAt, i18n.resolvedLanguage || i18n.language)}</p>}
                                </div>}
                            </div>
                        </div>
                        <div className="w-full sm:w-auto">
                            {telegramBotConfig?.source === 'environment' && <div className="flex flex-wrap gap-2 sm:justify-end"><Button size="sm" onClick={handleMigrateTelegramBot} disabled={isSavingTelegramBot}>{t('settings.remaining.copy.026')}</Button>{telegramBotConfig?.configured && <Button size="sm" variant="outline" disabled={isChangingTelegramPin} onClick={() => { if (showTelegramPinForm) handleCancelTelegramPinChange(); else { handleCancelTelegramBotEdit(); clearTelegramPinChangeInputs(); setTelegramPinVerificationMethod(telegramBotConfig.pinConfigured ? 'current_pin' : 'web_password'); setShowTelegramPinForm(true); } }}>{showTelegramPinForm ? (telegramBotConfig.pinConfigured ? t('settings.remaining.copy.322') : t('settings.remaining.copy.323')) : (telegramBotConfig.pinConfigured ? t('settings.remaining.copy.324') : t('settings.remaining.copy.325'))}</Button>}</div>}
                            {telegramBotConfig?.source === 'web' && <div className="settings-actions settings-actions--bot">
                                <Button size="sm" variant="outline" className="settings-action" disabled={isSavingTelegramBot} onClick={() => { if (showTelegramBotForm) handleCancelTelegramBotEdit(); else { handleCancelTelegramPinChange(); clearTelegramBotInputs(); setShowTelegramBotForm(true); } }}>{showTelegramBotForm ? t('settings.remaining.copy.326') : t('settings.remaining.copy.327')}</Button>
                                <Button size="sm" variant="outline" className="settings-action" disabled={isChangingTelegramPin} onClick={() => { if (showTelegramPinForm) handleCancelTelegramPinChange(); else { handleCancelTelegramBotEdit(); clearTelegramPinChangeInputs(); setTelegramPinVerificationMethod(telegramBotConfig.pinConfigured ? 'current_pin' : 'web_password'); setShowTelegramPinForm(true); } }}>{showTelegramPinForm ? (telegramBotConfig.pinConfigured ? t('settings.remaining.copy.322') : t('settings.remaining.copy.323')) : (telegramBotConfig.pinConfigured ? t('settings.remaining.copy.324') : t('settings.remaining.copy.325'))}</Button>
                                <Button size="sm" variant="outline" className="settings-action" onClick={handleRetryTelegramBot}
                                    disabled={botRetryBlocked || isRetryingBot}
                                    title={botRetryBlockReason ? t(`settings.botConnection.${botRetryBlockReason}`) : t('settings.botConnection.retryHelp')}>
                                    {botRetryLabel}
                                </Button>
                                <Button size="sm" variant="destructive" className="settings-action" onClick={handleDeleteTelegramBot} disabled={isSavingTelegramBot}>{t('settings.remaining.copy.027')}</Button>
                            </div>}
                        </div>
                        {telegramBotConfig?.configured && !telegramBotConfig.pinConfigured && <p className="mt-3 rounded-[7px] border border-amber-300/60 bg-amber-500/10 px-3 py-2.5 text-[13px] settings-text-warning">{t('settings.remaining.copy.028')}</p>}
                        {!telegramBotConfig?.pinConfigured && telegramBotConfig?.source === 'environment' && <SettingsField label={t('settings.remaining.copy.029')} className="mt-4"><input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="new-password" value={telegramPin} onChange={event => setTelegramPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={t('settings.remaining.shared.createPinBeforeMigration')} className="w-full px-3 py-2" /><p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.030')}</p></SettingsField>}
                    </div>

                    {(telegramBotConfig?.source !== 'web' || isSavingTelegramBot || isChangingTelegramPin || botStatusError || botRetryError) && <div className="space-y-2" data-testid="bot-runtime-controls">
                        {telegramBotConfig?.source !== 'web' && telegramBotConfig?.configured && <Button size="sm" onClick={handleRetryTelegramBot}
                            disabled={botRetryBlocked || isRetryingBot}
                            title={botRetryBlockReason ? t(`settings.botConnection.${botRetryBlockReason}`) : t('settings.botConnection.retryHelp')}>
                            {botRetryLabel}
                        </Button>}
                        <div aria-live="polite">
                            {(isSavingTelegramBot || isChangingTelegramPin) && <p className="text-sm">{t('settings.botConnection.configuring')}</p>}
                            {botStatusError && <p className="text-destructive text-sm">{t('settings.botConnection.refreshFailed')}</p>}
                            {botRetryError && <p className="text-destructive text-sm">{botRetryError}</p>}
                        </div>
                    </div>}

                    {(!telegramBotConfig?.configured || showTelegramBotForm) && <SettingsFormLayout guide={<p className="settings-help">{t('settings.botConnection.probeHelp')}</p>}>
                        <div className="settings-form-grid">
                            <SettingsField label="Bot Token" className="md:col-span-2"><input type="password" autoComplete="new-password" value={telegramBotToken} onChange={event => setTelegramBotToken(event.target.value)} placeholder={t('settings.remaining.copy.333')} className="w-full px-3 py-2" /></SettingsField>
                            <SettingsField label="API ID"><input type="password" inputMode="numeric" autoComplete="new-password" value={telegramApiId} onChange={event => setTelegramApiId(event.target.value)} placeholder={t('settings.remaining.copy.334')} className="w-full px-3 py-2" /></SettingsField>
                            <SettingsField label="API Hash"><input type="password" autoComplete="new-password" value={telegramApiHash} onChange={event => setTelegramApiHash(event.target.value)} placeholder={t('settings.remaining.copy.335')} className="w-full px-3 py-2" /></SettingsField>
                            {telegramBotConfig?.pinConfigured && <p className="md:col-span-2 rounded-[7px] border border-border bg-background px-3 py-2.5 text-[13px] text-muted-foreground">{t('settings.remaining.copy.031')}</p>}
                            {!telegramBotConfig?.pinConfigured && <SettingsField label={t('settings.remaining.copy.029')} className="md:col-span-2"><input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="new-password" value={telegramPin} onChange={event => setTelegramPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={t('settings.remaining.shared.pinInitialVerification')} className="w-full px-3 py-2" /><p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.033')}</p></SettingsField>}
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">{telegramBotConfig?.configured && <Button variant="ghost" onClick={handleCancelTelegramBotEdit} disabled={isSavingTelegramBot}>{t('settings.remaining.copy.034')}</Button>}<Button variant="outline" onClick={handleTestTelegramBot} disabled={isSavingTelegramBot || !telegramBotToken || !telegramApiId || !telegramApiHash}>{t('settings.botConnection.probe')}</Button><Button onClick={handleSaveTelegramBot} disabled={isSavingTelegramBot || !telegramBotToken || !telegramApiId || !telegramApiHash}>{isSavingTelegramBot ? t('settings.remaining.copy.337') : t('settings.remaining.copy.338')}</Button></div>
                    </SettingsFormLayout>}

                    {showTelegramPinForm && telegramBotConfig?.configured && <div className="rounded-[10px] border border-border bg-muted/20 p-4 space-y-4">
                        <div>
                            <h4 className="text-[13px] font-semibold">{telegramBotConfig.pinConfigured ? t('settings.remaining.copy.339') : t('settings.remaining.copy.340')}</h4>
                            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{telegramBotConfig.pinConfigured ? t('settings.remaining.copy.341') : t('settings.remaining.copy.342')}</p>
                        </div>
                        {telegramBotConfig.pinConfigured && <div className="space-y-2">
                            <label className="text-[13px] font-medium">{t('settings.remaining.copy.037')}</label>
                            <div className="settings-choice-actions">
                                <Button type="button" variant={telegramPinVerificationMethod === 'current_pin' ? 'default' : 'outline'} onClick={() => { setTelegramPinVerificationMethod('current_pin'); setTelegramPinVerificationSecret(''); }}>{t('settings.remaining.copy.038')}</Button>
                                <Button type="button" variant={telegramPinVerificationMethod === 'web_password' ? 'default' : 'outline'} onClick={() => { setTelegramPinVerificationMethod('web_password'); setTelegramPinVerificationSecret(''); }}>{t('settings.remaining.copy.039')}</Button>
                            </div>
                        </div>}
                        <div className="settings-form-grid">
                            <SettingsField label={telegramBotConfig.pinConfigured && telegramPinVerificationMethod === 'current_pin' ? t('settings.remaining.copy.038') : t('settings.remaining.copy.039')} className="md:col-span-2"><input type="password" inputMode={telegramBotConfig.pinConfigured && telegramPinVerificationMethod === 'current_pin' ? 'numeric' : undefined} maxLength={telegramBotConfig.pinConfigured && telegramPinVerificationMethod === 'current_pin' ? 4 : 256} autoComplete="current-password" value={telegramPinVerificationSecret} onChange={event => setTelegramPinVerificationSecret(telegramBotConfig.pinConfigured && telegramPinVerificationMethod === 'current_pin' ? event.target.value.replace(/\D/g, '').slice(0, 4) : event.target.value)} placeholder={telegramBotConfig.pinConfigured && telegramPinVerificationMethod === 'current_pin' ? t('settings.remaining.shared.enterCurrentPin') : t('settings.remaining.shared.enterWebPassword')} className="w-full px-3 py-2" /></SettingsField>
                            <SettingsField label={t('settings.remaining.copy.040')}><input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="new-password" value={newTelegramPin} onChange={event => setNewTelegramPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={t('settings.remaining.copy.345')} className="w-full px-3 py-2" /></SettingsField>
                            <SettingsField label={t('settings.remaining.copy.041')}><input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="new-password" value={confirmNewTelegramPin} onChange={event => setConfirmNewTelegramPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={t('settings.remaining.copy.346')} className="w-full px-3 py-2" /></SettingsField>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={handleCancelTelegramPinChange} disabled={isChangingTelegramPin}>{t('settings.remaining.copy.034')}</Button><Button onClick={handleChangeTelegramPin} disabled={isChangingTelegramPin || !telegramPinVerificationSecret || newTelegramPin.length !== 4 || confirmNewTelegramPin.length !== 4}>{isChangingTelegramPin ? t('settings.remaining.copy.337') : (telegramBotConfig.pinConfigured ? t('settings.remaining.copy.348') : t('settings.remaining.copy.349'))}</Button></div>
                    </div>}
                </div>
            </SettingsSection>

            <SettingsSection title={t('settings.telegram.permissions')}>
                <div className="settings-provider-block">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 items-start gap-3">
                            <div className="settings-icon">
                                <ShieldCheck className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-[13px] font-medium">{t('settings.remaining.copy.043')}</span>
                                    {config?.telegramAllowedUserIdsFromEnv ? (
                                        <span className="px-2 py-0.5 rounded-full bg-blue-500/10 text-primary text-[11px] font-semibold">{t('settings.remaining.copy.044')}</span>
                                    ) : config?.telegramAllowedUserIds?.length ? (
                                        <span className="px-2 py-0.5 rounded-full bg-green-500/10 settings-text-success text-[11px] font-semibold">{t('settings.remaining.copy.320')}{config.telegramAllowedUserIds.length} {t('settings.remaining.shared.countSuffix')}</span>
                                    ) : (
                                        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 settings-text-warning text-[11px] font-semibold">{t('settings.remaining.copy.045')}</span>
                                    )}
                                </div>
                                <p className="text-[12px] text-muted-foreground mt-1">
                                    {t('settings.remaining.shared.allowlistDescription')}</p>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="p-4 space-y-3">
                    <textarea
                        aria-label={t('settings.remaining.copy.043')}
                        value={telegramAllowedUserIdsInput}
                        onChange={(event) => setTelegramAllowedUserIdsInput(event.target.value)}
                        disabled={!!config?.telegramAllowedUserIdsFromEnv || isSavingTelegramAllowedUsers}
                        rows={3}
                        placeholder={t('settings.remaining.copy.350')}
                        className="w-full px-3 py-2 disabled:bg-muted/40 disabled:text-muted-foreground"
                    />
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                        <p className="text-[12px] text-muted-foreground">
                            {t('settings.remaining.shared.getUserIdPrefix')}<code className="px-1 py-0.5 rounded bg-muted">@userinfobot</code> {t('settings.remaining.shared.getUserIdSuffix')}{config?.telegramAllowedUserIdsFromEnv ? t('settings.remaining.copy.351') : ''}
                        </p>
                        <Button
                            size="sm"
                            onClick={handleSaveTelegramAllowedUsers}
                            disabled={!!config?.telegramAllowedUserIdsFromEnv || isSavingTelegramAllowedUsers || !telegramAllowedUserIdsInput.trim()}
                        >
                            {isSavingTelegramAllowedUsers ? t('settings.remaining.copy.352') : t('settings.remaining.copy.353')}
                        </Button>
                    </div>
                </div>
            </SettingsSection>

            <SettingsSection title={t('settings.telegram.downloadSettings')}>
                <div className="settings-provider-block">
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3">
                            <div className="mt-0.5 shrink-0 p-2 rounded-[7px] bg-muted text-muted-foreground">
                                <Cloud className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-[13px] font-medium">{t('settings.remaining.copy.046')}</span>
                                    {!showTelegramUserDownload ? (
                                        <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[11px] font-medium">{t('settings.remaining.copy.047')}</span>
                                    ) : config?.telegramUserSessionReady ? (
                                        <span className="px-2 py-0.5 rounded-full bg-green-500/10 settings-text-success text-[11px] font-semibold">{t('settings.remaining.copy.048')}</span>
                                    ) : (
                                        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 settings-text-warning text-[11px] font-semibold">{t('settings.remaining.copy.049')}</span>
                                    )}
                                </div>
                                <p className="mt-1 max-w-xl text-[12px] leading-5 text-muted-foreground">{t('settings.remaining.copy.050')}</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant={showTelegramUserDownload ? "default" : "outline"}
                            className="w-full whitespace-normal sm:w-auto sm:shrink-0 sm:whitespace-normal"
                            onClick={async () => {
                                if (isSaving) return;
                                const nextEnabled = !showTelegramUserDownload;
                                setIsSaving(true);
                                try {
                                    await fileApi.setTelegramUserDownloadEnabled(nextEnabled);
                                    const refreshedConfig = await fileApi.getStorageConfig();
                                    setConfig(refreshedConfig);
                                    setShowTelegramUserDownload(!!refreshedConfig.telegramUserDownloadEnabled);
                                } catch (error: unknown) {
                                    await showNotice(errorMessage(error) || t('settings.remaining.copy.354'), t('settings.remaining.copy.153'));
                                } finally {
                                    setIsSaving(false);
                                }
                            }}
                        >
                            {showTelegramUserDownload ? t('settings.remaining.copy.356') : t('settings.remaining.copy.357')}
                        </Button>
                    </div>
                </div>

                <TelegramUserAccountsPanel
                    configured={!!telegramBotConfig?.configured}
                    onNotice={showNotice}
                    requestConfirmation={requestConfirmation}
                />
            </SettingsSection>
            </div>}

            {activeSection === 'storage' && <StorageSettings config={config} loadError={storageLoadError} storageStats={storageStats} onReload={reloadStorageConfig} onRefreshStats={onStorageStatsRefresh} onOpenTasksForAccount={onOpenTasksForAccount} />}

        </motion.div>
    );
};
