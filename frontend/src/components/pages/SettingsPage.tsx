import { AppearanceSettings } from './AppearanceSettings';
import { BotFaultDetails } from './BotFaultDetails';
import { isBotQuarantined, publishBotStatus } from '../../services/botFaultPresentation';
import { formatDateTime, formatNumber } from '../../i18n/format';
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { HardDrive, Palette, Globe, Cloud, Server, Database, CheckCircle, Trash2, Network, Shield, ShieldAlert, ShieldCheck, ExternalLink, BookOpen, KeyRound, CircleHelp, XCircle, RefreshCw, Gauge, Copy, X } from "../ui/icons";
import { Button } from "../ui/Button";
import { LanguageToggle } from "../ui/LanguageToggle";
import { cn } from "../../lib/utils";
import { fileApi, type AdvancedTaskSettings, type StorageAccount, type StorageConfig, type StorageStats, type TelegramBotPublicConfig, type UpdateStatus } from "../../services/api";
import { isTrustedOAuthPopupMessage } from "../../services/oauthPopupMessage";
import { monitorOAuthPopup } from "../../services/oauthPopupFlow";
import { synchronizeStorageConfig } from "../../services/storageConfigSynchronization";
import { authService } from "../../services/auth";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settingsSections";
import { IndeterminateSpinner } from "../ui/IndeterminateSpinner";
import { errorCode, errorMessage } from "../../services/unknownError";
import { Dialog } from "../ui/Dialog";
import { getProviderMetadata } from '../../services/providerMetadata';
import { LocalStorageLocation } from './LocalStorageLocation';
import { TelegramUserAccountsPanel } from "./TelegramUserAccountsPanel";
import { SettingsField, SettingsFormLayout, SettingsRow, SettingsSection, SettingsWorkspace } from "./SettingsPresentation";

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
interface ProbeFeedbackState { accountId: string; tone: 'success' | 'error'; message: string; sequence: number; }

const StorageProbeStatus = ({ account, busy, feedback, onProbe }: { account: StorageAccount; busy: boolean; feedback: ProbeFeedbackState | null; onProbe: () => void }) => {
    const { t, i18n } = useTranslation();
    const status = account.last_probe_status;
    const Icon = status === 'available' ? CheckCircle : status === 'failed' ? XCircle : CircleHelp;
    const label = status === 'available' ? t('settings.probe.available') : status === 'failed' ? t('settings.probe.failed') : t('settings.probe.notTested');
    return (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <span className={cn(
                "tv-badge settings-status inline-flex items-center gap-1",
                status === 'available' && "settings-status--success",
                status === 'failed' && "settings-status--danger",
                !status && "border-border bg-muted text-muted-foreground",
            )} title={account.last_probe_error || undefined}>
                <Icon className="h-3.5 w-3.5" />
                {label}
            </span>
            {account.last_probed_at && <span className="text-muted-foreground break-words">{formatDateTime(account.last_probed_at, i18n.resolvedLanguage || i18n.language)}</span>}
            <Button size="sm" variant="ghost" className="gap-1 px-2 text-xs" disabled={busy} onClick={onProbe}>
                {busy ? <IndeterminateSpinner label={t('settings.probe.testing')} size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {t('settings.probe.test')}
            </Button>
            {feedback && <span className={cn("min-w-0 basis-full rounded-md px-2 py-1.5 font-medium [overflow-wrap:anywhere]", feedback.tone === 'success' ? "settings-status--success" : "settings-status--danger")} role="status" aria-live="polite">{feedback.tone === 'success' ? <CheckCircle className="mr-1 inline h-3.5 w-3.5" /> : <XCircle className="mr-1 inline h-3.5 w-3.5" />}{feedback.message}</span>}
            {!feedback && status === 'failed' && account.last_probe_error && <p className="min-w-0 basis-full [overflow-wrap:anywhere] settings-text-danger">{account.last_probe_error}</p>}
        </div>
    );
};

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
                className={cn("w-full overflow-hidden rounded-2xl border bg-background shadow-2xl", danger ? "border-destructive/40" : "border-border")}
            >
                <div className={cn("flex items-start gap-3 border-b px-5 py-4 sm:px-6", danger ? "border-destructive/20 bg-destructive/10" : "border-border bg-muted/30")}>
                    <div className={cn("mt-0.5 rounded-full p-2", danger ? "bg-destructive/15 text-destructive" : "bg-primary/10 text-primary")}>
                        {danger ? <ShieldAlert className="h-5 w-5" /> : <CircleHelp className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 id="settings-action-title" className="text-base font-semibold sm:text-lg">{state.title}</h3>
                        {danger && <p className="mt-1 text-xs font-medium text-destructive">{state.dangerDescription || t('settings.dialog.irreversible')}</p>}
                    </div>
                    <button type="button" onClick={onCancel} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground" aria-label={t('settings.dialog.close')}><X className="h-4 w-4" /></button>
                </div>
                <div className="max-h-[min(60vh,32rem)] overflow-y-auto px-5 py-5 sm:px-6">
                    <p id="settings-action-message" className="whitespace-pre-line text-sm leading-6 text-muted-foreground">{state.message}</p>
                    {state.mode === 'prompt' && (
                        <input
                            type={state.inputType || 'text'}
                            value={input}
                            onChange={event => onInput(event.target.value)}
                            onKeyDown={event => { if (event.key === 'Enter') onConfirm(); }}
                            className="mt-4 h-11 w-full rounded-lg border border-border bg-background px-3 outline-none focus:ring-2 focus:ring-primary/20"
                        />
                    )}
                </div>
                <div className="flex flex-col-reverse gap-2 border-t border-border bg-muted/20 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
                    <Button variant="outline" onClick={onCancel}>{state.cancelLabel || t('settings.remaining.copy.124')}</Button>
                    <Button variant={danger ? 'destructive' : 'default'} onClick={onConfirm}>{state.confirmLabel || t('settings.remaining.copy.125')}</Button>
                </div>
            </motion.div>
        </Dialog>
    );
};

export const SettingsPage = ({ storageStats, onSignedOut, onOpenTasksForAccount, onStorageConfigChanged, onStorageStatsRefresh, activeSection, onSectionChange }: SettingsPageProps) => {
    const { t, i18n } = useTranslation();

    const oauthPopupCleanupRef = useRef<(() => void) | null>(null);
    const oauthPopupRef = useRef<Window | null>(null);
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
    const [isSaving, setIsSaving] = useState(false);
    const [isSavingWebdavSecurity, setIsSavingWebdavSecurity] = useState(false);
    const [probingAccountId, setProbingAccountId] = useState<string | null>(null);
    const [probeFeedback, setProbeFeedback] = useState<ProbeFeedbackState | null>(null);
    const [showOneDriveForm, setShowOneDriveForm] = useState(false);

    // OneDrive Form State (for adding new account)
    const [odClientId, setOdClientId] = useState("");
    const [odClientSecret, setOdClientSecret] = useState("");
    const [odTenantId, setOdTenantId] = useState("common");
    const [odAccountName, setOdAccountName] = useState("");

    // Aliyun OSS Form State
    const [ossAccountName, setOssAccountName] = useState("");
    const [ossRegion, setOssRegion] = useState("");
    const [ossAccessKeyId, setOssAccessKeyId] = useState("");
    const [ossAccessKeySecret, setOssAccessKeySecret] = useState("");
    const [ossBucket, setOssBucket] = useState("");
    const [showOSSForm, setShowOSSForm] = useState(false);

    // S3 Form State
    const [s3AccountName, setS3AccountName] = useState("");
    const [s3Endpoint, setS3Endpoint] = useState("");
    const [s3Region, setS3Region] = useState("");
    const [s3AccessKeyId, setS3AccessKeyId] = useState("");
    const [s3AccessKeySecret, setS3AccessKeySecret] = useState("");
    const [s3Bucket, setS3Bucket] = useState("");
    const [s3ForcePathStyle, setS3ForcePathStyle] = useState(false);
    const [showS3Form, setShowS3Form] = useState(false);

    // WebDAV Form State
    const [webdavAccountName, setWebdavAccountName] = useState("");
    const [webdavUrl, setWebdavUrl] = useState("");
    const [webdavUsername, setWebdavUsername] = useState("");
    const [webdavPassword, setWebdavPassword] = useState("");
    const [showWebDAVForm, setShowWebDAVForm] = useState(false);

    // OpenList native connection state (no remote management UI)
    const [openlistAccountName, setOpenlistAccountName] = useState("");
    const [openlistBaseUrl, setOpenlistBaseUrl] = useState("");
    const [openlistRootPath, setOpenlistRootPath] = useState("/");
    const [openlistUsername, setOpenlistUsername] = useState("");
    const [openlistPassword, setOpenlistPassword] = useState("");
    const [showOpenListForm, setShowOpenListForm] = useState(false);

    // Google Drive Form State
    const [gdAccountName, setGdAccountName] = useState("");
    const [gdClientId, setGdClientId] = useState("");
    const [gdClientSecret, setGdClientSecret] = useState("");
    const [gdSharedDriveId, setGdSharedDriveId] = useState("");
    const [showGDForm, setShowGDForm] = useState(false);

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

    const reloadAdvancedTasks = async () => {
        const data = await fileApi.getAdvancedTaskSettings();
        setAdvancedTasks(data);
        return data;
    };

    const updateAdvancedTask = async (patch: Partial<Pick<AdvancedTaskSettings, 'telegramDownloadWorkers' | 'telegramFileConcurrency' | 'duplicateMode' | 'autoCleanupOrphans' | 'skipTelegramPhotosInBatch' | 'telegramDownloadHistoryPolicy'>>) => {
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

    const botRetryBlocked = Boolean(telegramBotConfig?.busy || (telegramBotConfig && isBotQuarantined(telegramBotConfig)) || telegramBotConfig?.nextRetryAt
        || (telegramBotConfig?.retryAllowedAt && Date.parse(telegramBotConfig.retryAllowedAt) > Date.now()));

    const handleRetryTelegramBot = async () => {
        if (botRetryRequest.current || botRetryBlocked || isChangingTelegramPin || isSavingTelegramBot || !telegramBotConfig?.configured || !telegramBotConfig.enabled || telegramBotConfig.status === 'ready') return;
        const controller = new AbortController();
        botRetryRequest.current = controller;
        botStatusRequest.current?.abort();
        setIsRetryingBot(true);
        setBotRetryError('');
        const timeout = window.setTimeout(() => controller.abort(), 20_000);
        try {
            await fileApi.retryTelegramBotConnection(controller.signal);
        } catch {
            if (botSectionVisible.current) setBotRetryError(t('settings.botConnection.retryFailed'));
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
        : isBotQuarantined(telegramBotConfig) ? 'quarantined'
        : !telegramBotConfig.configured ? 'not_configured'
        : !telegramBotConfig.enabled ? 'disabled'
        : telegramBotConfig.status === 'ready' ? 'ready'
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
        setShowTelegramUserDownload(!!data.telegramUserDownloadEnabled);
        setTelegramAllowedUserIdsInput((data.telegramAllowedUserIds || []).join(', '));
        return data;
    };

    const refreshStorageStats = async (data: StorageConfig): Promise<boolean> => {
        if (!onStorageStatsRefresh) return true;
        try {
            await onStorageStatsRefresh(data.activeAccountId);
            return true;
        } catch (error) {
            console.error('Storage account updated, but refreshing capacity statistics failed:', error);
            return false;
        }
    };

    useEffect(() => () => {
        oauthPopupCleanupRef.current?.();
        oauthPopupRef.current?.close();
    }, []);

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

    useEffect(() => {
        if (!probeFeedback) return;
        const timer = window.setTimeout(() => setProbeFeedback(null), 4_000);
        return () => window.clearTimeout(timer);
    }, [probeFeedback?.sequence]);

    const handleProbeAccount = async (account: StorageAccount) => {
        if (probingAccountId) return;
        setProbingAccountId(account.id);
        setProbeFeedback(null);
        try {
            await fileApi.probeStorageAccount(account.id);
            await reloadStorageConfig();
            setProbeFeedback(previous => ({ accountId: account.id, tone: 'success', message: t('settings.remaining.copy.177'), sequence: (previous?.sequence ?? 0) + 1 }));
        } catch (error: unknown) {
            await reloadStorageConfig().catch(() => undefined);
            setProbeFeedback(previous => ({ accountId: account.id, tone: 'error', message: errorMessage(error) || t('settings.remaining.copy.178'), sequence: (previous?.sequence ?? 0) + 1 }));
        } finally {
            setProbingAccountId(null);
        }
    };

    // Load initial config
    useEffect(() => {
        const loadConfig = async () => {
            try {
                const [, , versionStatus] = await Promise.all([reloadStorageConfig(), reloadAdvancedTasks(), fileApi.getUpdateStatus()]);
                setUpdateStatus(versionStatus);
            } catch (error) {
                console.error("Failed to load storage config:", error);
            }
        };
        loadConfig();
    }, []);


    const handleSwitchProvider = async (provider: 'local' | 'onedrive' | 'aliyun_oss' | 's3' | 'webdav' | 'openlist' | 'google_drive', accountId?: string) => {
        if (isSaving) return;

        // If switching to the same account/provider, do nothing
        if (provider === 'local' && config?.provider === 'local') return;
        if (provider === 'onedrive' && accountId === config?.activeAccountId) return;
        if (provider === 'aliyun_oss' && accountId === config?.activeAccountId) return;
        if (provider === 's3' && accountId === config?.activeAccountId) return;
        if (provider === 'webdav' && accountId === config?.activeAccountId) return;
        if (provider === 'openlist' && accountId === config?.activeAccountId) return;
        if (provider === 'google_drive' && accountId === config?.activeAccountId) return;

        // If switching to OneDrive and no accounts exist, show form
        const onedriveAccounts = config?.accounts.filter(a => a.type === 'onedrive') || [];
        if (provider === 'onedrive' && onedriveAccounts.length === 0) {
            setShowOneDriveForm(true);
            return;
        }

        // If switching to Aliyun OSS and no accounts exist, show form
        const ossAccounts = config?.accounts.filter(a => a.type === 'aliyun_oss') || [];
        if (provider === 'aliyun_oss' && ossAccounts.length === 0) {
            setShowOSSForm(true);
            return;
        }

        // If switching to S3 and no accounts exist, show form
        const s3Accounts = config?.accounts.filter(a => a.type === 's3') || [];
        if (provider === 's3' && s3Accounts.length === 0) {
            setShowS3Form(true);
            return;
        }

        // If switching to WebDAV and no accounts exist, show form
        const webdavAccounts = config?.accounts.filter(a => a.type === 'webdav') || [];
        if (provider === 'webdav' && webdavAccounts.length === 0) {
            setShowWebDAVForm(true);
            return;
        }

        const openlistAccounts = config?.accounts.filter(a => a.type === 'openlist') || [];
        if (provider === 'openlist' && openlistAccounts.length === 0) {
            setShowOpenListForm(true);
            return;
        }

        // If switching to Google Drive and no accounts exist, show form
        const gdAccounts = config?.accounts.filter(a => a.type === 'google_drive') || [];
        if (provider === 'google_drive' && gdAccounts.length === 0) {
            setShowGDForm(true);
            return;
        }

        const providerNames = {
            'local': t('settings.remaining.copy.179'),
            'onedrive': 'OneDrive',
            'aliyun_oss': t('settings.remaining.copy.180'),
            's3': t('settings.remaining.copy.181'),
            'webdav': t('settings.remaining.copy.182'),
            'openlist': t('settings.remaining.copy.183'),
            'google_drive': 'Google Drive'
        };
        const providerName = providerNames[provider];

        if (!(await requestConfirmation(t('uiAudit.switchNote', { from: `${config?.provider} / ${config?.accounts.find(a => a.id === config.activeAccountId)?.name || '—'}`, to: `${providerName} / ${config?.accounts.find(a => a.id === accountId)?.name || '—'}` }) + '\n\n' + t('settings.remaining.copy.184', { value1: providerName, value2: accountId ? t('settings.remaining.shared.specifiedAccount') : '' }), t('settings.remaining.copy.185')))) return;

        setIsSaving(true);
        try {
            await fileApi.switchStorageProvider(provider, accountId);
            const data = await reloadStorageConfig();
            const statisticsFresh = await refreshStorageStats(data);
            await showNotice(statisticsFresh
                ? t('settings.remaining.copy.186', { value1: providerName })
                : t('settings.remaining.copy.187', { value1: providerName }),
            statisticsFresh ? t('settings.remaining.copy.126') : t('settings.remaining.copy.189'));
        } catch (error: unknown) {
            await reloadStorageConfig().catch(() => undefined);
            await showNotice(errorMessage(error), t('settings.remaining.copy.139'));
        } finally {
            setIsSaving(false);
        }
    };

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

    const handleSaveGDConfig = async () => {
        if (!gdClientId || !gdClientSecret) {
            await showNotice(t('settings.remaining.copy.202'), t('settings.remaining.copy.203'));
            return;
        }
        setIsSaving(true);
        try {
            const { authUrl, flowNonce, frontendOrigin } = await fileApi.getGoogleDriveAuthUrl(
                gdClientId,
                gdClientSecret,
                gdAccountName,
                gdSharedDriveId.trim(),
            );

            const width = 600;
            const height = 700;
            const left = window.screenX + (window.innerWidth - width) / 2;
            const top = window.screenY + (window.innerHeight - height) / 2;

            const authWindow = window.open(authUrl, 'GoogleDriveAuth', `width=${width},height=${height},left=${left},top=${top},status=yes,toolbar=no,menubar=no`);
            if (!authWindow) {
                throw new Error(t('settings.remaining.copy.204'));
            }

            oauthPopupCleanupRef.current?.();
            oauthPopupRef.current?.close();
            oauthPopupRef.current = authWindow;
            let statisticsFresh = true;
            oauthPopupCleanupRef.current = monitorOAuthPopup({
                host: window,
                popup: authWindow,
                classifyMessage: event => {
                    if (!isTrustedOAuthPopupMessage(event, {
                        frontendOrigin,
                        popup: authWindow,
                        provider: 'google_drive',
                        flowNonce,
                    })) return null;
                    return event.data.type === 'oauth_success' ? 'success' : 'failed';
                },
                onSuccess: async event => {
                    const accountId = (event.data as { accountId?: unknown }).accountId;
                    if (typeof accountId !== 'string' || !accountId) throw new Error(t('settings.remaining.copy.205'));
                    const data = await synchronizeStorageConfig({
                        loadConfig: () => fileApi.getStorageConfig(),
                        publishConfig: nextConfig => {
                            setConfig(nextConfig);
                            onStorageConfigChanged?.(nextConfig);
                        },
                    }, accountId);
                    statisticsFresh = await refreshStorageStats(data);
                    setShowGDForm(false);
                },
                onStateChange: async (state, flowError) => {
                    if (state !== 'waiting') {
                        setIsSaving(false);
                        oauthPopupRef.current = null;
                    }
                    if (state === 'cancelled') await showNotice(t('settings.remaining.copy.206'), t('settings.remaining.copy.207'));
                    if (state === 'failed') {
                        const providerError = flowError instanceof MessageEvent
                            ? (flowError.data as { error?: unknown }).error
                            : undefined;
                        await showNotice(t('settings.remaining.copy.208', { value1: typeof providerError === 'string' ? providerError : flowError instanceof Error ? flowError.message : t('settings.remaining.shared.unknownError') }), t('settings.remaining.copy.209'));
                    }
                    if (state === 'success') await showNotice(statisticsFresh
                        ? t('settings.remaining.copy.210')
                        : t('settings.remaining.copy.211'),
                    statisticsFresh ? t('settings.remaining.copy.126') : t('settings.remaining.copy.213'));
                },
            });
        } catch (error: unknown) {
            setIsSaving(false);
            await showNotice(t('settings.remaining.copy.214') + errorMessage(error), t('settings.remaining.copy.209'));
        }
    };

    const handleDeleteAccount = async (accountId: string, accountName: string) => {
        try {
            const preview = await fileApi.previewAccountDeletion(accountId);
            const impact = preview.impact;
            const busyCount = impact.activeLeaseCount + impact.activeTaskCount + impact.activeUploadCount;
            const impactText = [
                t('settings.remaining.copy.216', { value1: accountName }),
                t('settings.remaining.copy.217', { value1: impact.fileCount }),
                t('settings.remaining.copy.218', { value1: formatNumber(impact.totalSizeBytes / 1024 / 1024, i18n.resolvedLanguage || i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }),
                t('settings.remaining.copy.219', { value1: impact.folderCount }),
                t('settings.remaining.copy.220', { value1: impact.activeLeaseCount, value2: impact.activeTaskCount, value3: impact.activeUploadCount }),
                '',
                t('settings.remaining.copy.221'),
                ...(busyCount > 0 ? ['', t('settings.remaining.copy.222')] : []),
            ].join('\n');
            if (busyCount > 0) {
                await showNotice([
                    impactText,
                    '',
                    t('settings.remaining.copy.223'),
                ].join('\n'), t('settings.remaining.copy.224'));
                onOpenTasksForAccount?.(accountId);
                return;
            }
            if (!(await requestConfirmation(impactText, t('settings.remaining.copy.225')))) return;
            const result = await fileApi.deleteAccount(accountId, preview.confirmationToken);
            const data = await reloadStorageConfig();
            const statisticsFresh = await refreshStorageStats(data);
            await showNotice(statisticsFresh
                ? result.message
                : t('settings.remaining.copy.226', { value1: result.message }),
            statisticsFresh ? t('settings.remaining.copy.126') : t('settings.remaining.copy.228'));
        } catch (error: unknown) {
            await showNotice(errorMessage(error), t('settings.remaining.copy.139'));
        }
    };

    const handleSaveOneDriveConfig = async () => {
        if (!odClientId) {
            await showNotice(t('settings.remaining.copy.230'), t('settings.remaining.copy.203'));
            return;
        }
        setIsSaving(true);
        try {
            const { authUrl, flowNonce, frontendOrigin } = await fileApi.getOneDriveAuthUrl(
                odClientId,
                odTenantId || 'common',
                odClientSecret,
                odAccountName,
            );

            const width = 600;
            const height = 700;
            const left = window.screenX + (window.innerWidth - width) / 2;
            const top = window.screenY + (window.innerHeight - height) / 2;

            const authWindow = window.open(authUrl, 'OneDriveAuth', `width=${width},height=${height},left=${left},top=${top},status=yes,toolbar=no,menubar=no`);
            if (!authWindow) {
                throw new Error(t('settings.remaining.copy.204'));
            }

            oauthPopupCleanupRef.current?.();
            oauthPopupRef.current?.close();
            oauthPopupRef.current = authWindow;
            let statisticsFresh = true;
            oauthPopupCleanupRef.current = monitorOAuthPopup({
                host: window,
                popup: authWindow,
                classifyMessage: event => {
                    if (!isTrustedOAuthPopupMessage(event, {
                        frontendOrigin,
                        popup: authWindow,
                        provider: 'onedrive',
                        flowNonce,
                    })) return null;
                    return event.data.type === 'oauth_success' ? 'success' : 'failed';
                },
                onSuccess: async event => {
                    const accountId = (event.data as { accountId?: unknown }).accountId;
                    if (typeof accountId !== 'string' || !accountId) throw new Error(t('settings.remaining.copy.205'));
                    const data = await synchronizeStorageConfig({
                        loadConfig: () => fileApi.getStorageConfig(),
                        publishConfig: nextConfig => {
                            setConfig(nextConfig);
                            onStorageConfigChanged?.(nextConfig);
                        },
                    }, accountId);
                    statisticsFresh = await refreshStorageStats(data);
                    setShowOneDriveForm(false);
                },
                onStateChange: async (state, flowError) => {
                    if (state !== 'waiting') {
                        setIsSaving(false);
                        oauthPopupRef.current = null;
                    }
                    if (state === 'cancelled') await showNotice(t('settings.remaining.copy.234'), t('settings.remaining.copy.207'));
                    if (state === 'failed') {
                        const providerError = flowError instanceof MessageEvent
                            ? (flowError.data as { error?: unknown }).error
                            : undefined;
                        await showNotice(t('settings.remaining.copy.236', { value1: typeof providerError === 'string' ? providerError : flowError instanceof Error ? flowError.message : t('settings.remaining.shared.unknownError') }), t('settings.remaining.copy.209'));
                    }
                    if (state === 'success') await showNotice(statisticsFresh
                        ? t('settings.remaining.copy.238')
                        : t('settings.remaining.copy.239'),
                    statisticsFresh ? t('settings.remaining.copy.126') : t('settings.remaining.copy.213'));
                },
            });
        } catch (error: unknown) {
            setIsSaving(false);
            await showNotice(t('settings.remaining.copy.214') + errorMessage(error), t('settings.remaining.copy.209'));
        }
    };

    const handleSaveOSSConfig = async () => {
        if (!ossAccountName || !ossRegion || !ossAccessKeyId || !ossAccessKeySecret || !ossBucket) {
            await showNotice(t('settings.remaining.copy.244'), t('settings.remaining.copy.203'));
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.addAliyunOSSAccount(ossAccountName, ossRegion, ossAccessKeyId, ossAccessKeySecret, ossBucket);
            await reloadStorageConfig();
            await showNotice(t('settings.remaining.copy.246'));
            setShowOSSForm(false);
        } catch (error: unknown) {
            await showNotice(t('settings.remaining.copy.247') + errorMessage(error), t('settings.remaining.copy.248'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveS3Config = async () => {
        if (!s3AccountName || !s3Endpoint || !s3Region || !s3AccessKeyId || !s3AccessKeySecret || !s3Bucket) {
            await showNotice(t('settings.remaining.copy.244'), t('settings.remaining.copy.203'));
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.addS3Account(s3AccountName, s3Endpoint, s3Region, s3AccessKeyId, s3AccessKeySecret, s3Bucket, s3ForcePathStyle);
            await reloadStorageConfig();
            await showNotice(t('settings.remaining.copy.251'));
            setShowS3Form(false);
        } catch (error: unknown) {
            await showNotice(t('settings.remaining.copy.252') + errorMessage(error), t('settings.remaining.copy.248'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveWebDAVConfig = async () => {
        if (!webdavAccountName || !webdavUrl) {
            await showNotice(t('settings.remaining.copy.254'), t('settings.remaining.copy.203'));
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.addWebDAVAccount(webdavAccountName, webdavUrl, webdavUsername, webdavPassword);
            await reloadStorageConfig();
            await showNotice(t('settings.remaining.copy.256'));
            setShowWebDAVForm(false);
        } catch (error: unknown) {
            await showNotice(t('settings.remaining.copy.257') + errorMessage(error), t('settings.remaining.copy.248'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveOpenListConfig = async () => {
        if (!openlistAccountName || !openlistBaseUrl || !openlistUsername || !openlistPassword) {
            await showNotice(t('settings.openlist.required'), t('settings.openlist.incomplete'));
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.addOpenListAccount(openlistAccountName, openlistBaseUrl, openlistRootPath || '/', openlistUsername, openlistPassword);
            await reloadStorageConfig();
            setOpenlistPassword('');
            setShowOpenListForm(false);
            await showNotice(t('settings.openlist.success'));
        } catch (error: unknown) {
            await showNotice(t('settings.openlist.failure', { message: errorMessage(error) }), t('settings.openlist.incomplete'));
        } finally {
            setIsSaving(false);
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
                    <p className="tv-muted">{t("settings.subtitle")}</p>
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
                        <div>
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
                                    <div className="max-w-xs space-y-4">
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
                            {[4, 8, 12, 16].map(value => <option key={value} value={value}>{value}</option>)}
                        </select>
                    } />
                    <SettingsRow icon={Gauge} label={t('settings.cards.maintenance.fileConcurrency.title')} description={t('settings.cards.maintenance.fileConcurrency.description')} action={
                        <select aria-label={t('settings.cards.maintenance.fileConcurrency.title')} className="h-10 px-3" value={advancedTasks.telegramFileConcurrency} onChange={event => void updateAdvancedTask({ telegramFileConcurrency: Number(event.target.value) })}>
                            {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}
                        </select>
                    } />
                    <SettingsRow icon={Copy} label={t('settings.cards.maintenance.duplicateMode.title')} description={t('settings.cards.maintenance.duplicateMode.description')} action={
                        <select aria-label={t('settings.cards.maintenance.duplicateMode.title')} className="h-10 px-3" value={advancedTasks.duplicateMode} onChange={event => void updateAdvancedTask({ duplicateMode: event.target.value as 'copy' | 'skip' })}>
                            <option value="copy">{t('settings.cards.maintenance.duplicateMode.copy')}</option><option value="skip">{t('settings.cards.maintenance.duplicateMode.skip')}</option>
                        </select>
                    } />
                    <SettingsRow icon={Copy} label={t('settings.cards.maintenance.skipPhotos.title')} description={t('settings.cards.maintenance.skipPhotos.description')} action={
                        <Button size="sm" variant={advancedTasks.skipTelegramPhotosInBatch ? 'default' : 'outline'} onClick={() => void updateAdvancedTask({ skipTelegramPhotosInBatch: !advancedTasks.skipTelegramPhotosInBatch })}>
                            {t(advancedTasks.skipTelegramPhotosInBatch ? 'settings.cards.maintenance.enabled' : 'settings.cards.maintenance.disabled')}
                        </Button>
                    } />
                    <SettingsRow icon={Trash2} label={t('settings.cards.maintenance.cleanupOrphans.title')} description={t('settings.cards.maintenance.cleanupOrphans.description')} action={
                        <Button size="sm" variant={advancedTasks.autoCleanupOrphans ? 'default' : 'outline'} onClick={() => void updateAdvancedTask({ autoCleanupOrphans: !advancedTasks.autoCleanupOrphans })}>
                            {t(advancedTasks.autoCleanupOrphans ? 'settings.cards.maintenance.enabled' : 'settings.cards.maintenance.disabled')}
                        </Button>
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
                            onChange={(event) => void updateAdvancedTask({ telegramDownloadHistoryPolicy: event.target.value as AdvancedTaskSettings['telegramDownloadHistoryPolicy'] }).catch((error: any) => showNotice(errorMessage(error) || t('settings.cards.maintenance.history.updateFailed'), t('settings.remaining.copy.139')))}
                            className="h-10 w-full px-3 focus-visible:ring-2 focus-visible:ring-primary/40 sm:w-auto sm:min-w-48"
                            aria-label={t('settings.cards.maintenance.history.policyLabel')}
                        >
                            <option value="errors_only">{t('settings.cards.maintenance.history.errorsOnly')}</option>
                            <option value="all">{t('settings.cards.maintenance.history.all')}</option>
                        </select>
                    ) : <span className="text-[13px] text-muted-foreground">{t('settings.cards.maintenance.loading')}</span>}
                />
                <SettingsRow
                    icon={Trash2}
                    label={t('settings.cards.maintenance.cleanupHistory.title')}
                    description={t('settings.cards.maintenance.cleanupHistory.description')}
                    stackActionOnMobile
                    action={
                        <div className="settings-actions settings-actions--cleanup">
                            <select
                                aria-label={t('settings.cards.maintenance.cleanupHistory.title')}
                                value={cleanupRetentionDays}
                                onChange={(e) => setCleanupRetentionDays(Number(e.target.value))}
                                className="h-10 w-full px-3"
                                disabled={isCleaningDownloadItems}
                            >
                                {[1, 7, 30, 90].map(days => <option key={days} value={days}>{t('settings.cards.maintenance.cleanupHistory.keepDays', { count: days })}</option>)}
                            </select>
                            <Button
                                size="sm"
                                variant="outline"
                                className="w-full"
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
            <SettingsSection title={t('settings.telegram.botConnection')}>
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
                                <p className="mt-1 text-[12px] text-muted-foreground">{t('settings.remaining.copy.024')}</p>
                                {telegramBotConfig?.configured && <div className="mt-2 text-[12px] leading-5 text-muted-foreground">
                                    <p>{t('settings.remaining.copy.025')}</p>
                                    {telegramBotConfig.bot?.username && <p>Bot：@{telegramBotConfig.bot.username}</p>}
                                    <BotFaultDetails config={telegramBotConfig} />
                                    {telegramBotConfig.enabled && telegramBotConfig.status !== 'ready' && <p>{t('settings.remaining.shared.runtimeNotReady')}</p>}
                                    {telegramBotConfig.checkedAt && <p>{t('settings.botConnection.checkedAt')}: {formatDateTime(telegramBotConfig.checkedAt, i18n.resolvedLanguage || i18n.language)}</p>}
                                    {telegramBotConfig.nextRetryAt && telegramBotConfig.enabled && <p>{t('settings.botConnection.nextRetryAt')}: {formatDateTime(telegramBotConfig.nextRetryAt, i18n.resolvedLanguage || i18n.language)}</p>}
                                    {telegramBotConfig.retryAttempt != null && <p>{t('settings.botConnection.retryAttempt')}: {formatNumber(telegramBotConfig.retryAttempt, i18n.resolvedLanguage || i18n.language)}</p>}
                                </div>}
                            </div>
                        </div>
                        <div className="w-full sm:w-auto">
                            {telegramBotConfig?.source === 'environment' && <div className="flex flex-wrap gap-2 sm:justify-end"><Button size="sm" onClick={handleMigrateTelegramBot} disabled={isSavingTelegramBot}>{t('settings.remaining.copy.026')}</Button>{telegramBotConfig?.configured && <Button size="sm" variant="outline" disabled={isChangingTelegramPin} onClick={() => { if (showTelegramPinForm) handleCancelTelegramPinChange(); else { handleCancelTelegramBotEdit(); clearTelegramPinChangeInputs(); setTelegramPinVerificationMethod(telegramBotConfig.pinConfigured ? 'current_pin' : 'web_password'); setShowTelegramPinForm(true); } }}>{showTelegramPinForm ? (telegramBotConfig.pinConfigured ? t('settings.remaining.copy.322') : t('settings.remaining.copy.323')) : (telegramBotConfig.pinConfigured ? t('settings.remaining.copy.324') : t('settings.remaining.copy.325'))}</Button>}</div>}
                            {telegramBotConfig?.source === 'web' && <div className="settings-actions settings-actions--bot">
                                <Button size="sm" variant="outline" className="settings-action" disabled={isSavingTelegramBot} onClick={() => { if (showTelegramBotForm) handleCancelTelegramBotEdit(); else { handleCancelTelegramPinChange(); clearTelegramBotInputs(); setShowTelegramBotForm(true); } }}>{showTelegramBotForm ? t('settings.remaining.copy.326') : t('settings.remaining.copy.327')}</Button>
                                <Button size="sm" variant="outline" className="settings-action" disabled={isChangingTelegramPin} onClick={() => { if (showTelegramPinForm) handleCancelTelegramPinChange(); else { handleCancelTelegramBotEdit(); clearTelegramPinChangeInputs(); setTelegramPinVerificationMethod(telegramBotConfig.pinConfigured ? 'current_pin' : 'web_password'); setShowTelegramPinForm(true); } }}>{showTelegramPinForm ? (telegramBotConfig.pinConfigured ? t('settings.remaining.copy.322') : t('settings.remaining.copy.323')) : (telegramBotConfig.pinConfigured ? t('settings.remaining.copy.324') : t('settings.remaining.copy.325'))}</Button>
                                <Button size="sm" variant="destructive" className="settings-action" onClick={handleDeleteTelegramBot} disabled={isSavingTelegramBot}>{t('settings.remaining.copy.027')}</Button>
                            </div>}
                        </div>
                        {telegramBotConfig?.configured && !telegramBotConfig.pinConfigured && <p className="mt-3 rounded-[7px] border border-amber-300/60 bg-amber-500/10 px-3 py-2.5 text-[13px] settings-text-warning">{t('settings.remaining.copy.028')}</p>}
                        {!telegramBotConfig?.pinConfigured && telegramBotConfig?.source === 'environment' && <SettingsField label={t('settings.remaining.copy.029')} className="mt-4"><input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="new-password" value={telegramPin} onChange={event => setTelegramPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={t('settings.remaining.shared.createPinBeforeMigration')} className="w-full px-3 py-2" /><p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.030')}</p></SettingsField>}
                    </div>

                    <div className="space-y-2" data-testid="bot-runtime-controls">
                        <div className="flex flex-wrap gap-2">
                            {telegramBotConfig?.configured && telegramBotConfig.enabled && telegramBotConfig.status !== 'ready' && <Button size="sm" onClick={handleRetryTelegramBot} disabled={botRetryBlocked || isRetryingBot || isSavingTelegramBot || isChangingTelegramPin}>{t(isRetryingBot ? 'settings.botConnection.retrying' : 'settings.botConnection.retry')}</Button>}
                            <Button size="sm" variant="outline" disabled={isRefreshingBot || isRetryingBot || isSavingTelegramBot} onClick={() => setBotPollEpoch(value => value + 1)}>{t(isRefreshingBot ? 'settings.botConnection.refreshing' : 'settings.botConnection.refresh')}</Button>
                        </div>
                        <p className="settings-help">{t('settings.botConnection.scope')}</p>
                        <p className="settings-help">{t('settings.botConnection.polling')}</p>
                        <div aria-live="polite">
                            {telegramBotConfig?.busy && <p className="text-sm">{t('settings.botConnection.busy')}</p>}
                            {telegramBotConfig?.retryAllowedAt && <p className="text-sm">{t('settings.botConnection.retryAllowedAt')}: {formatDateTime(telegramBotConfig.retryAllowedAt, i18n.resolvedLanguage || i18n.language)}</p>}
                            {botStatusError && <p className="text-destructive text-sm">{t('settings.botConnection.refreshFailed')}</p>}
                            {botRetryError && <p className="text-destructive text-sm">{botRetryError}</p>}
                        </div>
                    </div>

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
                            <div>
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

            {activeSection === 'storage' && <div className="settings-group settings-group--storage">
            <SettingsSection title={t('uiAudit.current')} className="settings-current-storage">
                <div className="settings-current-storage__body">
                    <strong data-current-storage>{config ? config.provider === 'local' ? t('settings.remaining.copy.358') : `${getProviderMetadata(config.provider).label} / ${config.accounts.find(a => a.id === config.activeAccountId)?.name || '—'}` : t('common.status.loading')}</strong>
                    <p className="settings-help">{t('uiAudit.storageNote')}</p>
                    {config?.accounts.filter(a => a.id === config.activeAccountId).map(account => <StorageProbeStatus key={account.id} account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />)}
                    {config?.provider === 'local' && <LocalStorageLocation />}
                </div>
            </SettingsSection>
            {/* i18n source: 存储源设置 */}
            <SettingsSection title={t('settings.storageSources.title')}>
                <div className="settings-notice settings-status--info settings-storage-guide mx-4 my-4 flex items-center gap-3">
                    <BookOpen className="h-4 w-4 text-primary flex-shrink-0" />
                    <p className="text-[12px] text-muted-foreground">
                        {t('settings.remaining.shared.guidePrefix')}{" "}
                        <a
                            href="https://hicocos.github.io/tg-vault/storage.html"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-primary font-medium hover:underline"
                        >
                            {t('settings.remaining.shared.guideLink')}<ExternalLink className="h-3 w-3" />
                        </a>
                        {t('settings.remaining.shared.guideSuffix')}</p>
                </div>
                <div className="border-b border-border/50">
                    <SettingsRow
                        icon={Database}
                        label={t('settings.remaining.copy.358')}
                        description={t('settings.remaining.copy.359')}
                        stackActionOnMobile
                        value={config?.provider === 'local' ? t('settings.remaining.copy.360') : ""}
                        action={
                            config?.provider === 'local' ? (
                                <CheckCircle className="h-5 w-5 settings-text-success" />
                            ) : (
                                <Button
                                    size="sm" variant="outline"
                                    className="w-full whitespace-normal text-center leading-tight sm:w-auto"
                                    onClick={() => handleSwitchProvider('local')}
                                    disabled={isSaving || !config}
                                >
                                    {t('uiAudit.switchTo')}</Button>
                            )
                        }
                    />
                    {config?.provider !== 'local' && <LocalStorageLocation />}
                </div>

                <details className="settings-provider-group" open={config?.accounts.some(a => a.type === 'google_drive') || undefined}><summary>{t(config?.accounts.some(a => a.type === 'google_drive') ? 'uiAudit.configured' : 'uiAudit.other')} · Google Drive</summary><div className="settings-provider-block">
                    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                            <div className="settings-icon">
                                <Database className="h-4 w-4" />
                            </div>
                            <div>
                                <span className="text-[13px] font-medium">{t('settings.remaining.copy.051')}</span>
                                <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.052')}</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowGDForm(!showGDForm)}
                        >
                            {showGDForm ? t('settings.remaining.copy.361') : t('settings.remaining.copy.362')}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        {config?.accounts.filter(a => a.type === 'google_drive').map((account) => (
                            <div
                                key={account.id}
                                className={cn(
                                    "settings-storage-account",
                                    account.is_active
                                        ? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
                                        : "bg-background border-border hover:border-border/80"
                                )}
                            >
                                <div className="flex min-w-0 items-start gap-3">
                                    <div className={cn(
                                        "mt-2 h-2 w-2 shrink-0 rounded-full",
                                        account.is_active ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                                    )} />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[13px] font-medium">{account.name || t('settings.remaining.copy.363')}</p>
                                        <details className="settings-account-details"><summary>{t('uiAudit.details')}</summary><code>{account.id}</code></details>
                                        <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
                                    {account.is_active ? (
                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 settings-text-success">
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            <span className="text-[12px] font-semibold">{t('settings.remaining.copy.110')}</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="text-[12px] hover:bg-primary/10 hover:text-primary"
                                                onClick={() => handleSwitchProvider('google_drive', account.id)}
                                                disabled={isSaving}
                                            >
                                                {t('uiAudit.switchTo')}</Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                                aria-label={t('management.telegramAccounts.account.delete')}
                                                onClick={() => handleDeleteAccount(account.id, account.name)}
                                                disabled={isSaving}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                        {config?.accounts.filter(a => a.type === 'google_drive').length === 0 && !showGDForm && (
                            <div className="text-center py-6 border border-dashed rounded-[7px] border-border/50">
                                <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.054')}</p>
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1"
                                    onClick={() => setShowGDForm(true)}
                                >
                                    {t('settings.remaining.shared.addNow')}</Button>
                            </div>
                        )}
                    </div>
                </div>

                <AnimatePresence>
                    {showGDForm && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="bg-muted/30 border-t border-border/50"
                        >
                            <SettingsFormLayout guide={<div className="space-y-4">
                                    <div className="flex items-center gap-2 text-[13px] font-semibold text-primary">
                                        <Database className="h-4 w-4" />
                                        <span>{t('settings.remaining.copy.055')}</span>
                                    </div>
                                    <p className="text-[12px] text-muted-foreground leading-relaxed">
                                        {t('settings.remaining.shared.goTo')}<a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="text-primary hover:underline">Google Cloud Console</a> {t('settings.remaining.copy.056')}<b>{t('settings.remaining.copy.057')}</b>{t('settings.remaining.shared.googleAppTypePrefix')}<code>{t('settings.remaining.copy.058')}</code>{t('settings.remaining.copy.059')}<b>{t('settings.remaining.copy.060')}</b>{t('uiAudit.punctuation.colon')}
                                        <code className="block mt-1 p-1 bg-muted rounded text-primary">{config?.googleDriveRedirectUri || `${window.location.origin}/api/storage/google-drive/callback`}</code>
                                    </p>
                                </div>}>


                                <div className="settings-form-grid">
                                    <SettingsField label={t('settings.remaining.copy.061')} className="md:col-span-2">
                                        <input
                                            type="text"
                                            value={gdAccountName}
                                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGdAccountName(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder={t('settings.remaining.copy.364')}
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.062')} className="md:col-span-2">
                                        <input
                                            type="text"
                                            value={gdClientId}
                                            onChange={e => setGdClientId(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder="Google Cloud Client ID"
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.063')} className="md:col-span-2">
                                        <input
                                            type="password"
                                            value={gdClientSecret}
                                            onChange={e => setGdClientSecret(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder="Google Cloud Client Secret"
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.064')} className="md:col-span-2">
                                        <input
                                            type="text"
                                            value={gdSharedDriveId}
                                            onChange={e => setGdSharedDriveId(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder={t('settings.remaining.copy.365')}
                                        />
                                        <p className="text-[12px] text-muted-foreground leading-relaxed">
                                            {t('settings.remaining.shared.sharedDriveHintPrefix')}<code>folders/</code>{t('settings.remaining.shared.sharedDriveHintSuffix')}</p>
                                    </SettingsField>
                                </div>

                                <div className="settings-save-panel">
                                    <div className="settings-action-row">
                                        <div className="space-y-0.5">
                                            <h4 className="text-[13px] font-medium text-primary">{t('settings.remaining.copy.065')}</h4>
                                            <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.066')}</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveGDConfig}
                                            disabled={isSaving || !gdClientId || !gdClientSecret}
                                            className="settings-action"
                                        >
                                            {isSaving ? t('settings.remaining.copy.366') : t('settings.remaining.copy.367')}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowGDForm(false)}>{t('settings.remaining.copy.107')}</Button>
                                </div>
                            </SettingsFormLayout>
                        </motion.div>
                    )}
                </AnimatePresence></details>

                <details className="settings-provider-group" open={config?.accounts.some(a => a.type === 'onedrive') || undefined}><summary>{t(config?.accounts.some(a => a.type === 'onedrive') ? 'uiAudit.configured' : 'uiAudit.other')} · OneDrive</summary><div className="settings-provider-block">
                    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                            <div className="settings-icon">
                                <Cloud className="h-4 w-4" />
                            </div>
                            <div>
                                <span className="text-[13px] font-medium">{t('settings.remaining.copy.068')}</span>
                                <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.069')}</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowOneDriveForm(!showOneDriveForm)}
                        >
                            {showOneDriveForm ? t('settings.remaining.copy.361') : t('settings.remaining.copy.362')}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        {config?.accounts.filter(a => a.type === 'onedrive').map((account) => (
                            <div
                                key={account.id}
                                className={cn(
                                    "settings-storage-account",
                                    account.is_active
                                        ? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
                                        : "bg-background border-border hover:border-border/80"
                                )}
                            >
                                <div className="flex min-w-0 items-start gap-3">
                                    <div className={cn(
                                        "mt-2 h-2 w-2 shrink-0 rounded-full",
                                        account.is_active ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                                    )} />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[13px] font-medium">{account.name || t('settings.remaining.copy.363')}</p>
                                        <details className="settings-account-details"><summary>{t('uiAudit.details')}</summary><code>{account.id}</code></details>
                                        <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
                                    {account.is_active ? (
                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 settings-text-success">
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            <span className="text-[12px] font-semibold">{t('settings.remaining.copy.110')}</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="text-[12px] hover:bg-primary/10 hover:text-primary"
                                                onClick={() => handleSwitchProvider('onedrive', account.id)}
                                                disabled={isSaving}
                                            >
                                                {t('uiAudit.switchTo')}</Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                                aria-label={t('management.telegramAccounts.account.delete')}
                                                onClick={() => handleDeleteAccount(account.id, account.name)}
                                                disabled={isSaving}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                        {config?.accounts.filter(a => a.type === 'onedrive').length === 0 && !showOneDriveForm && (
                            <div className="text-center py-6 border border-dashed rounded-[7px] border-border/50">
                                <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.071')}</p>
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1"
                                    onClick={() => setShowOneDriveForm(true)}
                                >
                                    {t('settings.remaining.shared.addNow')}</Button>
                            </div>
                        )}
                    </div>
                </div>

                <AnimatePresence>
                    {showOneDriveForm && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="bg-muted/30 border-t border-border/50"
                        >
                            <SettingsFormLayout guide={<div className="space-y-4">
                                    <div className="flex items-center gap-2 text-[13px] font-semibold text-primary">
                                        <Database className="h-4 w-4" />
                                        <span>{t('settings.remaining.copy.072')}</span>
                                    </div>
                                    <p className="text-[12px] text-muted-foreground leading-relaxed">
                                        {t('settings.remaining.shared.goTo')}<a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer" className="text-primary hover:underline">{t('settings.remaining.copy.073')}</a> {t('settings.remaining.shared.entraGuideMiddle')}<b>{t('settings.remaining.copy.074')}</b> {t('settings.remaining.copy.075')}<code>Web</code>{t('settings.remaining.shared.andEnter')}<code className="block mt-1 p-1 bg-muted rounded text-primary">{config?.redirectUri || `${import.meta.env.VITE_API_URL || window.location.origin}/api/storage/onedrive/callback`}</code>
                                    </p>
                                    <p className="text-[12px] settings-text-warning leading-relaxed rounded-[7px] border border-amber-500/20 bg-amber-500/5 p-3">
                                        {t('settings.remaining.shared.azureSecretPrefix')}<b>{t('settings.remaining.copy.076')}</b>{t('settings.remaining.copy.077')}<code>AADSTS7000215 Invalid client secret</code>{t('uiAudit.punctuation.period')}
                                    </p>
                                </div>}>


                                <div className="settings-form-grid">
                                    <SettingsField label={t('settings.remaining.copy.078')}>
                                        <input
                                            type="text"
                                            value={odClientId}
                                            onChange={e => setOdClientId(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder="Azure App Client ID"
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.079')}>
                                        <input
                                            type="text"
                                            value={odTenantId}
                                            onChange={e => setOdTenantId(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder={t('settings.remaining.copy.371')}
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.080')} className="md:col-span-2">
                                        <input
                                            type="text"
                                            value={odAccountName}
                                            onChange={e => setOdAccountName(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder={t('settings.remaining.copy.372')}
                                        />
                                    </SettingsField>
                                </div>

                                <SettingsField label={t('settings.remaining.copy.081')}>
                                    <input
                                        type="password"
                                        value={odClientSecret}
                                        onChange={e => setOdClientSecret(e.target.value)}
                                        className="w-full px-3 py-2"
                                        placeholder={t('settings.remaining.copy.373')}
                                    />
                                </SettingsField>

                                <div className="settings-save-panel">
                                    <div className="settings-action-row">
                                        <div className="space-y-0.5">
                                            <h4 className="text-[13px] font-medium text-primary">{t('settings.remaining.copy.082')}</h4>
                                            <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.083')}</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveOneDriveConfig}
                                            disabled={isSaving || !odClientId}
                                            className="settings-action"
                                        >
                                            {isSaving ? t('settings.remaining.copy.366') : t('settings.remaining.copy.367')}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowOneDriveForm(false)}>{t('settings.remaining.copy.107')}</Button>
                                </div>
                            </SettingsFormLayout>
                        </motion.div>
                    )}
                </AnimatePresence></details>
            </SettingsSection>

            {/* Aliyun OSS Configuration Section */}
            <SettingsSection title={t('settings.storageSources.aliyunTitle')}>

<details className="settings-provider-group" open={config?.accounts.some(a => a.type === 'aliyun_oss') || undefined}><summary>{t(config?.accounts.some(a => a.type === 'aliyun_oss') ? 'uiAudit.configured' : 'uiAudit.other')} · OSS</summary><div className="settings-provider-block">
                    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                            <div className="settings-icon">
                                <Database className="h-4 w-4" />
                            </div>
                            <div>
                                <span className="text-[13px] font-medium">{t('settings.remaining.copy.085')}</span>
                                <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.086')}</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowOSSForm(!showOSSForm)}
                        >
                            {showOSSForm ? t('settings.remaining.copy.361') : t('settings.remaining.copy.362')}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        {config?.accounts.filter(a => a.type === 'aliyun_oss').map((account) => (
                            <div
                                key={account.id}
                                className={cn(
                                    "settings-storage-account",
                                    account.is_active
                                        ? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
                                        : "bg-background border-border hover:border-border/80"
                                )}
                            >
                                <div className="flex min-w-0 items-start gap-3">
                                    <div className={cn(
                                        "mt-2 h-2 w-2 shrink-0 rounded-full",
                                        account.is_active ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                                    )} />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[13px] font-medium">{account.name || t('settings.remaining.copy.363')}</p>
                                        <details className="settings-account-details"><summary>{t('uiAudit.details')}</summary><code>{account.id}</code></details>
                                        <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
                                    {account.is_active ? (
                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 settings-text-success">
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            <span className="text-[12px] font-semibold">{t('settings.remaining.copy.110')}</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="text-[12px] hover:bg-primary/10 hover:text-primary"
                                                onClick={() => handleSwitchProvider('aliyun_oss', account.id)}
                                                disabled={isSaving}
                                            >
                                                {t('uiAudit.switchTo')}</Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                                aria-label={t('management.telegramAccounts.account.delete')}
                                                onClick={() => handleDeleteAccount(account.id, account.name)}
                                                disabled={isSaving}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                        {config?.accounts.filter(a => a.type === 'aliyun_oss').length === 0 && !showOSSForm && (
                            <div className="text-center py-6 border border-dashed rounded-[7px] border-border/50">
                                <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.088')}</p>
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1"
                                    onClick={() => setShowOSSForm(true)}
                                >
                                    {t('settings.remaining.shared.addNow')}</Button>
                            </div>
                        )}
                    </div>
                </div>

                <AnimatePresence>
                    {showOSSForm && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="bg-muted/30 border-t border-border/50"
                        >
                            <SettingsFormLayout guide={<div className="space-y-4">
                                    <div className="flex items-center gap-2 text-[13px] font-semibold text-primary">
                                        <Database className="h-4 w-4" />
                                        <span>{t('settings.remaining.copy.089')}</span>
                                    </div>
                                    <p className="text-[12px] text-muted-foreground leading-relaxed">
                                        {t('settings.remaining.shared.ossCredentialsHint')}</p>
                                </div>}>


                                <div className="settings-form-grid">
                                    <SettingsField label={t('settings.remaining.copy.101')} className="md:col-span-2">
                                        <input
                                            type="text"
                                            value={ossAccountName}
                                            onChange={e => setOssAccountName(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder={t('settings.remaining.copy.379')}
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.103')}>
                                        <input
                                            type="text"
                                            value={ossRegion}
                                            onChange={e => setOssRegion(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder="oss-cn-hangzhou"
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.104')}>
                                        <input
                                            type="text"
                                            value={ossBucket}
                                            onChange={e => setOssBucket(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder="my-oss-bucket"
                                        />
                                    </SettingsField>
                                    <SettingsField label="AccessKey ID">
                                        <input
                                            type="text"
                                            value={ossAccessKeyId}
                                            onChange={e => setOssAccessKeyId(e.target.value)}
                                            className="w-full px-3 py-2"
                                        />
                                    </SettingsField>
                                    <SettingsField label="AccessKey Secret">
                                        <input
                                            type="password"
                                            value={ossAccessKeySecret}
                                            onChange={e => setOssAccessKeySecret(e.target.value)}
                                            className="w-full px-3 py-2"
                                        />
                                    </SettingsField>
                                </div>

                                <div className="settings-save-panel">
                                    <div className="settings-action-row">
                                        <div className="space-y-0.5">
                                            <h4 className="text-[13px] font-medium text-primary">{t('settings.remaining.copy.105')}</h4>
                                            <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.094')}</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveOSSConfig}
                                            disabled={isSaving || !ossAccessKeyId}
                                        >
                                            {isSaving ? t('settings.remaining.copy.380') : t('settings.remaining.copy.381')}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowOSSForm(false)}>{t('settings.remaining.copy.107')}</Button>
                                </div>
                            </SettingsFormLayout>
                        </motion.div>
                    )}
                </AnimatePresence></details>
            </SettingsSection>

            {/* S3 Configuration Section */}
            <SettingsSection title={t('settings.storageSources.s3Title')}>

<details className="settings-provider-group" open={config?.accounts.some(a => a.type === 's3') || undefined}><summary>{t(config?.accounts.some(a => a.type === 's3') ? 'uiAudit.configured' : 'uiAudit.other')} · S3</summary><div className="settings-provider-block">
                    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                            <div className="settings-icon">
                                <Database className="h-4 w-4" />
                            </div>
                            <div>
                                <span className="text-[13px] font-medium">{t('settings.remaining.copy.096')}</span>
                                <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.097')}</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowS3Form(!showS3Form)}
                        >
                            {showS3Form ? t('settings.remaining.copy.361') : t('settings.remaining.copy.362')}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        {config?.accounts.filter(a => a.type === 's3').map((account) => (
                            <div
                                key={account.id}
                                className={cn(
                                    "settings-storage-account",
                                    account.is_active
                                        ? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
                                        : "bg-background border-border hover:border-border/80"
                                )}
                            >
                                <div className="flex min-w-0 items-start gap-3">
                                    <div className={cn(
                                        "mt-2 h-2 w-2 shrink-0 rounded-full",
                                        account.is_active ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                                    )} />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[13px] font-medium">{account.name || t('settings.remaining.copy.363')}</p>
                                        <details className="settings-account-details"><summary>{t('uiAudit.details')}</summary><code>{account.id}</code></details>
                                        <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
                                    {account.is_active ? (
                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 settings-text-success">
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            <span className="text-[12px] font-semibold">{t('settings.remaining.copy.110')}</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="text-[12px] hover:bg-primary/10 hover:text-primary"
                                                onClick={() => handleSwitchProvider('s3', account.id)}
                                                disabled={isSaving}
                                            >
                                                {t('uiAudit.switchTo')}</Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                                aria-label={t('management.telegramAccounts.account.delete')}
                                                onClick={() => handleDeleteAccount(account.id, account.name)}
                                                disabled={isSaving}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                        {config?.accounts.filter(a => a.type === 's3').length === 0 && !showS3Form && (
                            <div className="text-center py-6 border border-dashed rounded-[7px] border-border/50">
                                <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.099')}</p>
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1"
                                    onClick={() => setShowS3Form(true)}
                                >
                                    {t('settings.remaining.shared.addNow')}</Button>
                            </div>
                        )}
                    </div>
                </div>

                <AnimatePresence>
                    {showS3Form && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="bg-muted/30 border-t border-border/50"
                        >
                            <SettingsFormLayout guide={<div className="space-y-4">
                                    <div className="flex items-center gap-2 text-[13px] font-semibold text-primary">
                                        <Database className="h-4 w-4" />
                                        <span>{t('settings.remaining.copy.100')}</span>
                                    </div>
                                    <p className="text-[12px] text-muted-foreground leading-relaxed">
                                        {t('settings.remaining.shared.s3CredentialsHint')}</p>
                                </div>}>


                                <div className="settings-form-grid">
                                    <SettingsField label={t('settings.remaining.copy.101')} className="md:col-span-2">
                                        <input
                                            type="text"
                                            value={s3AccountName}
                                            onChange={e => setS3AccountName(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder={t('settings.remaining.copy.385')}
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.102')} className="md:col-span-2">
                                        <input
                                            type="text"
                                            value={s3Endpoint}
                                            onChange={e => setS3Endpoint(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder="https://s3.amazonaws.com"
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.103')}>
                                        <input
                                            type="text"
                                            value={s3Region}
                                            onChange={e => setS3Region(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder="us-east-1"
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.104')}>
                                        <input
                                            type="text"
                                            value={s3Bucket}
                                            onChange={e => setS3Bucket(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder="my-s3-bucket"
                                        />
                                    </SettingsField>
                                    <SettingsField label="AccessKey ID">
                                        <input
                                            type="text"
                                            value={s3AccessKeyId}
                                            onChange={e => setS3AccessKeyId(e.target.value)}
                                            className="w-full px-3 py-2"
                                        />
                                    </SettingsField>
                                    <SettingsField label="AccessKey Secret">
                                        <input
                                            type="password"
                                            value={s3AccessKeySecret}
                                            onChange={e => setS3AccessKeySecret(e.target.value)}
                                            className="w-full px-3 py-2"
                                        />
                                    </SettingsField>
                                    <div className="flex items-center gap-2 pt-2 md:col-span-2">
                                        <input
                                            type="checkbox"
                                            id="forcePathStyle"
                                            checked={s3ForcePathStyle}
                                            onChange={e => setS3ForcePathStyle(e.target.checked)}
                                            className="rounded"
                                        />
                                        <label htmlFor="forcePathStyle" className="text-[12px] text-muted-foreground">
                                            {t('settings.remaining.shared.forcePathStyle')}</label>
                                    </div>
                                </div>

                                <div className="settings-save-panel">
                                    <div className="settings-action-row">
                                        <div className="space-y-0.5">
                                            <h4 className="text-[13px] font-medium text-primary">{t('settings.remaining.copy.105')}</h4>
                                            <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.106')}</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveS3Config}
                                            disabled={isSaving || !s3AccessKeyId}
                                        >
                                            {isSaving ? t('settings.remaining.copy.380') : t('settings.remaining.copy.381')}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowS3Form(false)}>{t('settings.remaining.copy.107')}</Button>
                                </div>
                            </SettingsFormLayout>
                        </motion.div>
                    )}
                </AnimatePresence></details>
            </SettingsSection>

            {/* WebDAV Configuration Section */}
            <SettingsSection title={t('settings.storageSources.webdavTitle')}>

<details className="settings-provider-group" open={config?.accounts.some(a => a.type === 'webdav') || undefined}><summary>{t(config?.accounts.some(a => a.type === 'webdav') ? 'uiAudit.configured' : 'uiAudit.other')} · WebDAV</summary><div className="settings-provider-block">
                    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                            <div className="settings-icon">
                                <Network className="h-4 w-4" />
                            </div>
                            <div>
                                <span className="text-[13px] font-medium">{t('settings.remaining.copy.108')}</span>
                                <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.109')}</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowWebDAVForm(!showWebDAVForm)}
                        >
                            {showWebDAVForm ? t('settings.remaining.copy.361') : t('settings.remaining.copy.362')}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        {config?.accounts.filter(a => a.type === 'webdav').map((account) => (
                            <div
                                key={account.id}
                                className={cn(
                                    "settings-storage-account",
                                    account.is_active
                                        ? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
                                        : "bg-background border-border hover:border-border/80"
                                )}
                            >
                                <div className="flex min-w-0 items-start gap-3">
                                    <div className={cn(
                                        "mt-2 h-2 w-2 shrink-0 rounded-full",
                                        account.is_active ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                                    )} />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[13px] font-medium">{account.name || t('settings.remaining.copy.363')}</p>
                                        <details className="settings-account-details"><summary>{t('uiAudit.details')}</summary><code>{account.id}</code></details>
                                        <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
                                    {account.is_active ? (
                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 settings-text-success">
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            <span className="text-[12px] font-semibold">{t('settings.remaining.copy.110')}</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="text-[12px] hover:bg-primary/10 hover:text-primary"
                                                onClick={() => handleSwitchProvider('webdav', account.id)}
                                                disabled={isSaving}
                                            >
                                                {t('uiAudit.switchTo')}</Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                                aria-label={t('management.telegramAccounts.account.delete')}
                                                onClick={() => handleDeleteAccount(account.id, account.name)}
                                                disabled={isSaving}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                        {config?.accounts.filter(a => a.type === 'webdav').length === 0 && !showWebDAVForm && (
                            <div className="text-center py-6 border border-dashed rounded-[7px] border-border/50">
                                <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.111')}</p>
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1"
                                    onClick={() => setShowWebDAVForm(true)}
                                >
                                    {t('settings.remaining.shared.addNow')}</Button>
                            </div>
                        )}
                    </div>
                </div>

                <AnimatePresence>
                    {showWebDAVForm && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="bg-muted/30 border-t border-border/50"
                        >
                            <SettingsFormLayout guide={<div className="space-y-4">
                                    <div className="flex items-center gap-2 text-[13px] font-semibold text-primary">
                                        <Network className="h-4 w-4" />
                                        <span>{t('settings.remaining.copy.112')}</span>
                                    </div>
                                    <p className="text-[12px] text-muted-foreground leading-relaxed">
                                        {t('settings.remaining.shared.webdavCredentialsHint')}</p>
                                </div>}>


                                <div className="settings-form-grid">
                                    <SettingsField label={t('settings.remaining.copy.101')} className="md:col-span-2">
                                        <input
                                            type="text"
                                            value={webdavAccountName}
                                            onChange={e => setWebdavAccountName(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder={t('settings.remaining.copy.391')}
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.114')} className="md:col-span-2">
                                        <input
                                            type="text"
                                            value={webdavUrl}
                                            onChange={e => setWebdavUrl(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder="https://dav.jianguoyun.com/dav/"
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.115')}>
                                        <input
                                            type="text"
                                            value={webdavUsername}
                                            onChange={e => setWebdavUsername(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder={t('settings.remaining.copy.392')}
                                        />
                                    </SettingsField>
                                    <SettingsField label={t('settings.remaining.copy.116')}>
                                        <input
                                            type="password"
                                            value={webdavPassword}
                                            onChange={e => setWebdavPassword(e.target.value)}
                                            className="w-full px-3 py-2"
                                            placeholder={t('settings.remaining.copy.393')}
                                        />
                                    </SettingsField>
                                </div>

                                <div className="settings-save-panel">
                                    <div className="settings-action-row">
                                        <div className="space-y-0.5">
                                            <h4 className="text-[13px] font-medium text-primary">{t('settings.remaining.copy.105')}</h4>
                                            <p className="text-[12px] text-muted-foreground">{t('settings.remaining.copy.118')}</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveWebDAVConfig}
                                            disabled={isSaving || !webdavUrl}
                                        >
                                            {isSaving ? t('settings.remaining.copy.380') : t('settings.remaining.copy.381')}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowWebDAVForm(false)}>{t('settings.remaining.copy.107')}</Button>
                                </div>
                            </SettingsFormLayout>
                        </motion.div>
                    )}
                </AnimatePresence></details>
            </SettingsSection>

            {/* OpenList native storage: connection and account switching only. */}
            <SettingsSection sectionId="openlist" title={t('settings.openlist.title')}>

<details className="settings-provider-group" open={config?.accounts.some(a => a.type === 'openlist') || undefined}><summary>{t(config?.accounts.some(a => a.type === 'openlist') ? 'uiAudit.configured' : 'uiAudit.other')} · OpenList</summary><div className="settings-provider-block">
                    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                            <div className="settings-icon"><Server className="h-4 w-4" /></div>
                            <div className="min-w-0 flex-1">
                                <span className="ru-copy text-[13px] font-medium">{t('settings.openlist.accounts')}</span>
                                <p className="ru-copy text-[12px] text-muted-foreground">{t('settings.openlist.description')}</p>
                            </div>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => setShowOpenListForm(!showOpenListForm)}>
                            {showOpenListForm ? t('settings.openlist.cancelAdd') : t('settings.openlist.addAccount')}
                        </Button>
                    </div>
                    <div className="space-y-2">
                        {config?.accounts.filter(account => account.type === 'openlist').map(account => (
                            <div key={account.id} className={cn("flex flex-col gap-3 rounded-[7px] border p-3 sm:flex-row sm:items-center sm:justify-between", account.is_active ? "border-primary/20 bg-primary/5" : "border-border bg-background")}>
                                <div className="min-w-0">
                                    <p className="text-[13px] font-medium">{account.name || t('settings.openlist.unnamed')}</p>
                                    <details className="settings-account-details"><summary>{t('uiAudit.details')}</summary><code>{account.id}</code></details>
                                    <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                </div>
                                <div className="flex items-center justify-end gap-2">
                                    {account.is_active ? <span className="rounded bg-green-500/10 px-2 py-1 text-[12px] font-semibold settings-text-success">{t('settings.openlist.inUse')}</span> : <>
                                        <Button size="sm" variant="ghost" onClick={() => handleSwitchProvider('openlist', account.id)} disabled={isSaving}>{t('settings.openlist.switchAccount')}</Button>
                                        <Button size="sm" variant="ghost" className="w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={t('management.telegramAccounts.account.delete')}
                                                onClick={() => handleDeleteAccount(account.id, account.name)} disabled={isSaving} title={t('settings.openlist.deleteTitle')}><Trash2 className="h-3.5 w-3.5" /></Button>
                                    </>}
                                </div>
                            </div>
                        ))}
                        {config?.accounts.filter(account => account.type === 'openlist').length === 0 && !showOpenListForm && <p className="rounded-[7px] border border-dashed py-6 text-center text-[12px] text-muted-foreground">{t('settings.openlist.empty')}</p>}
                    </div>
                </div>
                <AnimatePresence>
                    {showOpenListForm && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="border-t border-border/50 bg-muted/30">
                        <div className="settings-inset space-y-5">
                            <div className="settings-form-grid">
                                <SettingsField label={t('settings.openlist.accountName')} className="md:col-span-2"><input value={openlistAccountName} onChange={event => setOpenlistAccountName(event.target.value)} className="w-full px-3 py-2" placeholder={t('settings.openlist.accountPlaceholder')} /></SettingsField>
                                <SettingsField label={t('settings.openlist.address')} className="md:col-span-2"><input type="url" value={openlistBaseUrl} onChange={event => setOpenlistBaseUrl(event.target.value)} className="w-full px-3 py-2" placeholder="https://openlist.example.com" /></SettingsField>
                                <SettingsField label={t('settings.openlist.rootPath')} className="md:col-span-2"><input value={openlistRootPath} onChange={event => setOpenlistRootPath(event.target.value)} className="w-full px-3 py-2" placeholder="/" /><p className="ru-copy text-[12px] text-muted-foreground">{t('settings.openlist.rootHint')}</p></SettingsField>
                                <SettingsField label={t('settings.openlist.username')}><input autoComplete="username" value={openlistUsername} onChange={event => setOpenlistUsername(event.target.value)} className="w-full px-3 py-2" /></SettingsField>
                                <SettingsField label={t('settings.openlist.password')}><input type="password" autoComplete="new-password" value={openlistPassword} onChange={event => setOpenlistPassword(event.target.value)} className="w-full px-3 py-2" /></SettingsField>
                            </div>
                            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => { setShowOpenListForm(false); setOpenlistPassword(''); }}>{t('settings.openlist.cancel')}</Button><Button onClick={handleSaveOpenListConfig} disabled={isSaving || !openlistBaseUrl || !openlistUsername || !openlistPassword}>{isSaving ? t('settings.openlist.saving') : t('settings.openlist.save')}</Button></div>
                        </div>
                    </motion.div>}
                </AnimatePresence></details>
            </SettingsSection>
            <SettingsSection title={t("settings.storage.title")}>
                <div className="settings-inset space-y-6">
                    {storageStats ? (
                        <>
                            {/* 服务器存储 */}
                            <div className="space-y-3">
                                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="flex min-w-0 items-center gap-3">
                                        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                                            <Server className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <p className="text-[13px] font-medium">{t('settings.remaining.copy.120')}</p>
                                            <div className="flex items-baseline gap-1">
                                                <span className="text-2xl font-bold tracking-tight">{storageStats.server.used}</span>
                                                <span className="text-[13px] text-muted-foreground font-medium">/ {storageStats.server.total}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex min-w-0 flex-wrap items-center gap-3">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[13px] text-muted-foreground">{t('settings.remaining.copy.121')}</span>
                                            <span className="text-[13px] font-medium settings-text-success">{storageStats.server.free}</span>
                                        </div>
                                        <span className={cn(
                                            "text-lg font-semibold",
                                            storageStats.server.usedPercent > 90 ? "text-red-500" :
                                                storageStats.server.usedPercent > 70 ? "text-yellow-500" : "settings-text-success"
                                        )}>
                                            {storageStats.server.usedPercent}%
                                        </span>
                                    </div>
                                </div>
                                <div className="h-3 w-full bg-secondary/50 rounded-full overflow-hidden">
                                    <motion.div
                                        initial={{ width: 0 }}
                                        animate={{ width: `${storageStats.server.usedPercent}%` }}
                                        transition={{ duration: 1, ease: "easeOut" }}
                                        className={cn(
                                            "h-full rounded-full",
                                            storageStats.server.usedPercent > 90 ? "bg-red-500" :
                                                storageStats.server.usedPercent > 70 ? "bg-yellow-500" : "bg-primary"
                                        )}
                                    />
                                </div>
                            </div>

                            {/* 分隔线 */}
                            <div className="border-t border-border/50" />

                            {/* TG Vault 使用量 */}
                            <div className="space-y-3">
                                <div className="flex items-center">
                                    <div className="flex items-center gap-3">
                                        <div className="h-10 w-10 rounded-full bg-blue-500/10 flex items-center justify-center text-primary">
                                            <Cloud className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <p className="text-[13px] font-medium">{t('settings.remaining.copy.122')}</p>
                                            <div className="flex items-baseline gap-1">
                                                <span className="text-2xl font-bold tracking-tight">{storageStats.tgvault.used}</span>
                                                <span className="text-[13px] text-muted-foreground font-medium">
                                                    ({t('files.ui.storage.fileCount', { count: storageStats.tgvault.fileCount })})
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="flex items-center justify-center py-8">
                            <div className="text-center text-muted-foreground">
                                <HardDrive className="h-8 w-8 mx-auto mb-2 opacity-50" />
                                <p className="text-[13px]">{t('settings.remaining.copy.123')}</p>
                            </div>
                        </div>
                    )}
                </div>
            </SettingsSection>
            </div>}

        </motion.div>
    );
};
