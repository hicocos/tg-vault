import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { HardDrive, ChevronRight, Palette, Globe, Cloud, Server, Database, CheckCircle, Trash2, Network, Shield, ShieldAlert, ShieldCheck, ExternalLink, BookOpen, KeyRound, LogOut, UserX, CircleHelp, XCircle, RefreshCw, Gauge, Copy, X, PackageCheck } from "lucide-react";
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
import { TelegramUserAccountsPanel } from "./TelegramUserAccountsPanel";

interface SettingsPageProps {
    storageStats?: StorageStats | null;
    onSignedOut?: () => void;
    onOpenTasksForAccount?: (accountId: string) => void;
    onStorageConfigChanged?: (config: StorageConfig) => void;
    onStorageStatsRefresh?: (accountId: string | null) => Promise<void>;
    activeSection: SettingsSectionId;
    onSectionChange: (section: SettingsSectionId) => void;
}

interface SettingsSectionProps {
    title: string;
    children: React.ReactNode;
}

const SettingsSection = ({ title, children }: SettingsSectionProps) => (
    <div className="space-y-4">
        <h3 className="text-lg font-medium tracking-tight text-foreground">{title}</h3>
        <div className="rounded-xl border border-border bg-card overflow-hidden">
            {children}
        </div>
    </div>
);

interface SettingsRowProps {
    icon: React.ElementType;
    label: string;
    value?: string;
    action?: React.ReactNode;
    onClick?: () => void;
    description?: string;
    stackActionOnMobile?: boolean;
}

const SettingsRow = ({ icon: Icon, label, value, action, onClick, description, stackActionOnMobile = false }: SettingsRowProps) => (
    <div
        className={cn(
            "flex justify-between gap-4 p-4 border-b border-border/50 last:border-0 transition-colors",
            stackActionOnMobile ? "flex-col items-stretch sm:flex-row sm:items-center" : "items-center",
            onClick ? "cursor-pointer hover:bg-muted/30" : ""
        )}
        onClick={onClick}
    >
        <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
                <div className="shrink-0 p-2 rounded-lg bg-muted text-muted-foreground">
                    <Icon className="h-4 w-4" />
                </div>
                <span className="text-sm font-medium">{label}</span>
            </div>
            {description && <p className="mt-1.5 text-xs leading-5 text-muted-foreground sm:pl-11">{description}</p>}
        </div>
        <div className={cn("flex items-center gap-3", stackActionOnMobile && "w-full pl-11 sm:w-auto sm:shrink-0 sm:pl-0")}>
            {value && <span className="text-sm text-muted-foreground">{value}</span>}
            {action && <div className={cn(stackActionOnMobile && "w-full sm:w-auto")}>{action}</div>}
            {!action && onClick && <ChevronRight className="h-4 w-4 text-muted-foreground/50" />}
        </div>
    </div>
);

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
                "inline-flex items-center gap-1 rounded-md border px-2 py-1",
                status === 'available' && "border-emerald-200 bg-emerald-50 text-emerald-700",
                status === 'failed' && "border-red-200 bg-red-50 text-red-700",
                !status && "border-border bg-muted text-muted-foreground",
            )} title={account.last_probe_error || undefined}>
                <Icon className="h-3.5 w-3.5" />
                {label}
            </span>
            {account.last_probed_at && <span className="text-muted-foreground break-words">{new Date(account.last_probed_at).toLocaleString(i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en-US', { hour12: false })}</span>}
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" disabled={busy} onClick={onProbe}>
                {busy ? <IndeterminateSpinner label={t('settings.probe.testing')} size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {t('settings.probe.test')}
            </Button>
            {feedback && <span className={cn("min-w-0 basis-full rounded-md px-2 py-1.5 font-medium [overflow-wrap:anywhere]", feedback.tone === 'success' ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")} role="status" aria-live="polite">{feedback.tone === 'success' ? <CheckCircle className="mr-1 inline h-3.5 w-3.5" /> : <XCircle className="mr-1 inline h-3.5 w-3.5" />}{feedback.message}</span>}
            {!feedback && status === 'failed' && account.last_probe_error && <p className="min-w-0 basis-full [overflow-wrap:anywhere] text-red-700">{account.last_probe_error}</p>}
        </div>
    );
};

const ActionNotice = ({ state, onClose }: { state: ActionNoticeState; onClose: () => void }) => {
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
            <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" onClick={onClose} aria-label="关闭提示" title="关闭提示"><X className="h-4 w-4" /></button>
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
                        {danger && <p className="mt-1 text-xs font-medium text-destructive">{state.dangerDescription || '此操作不可撤销，请谨慎确认'}</p>}
                    </div>
                    <button type="button" onClick={onCancel} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground" aria-label="关闭确认弹窗"><X className="h-4 w-4" /></button>
                </div>
                <div className="max-h-[min(60vh,32rem)] overflow-y-auto px-5 py-5 sm:px-6">
                    <p id="settings-action-message" className="whitespace-pre-line text-sm leading-6 text-muted-foreground">{state.message}</p>
                    {state.mode === 'prompt' && (
                        <input
                            autoFocus
                            type={state.inputType || 'text'}
                            value={input}
                            onChange={event => onInput(event.target.value)}
                            onKeyDown={event => { if (event.key === 'Enter') onConfirm(); }}
                            className="mt-4 h-11 w-full rounded-lg border border-border bg-background px-3 outline-none focus:ring-2 focus:ring-primary/20"
                        />
                    )}
                </div>
                <div className="flex flex-col-reverse gap-2 border-t border-border bg-muted/20 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
                    <Button variant="outline" onClick={onCancel}>{state.cancelLabel || '取消'}</Button>
                    <Button variant={danger ? 'destructive' : 'default'} onClick={onConfirm}>{state.confirmLabel || '确认'}</Button>
                </div>
            </motion.div>
        </Dialog>
    );
};

export const SettingsPage = ({ storageStats, onSignedOut, onOpenTasksForAccount, onStorageConfigChanged, onStorageStatsRefresh, activeSection, onSectionChange }: SettingsPageProps) => {
    const { t } = useTranslation();

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
    const showNotice = (message: string, title = '操作结果') => {
        const errorTone = /失败|错误|不完整|被引用|阻止/.test(title);
        setActionNotice({ title, message, tone: errorTone ? 'error' : 'success' });
        return Promise.resolve();
    };
    const requestConfirmation = (message: string, title = '请确认', options?: { tone?: 'default' | 'danger'; dangerDescription?: string; cancelLabel?: string; confirmLabel?: string }) => new Promise<boolean>(resolve => {
        setActionDialog({ mode: 'confirm', title, message, ...options, resolve: value => resolve(value === true) });
    });
    const requestInput = (message: string, title = '请输入', inputType: 'text' | 'password' = 'text') => new Promise<string | null>(resolve => {
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
                ? '此功能一般不需要开启。仅适合频道同时发布一张普通图片和一个原图文件，而你只想保存原图文件的场景。\n\n开启后，订阅、按日期和按标签批量下载将跳过频道中的所有普通图片，只下载作为文件发送的图片及其他文件；如果频道只发普通图片，这些图片会被漏掉。确认开启吗？'
                : '该并发值可能触发 Telegram 限流、断流或账号风控。确认继续吗？';
            const confirmationTitle = enablingPhotoFilter ? '确认跳过频道普通图片' : '高并发二次确认';
            if (!(await requestConfirmation(confirmationMessage, confirmationTitle))) return;
            result = await fileApi.updateAdvancedTaskSetting(patch, true);
        }
        await reloadAdvancedTasks();
        if ('telegramDownloadHistoryPolicy' in patch) {
            const message = patch.telegramDownloadHistoryPolicy === 'errors_only'
                ? `已改为仅保留错误；同时移除了 ${result.deletedCount || 0} 条已完成的成功/跳过明细。`
                : '已改为保留全部明细；从现在开始记录完整下载历史。';
            await showNotice(message);
        }
    };

    const handleCleanupDownloadItems = async () => {
        if (isCleaningDownloadItems) return;
        if (!(await requestConfirmation(`确定删除 ${cleanupRetentionDays} 天前已完成的 Telegram 下载任务历史吗？\n\n只删除任务审计明细，不删除文件索引，也不删除云端文件。`, '删除任务历史'))) return;
        setIsCleaningDownloadItems(true);
        try {
            const result = await fileApi.cleanupDownloadItems(cleanupRetentionDays);
            await showNotice(`已删除 ${result.deletedCount} 条已完成下载任务历史。`);
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || '删除下载任务历史失败', '操作失败');
        } finally {
            setIsCleaningDownloadItems(false);
        }
    };

    const reloadTelegramBotConfig = async () => {
        const data = await fileApi.getTelegramBotConfig();
        setTelegramBotConfig(data);
        return data;
    };

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
            await showNotice(`请输入${telegramPinVerificationMethod === 'current_pin' ? '当前 PIN' : '网页管理员密码'}`, '修改失败');
            return;
        }
        if (!/^\d{4}$/.test(newTelegramPin)) {
            await showNotice('新 Telegram Bot PIN 必须是 4 位数字', '修改失败');
            return;
        }
        if (newTelegramPin !== confirmNewTelegramPin) {
            await showNotice('两次输入的新 PIN 不一致', '修改失败');
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
            await showNotice(result.message || 'Telegram Bot PIN 已修改');
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || '修改 Telegram Bot PIN 失败', '修改失败');
        } finally {
            setIsChangingTelegramPin(false);
        }
    };

    const handleTestTelegramBot = async () => {
        setIsSavingTelegramBot(true);
        try {
            const result = await fileApi.testTelegramBotConfig({ botToken: telegramBotToken, apiId: telegramApiId, apiHash: telegramApiHash });
            await showNotice(`连接成功${result.bot.username ? `：@${result.bot.username}` : ''}`);
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || 'Telegram Bot 凭证测试失败', '测试失败');
        } finally { setIsSavingTelegramBot(false); }
    };

    const handleSaveTelegramBot = async () => {
        if (!telegramBotConfig?.pinConfigured && !/^\d{4}$/.test(telegramPin)) {
            await showNotice('Telegram Bot PIN 必须是 4 位数字', '保存失败');
            return;
        }
        setIsSavingTelegramBot(true);
        try {
            const result = await fileApi.saveTelegramBotConfig({ botToken: telegramBotToken, apiId: telegramApiId, apiHash: telegramApiHash, enabled: true, required: false, telegramPin: telegramBotConfig?.pinConfigured ? undefined : telegramPin });
            setTelegramBotConfig(result.config);
            clearTelegramBotInputs();
            setShowTelegramBotForm(false);
            await showNotice('Telegram Bot 凭证已安全保存并启用');
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || '保存 Telegram Bot 配置失败', '保存失败');
        } finally { setIsSavingTelegramBot(false); }
    };

    const handleMigrateTelegramBot = async () => {
        if (!telegramBotConfig?.pinConfigured && !/^\d{4}$/.test(telegramPin)) {
            await showNotice('迁移前请创建正好 4 位数字的 Telegram Bot PIN', '需要创建 PIN');
            return;
        }
        if (!(await requestConfirmation('将从后端环境变量读取 Telegram Bot 凭证，加密保存到数据库，并切换为网页管理。浏览器不会收到原凭证。确认迁移吗？', '迁移 Telegram Bot 配置'))) return;
        setIsSavingTelegramBot(true);
        try {
            const result = await fileApi.migrateTelegramBotConfig({ telegramPin: telegramBotConfig?.pinConfigured ? undefined : telegramPin });
            setTelegramBotConfig(result.config);
            setTelegramPin('');
            await showNotice('已迁移到网页加密管理；确认运行正常后可从 .env 删除旧凭证');
        } catch (error: unknown) { await showNotice(errorMessage(error) || '迁移失败', '迁移失败'); }
        finally { setIsSavingTelegramBot(false); }
    };

    const handleDeleteTelegramBot = async () => {
        if (!(await requestConfirmation(
            '删除后 Bot 将立即停止，已保存的 Bot Token、API ID、API Hash 和 Bot session 将被永久删除。\n\nTelegram 允许用户列表会保留；如需再次使用 Bot，必须重新填写完整凭证并建立连接。此操作无法撤销。',
            '二次确认：删除 Telegram Bot 配置',
            { tone: 'danger', dangerDescription: '将永久删除凭证和 Bot session，无法撤销', cancelLabel: '取消删除', confirmLabel: '确认永久删除' },
        ))) return;
        setIsSavingTelegramBot(true);
        try { const result = await fileApi.deleteTelegramBotConfig(); setTelegramBotConfig(result.config); clearTelegramBotInputs(); setShowTelegramBotForm(true); await showNotice('Telegram Bot 配置已删除'); }
        catch (error: unknown) { await showNotice(errorMessage(error) || '删除失败', '操作失败'); }
        finally { setIsSavingTelegramBot(false); }
    };

    const handleSaveTelegramAllowedUsers = async () => {
        if (isSavingTelegramAllowedUsers) return;
        setIsSavingTelegramAllowedUsers(true);
        try {
            const result = await fileApi.setTelegramAllowedUserIds(telegramAllowedUserIdsInput);
            setTelegramAllowedUserIdsInput(result.userIds.join(', '));
            await reloadStorageConfig();
            await showNotice('Telegram 允许用户列表已保存');
        } catch (error: unknown) {
            await showNotice(errorMessage(error) || '更新 Telegram 允许用户列表失败', '保存失败');
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
            console.error('存储账户已更新，但容量统计刷新失败:', error);
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
            await showNotice(errorMessage(error) || '检查版本失败', '检查失败');
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
            setProbeFeedback(previous => ({ accountId: account.id, tone: 'success', message: '连接测试成功', sequence: (previous?.sequence ?? 0) + 1 }));
        } catch (error: unknown) {
            await reloadStorageConfig().catch(() => undefined);
            setProbeFeedback(previous => ({ accountId: account.id, tone: 'error', message: errorMessage(error) || '连接测试失败，请稍后重试', sequence: (previous?.sequence ?? 0) + 1 }));
        } finally {
            setProbingAccountId(null);
        }
    };

    // Load initial config
    useEffect(() => {
        const loadConfig = async () => {
            try {
                const [, , , versionStatus] = await Promise.all([reloadStorageConfig(), reloadAdvancedTasks(), reloadTelegramBotConfig(), fileApi.getUpdateStatus()]);
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
            'local': '本地存储',
            'onedrive': 'OneDrive',
            'aliyun_oss': '阿里云 OSS',
            's3': 'S3 兼容存储',
            'webdav': 'WebDAV 存储',
            'openlist': 'OpenList 原生存储',
            'google_drive': 'Google Drive'
        };
        const providerName = providerNames[provider];

        if (!(await requestConfirmation(`确定要把系统默认存储切换到 ${providerName}${accountId ? '（指定账户）' : ''}吗？\n\n这会影响所有用户后续新提交的任务；已经提交的上传、Telegram 和 yt-dlp 任务仍使用原目标。切换前会执行只读连接测试。`, '切换系统默认存储'))) return;

        setIsSaving(true);
        try {
            await fileApi.switchStorageProvider(provider, accountId);
            const data = await reloadStorageConfig();
            const statisticsFresh = await refreshStorageStats(data);
            await showNotice(statisticsFresh
                ? `已成功切换到 ${providerName}`
                : `已成功切换到 ${providerName}，但容量统计刷新失败，请稍后手动刷新`,
            statisticsFresh ? '操作结果' : '切换完成');
        } catch (error: unknown) {
            await reloadStorageConfig().catch(() => undefined);
            await showNotice(errorMessage(error), '操作失败');
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
                '开启后，WebDAV 可以访问内网、回环或保留地址，并允许使用明文 HTTP。\n\n风险：这会扩大服务端请求伪造（SSRF）攻击面；恶意或填错的地址可能探测、访问本机或局域网服务。HTTP 还会让 WebDAV 用户名、密码和文件内容在传输途中以明文暴露。\n\n仅在 TG Vault 为可信管理员专用、WebDAV 地址由你控制且网络隔离可靠时开启。是否确认承担风险并开启？',
                '二次确认：开启高风险 WebDAV 访问',
                { tone: 'danger', dangerDescription: '此操作会降低默认网络安全保护', cancelLabel: '保持关闭', confirmLabel: '确认开启' },
            );
            if (!confirmed) return;
        }
        setIsSavingWebdavSecurity(true);
        try {
            const result = await fileApi.setUnsafeWebdavEndpointsAllowed(enabled, confirmed);
            setConfig(previous => previous ? { ...previous, allowUnsafeWebdavEndpoints: result.allowUnsafeWebdavEndpoints } : previous);
            await showNotice(enabled ? '已允许内网和不安全的 WebDAV 地址' : '已恢复 WebDAV 安全限制');
        } catch (error: unknown) {
            if (errorCode(error) === 'CONFIRMATION_REQUIRED') {
                await showNotice('服务端要求二次确认，请重新操作。', '未完成确认');
            } else {
                await showNotice(errorMessage(error) || '更新 WebDAV 安全设置失败', '操作失败');
            }
        } finally {
            setIsSavingWebdavSecurity(false);
        }
    };

    const handleSaveGDConfig = async () => {
        if (!gdClientId || !gdClientSecret) {
            await showNotice('请填写 Client ID 和 Client Secret', '信息不完整');
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
                throw new Error('授权窗口被浏览器拦截，请允许弹窗后重试');
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
                    if (typeof accountId !== 'string' || !accountId) throw new Error('授权回调缺少新账户标识');
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
                    if (state === 'cancelled') await showNotice('Google Drive 授权已取消，表单内容已保留。', '授权已取消');
                    if (state === 'failed') {
                        const providerError = flowError instanceof MessageEvent
                            ? (flowError.data as { error?: unknown }).error
                            : undefined;
                        await showNotice(`Google Drive 授权失败: ${typeof providerError === 'string' ? providerError : flowError instanceof Error ? flowError.message : '未知错误'}`, '授权失败');
                    }
                    if (state === 'success') await showNotice(statisticsFresh
                        ? 'Google Drive 授权成功并已启用！'
                        : 'Google Drive 授权成功并已启用，但容量统计刷新失败，请稍后手动刷新。',
                    statisticsFresh ? '操作结果' : '授权完成');
                },
            });
        } catch (error: unknown) {
            setIsSaving(false);
            await showNotice('发起授权失败: ' + errorMessage(error), '授权失败');
        }
    };

    const handleDeleteAccount = async (accountId: string, accountName: string) => {
        try {
            const preview = await fileApi.previewAccountDeletion(accountId);
            const impact = preview.impact;
            const busyCount = impact.activeLeaseCount + impact.activeTaskCount + impact.activeUploadCount;
            const impactText = [
                `账户：${accountName}`,
                `将删除 TG Vault 索引：${impact.fileCount} 条`,
                `索引容量：${(impact.totalSizeBytes / 1024 / 1024).toFixed(2)} MiB`,
                `涉及目录：${impact.folderCount} 个`,
                `活动租约/任务/上传：${impact.activeLeaseCount}/${impact.activeTaskCount}/${impact.activeUploadCount}`,
                '',
                '不会删除云端原文件；执行时服务端会重新检查活动租约和任务。',
                ...(busyCount > 0 ? ['', '当前存在活动引用，执行将被服务端阻止。请先结束相关任务。'] : []),
            ].join('\n');
            if (busyCount > 0) {
                await showNotice([
                    impactText,
                    '',
                    '请到任务中心取消对应任务；频道订阅等固定目标会在任务中心展示其账户引用。',
                ].join('\n'), '账户仍被引用');
                onOpenTasksForAccount?.(accountId);
                return;
            }
            if (!(await requestConfirmation(impactText, '删除存储账户'))) return;
            const result = await fileApi.deleteAccount(accountId, preview.confirmationToken);
            const data = await reloadStorageConfig();
            const statisticsFresh = await refreshStorageStats(data);
            await showNotice(statisticsFresh
                ? result.message
                : `${result.message}；但容量统计刷新失败，请稍后手动刷新`,
            statisticsFresh ? '操作结果' : '删除完成');
        } catch (error: unknown) {
            await showNotice(errorMessage(error), '操作失败');
        }
    };

    const handleSaveOneDriveConfig = async () => {
        if (!odClientId) {
            await showNotice('请填写 Client ID', '信息不完整');
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
                throw new Error('授权窗口被浏览器拦截，请允许弹窗后重试');
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
                    if (typeof accountId !== 'string' || !accountId) throw new Error('授权回调缺少新账户标识');
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
                    if (state === 'cancelled') await showNotice('OneDrive 授权已取消，表单内容已保留。', '授权已取消');
                    if (state === 'failed') {
                        const providerError = flowError instanceof MessageEvent
                            ? (flowError.data as { error?: unknown }).error
                            : undefined;
                        await showNotice(`OneDrive 授权失败: ${typeof providerError === 'string' ? providerError : flowError instanceof Error ? flowError.message : '未知错误'}`, '授权失败');
                    }
                    if (state === 'success') await showNotice(statisticsFresh
                        ? 'OneDrive 授权成功并已启用！'
                        : 'OneDrive 授权成功并已启用，但容量统计刷新失败，请稍后手动刷新。',
                    statisticsFresh ? '操作结果' : '授权完成');
                },
            });
        } catch (error: unknown) {
            setIsSaving(false);
            await showNotice('发起授权失败: ' + errorMessage(error), '授权失败');
        }
    };

    const handleSaveOSSConfig = async () => {
        if (!ossAccountName || !ossRegion || !ossAccessKeyId || !ossAccessKeySecret || !ossBucket) {
            await showNotice('请填写所有必填项', '信息不完整');
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.addAliyunOSSAccount(ossAccountName, ossRegion, ossAccessKeyId, ossAccessKeySecret, ossBucket);
            await reloadStorageConfig();
            await showNotice('阿里云 OSS 账户添加成功！');
            setShowOSSForm(false);
        } catch (error: unknown) {
            await showNotice('添加阿里云 OSS 账户失败: ' + errorMessage(error), '添加失败');
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveS3Config = async () => {
        if (!s3AccountName || !s3Endpoint || !s3Region || !s3AccessKeyId || !s3AccessKeySecret || !s3Bucket) {
            await showNotice('请填写所有必填项', '信息不完整');
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.addS3Account(s3AccountName, s3Endpoint, s3Region, s3AccessKeyId, s3AccessKeySecret, s3Bucket, s3ForcePathStyle);
            await reloadStorageConfig();
            await showNotice('S3 兼容存储账户添加成功！');
            setShowS3Form(false);
        } catch (error: unknown) {
            await showNotice('添加 S3 兼容存储账户失败: ' + errorMessage(error), '添加失败');
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveWebDAVConfig = async () => {
        if (!webdavAccountName || !webdavUrl) {
            await showNotice('请填写账户名称和 URL', '信息不完整');
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.addWebDAVAccount(webdavAccountName, webdavUrl, webdavUsername, webdavPassword);
            await reloadStorageConfig();
            await showNotice('WebDAV 存储账户添加成功！');
            setShowWebDAVForm(false);
        } catch (error: unknown) {
            await showNotice('添加 WebDAV 存储账户失败: ' + errorMessage(error), '添加失败');
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
                setTwoFAError(result.error || "验证失败");
            }
        } catch (error: unknown) {
            setTwoFAError(errorMessage(error));
        } finally {
            setIsActivating2FA(false);
        }
    };

    const handleDisable2FA = async () => {
        const password = await requestInput('为了安全，请确认您的管理员密码以禁用 2FA：', '禁用双重验证', 'password');
        if (!password) return;

        setIsLoading2FA(true);
        try {
            const result = await authService.disable2FA(password);
            if (result.success) {
                setIs2FAActivated(false);
                setShow2FA(false);
            } else {
                await showNotice(result.error || '禁用失败', '操作失败');
            }
        } catch (error: unknown) {
            await showNotice(errorMessage(error), '操作失败');
        } finally {
            setIsLoading2FA(false);
        }
    };

    const handleChangePassword = async () => {
        if (isChangingPassword) return;
        if (newPassword.length < 8) return setPasswordError('新密码至少需要 8 位');
        if (newPassword !== confirmPassword) return setPasswordError('两次输入的新密码不一致');
        setIsChangingPassword(true);
        setPasswordError(null);
        try {
            const result = await authService.changePassword(currentPassword, newPassword);
            if (!result.success) return setPasswordError(result.error || '修改密码失败');
            onSignedOut?.();
        } finally {
            setIsChangingPassword(false);
        }
    };

    const handleRevokeAllSessions = async () => {
        if (!(await requestConfirmation('确定退出所有设备吗？当前浏览器也需要重新登录。', '退出所有设备'))) return;
        const result = await authService.revokeAllSessions();
        if (!result.success) return void await showNotice(result.error || '退出所有设备失败', '操作失败');
        onSignedOut?.();
    };

    const handleLogoutCurrentSession = async () => {
        await authService.logout();
        onSignedOut?.();
    };

    return (
        <motion.div
            data-testid="settings-page"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto mt-6 w-full min-w-0 max-w-5xl space-y-8 pb-10"
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
            <div className="flex items-center gap-4 mb-2">
                <div className="p-3 bg-secondary rounded-xl">
                    <Palette className="h-6 w-6 text-foreground" />
                </div>
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">{t("settings.title")}</h2>
                    <p className="text-muted-foreground">{t("settings.subtitle")}</p>
                </div>
            </div>

            <nav
                data-testid="settings-tabs"
                className="sticky top-0 z-20 -mx-1 flex w-full max-w-full gap-2 overflow-x-auto overscroll-x-contain rounded-xl border border-border bg-background/95 p-2 shadow-sm backdrop-blur touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                aria-label={t('settings.title')}
            >
                {SETTINGS_SECTIONS.map(section => (
                    <Button
                        key={section.id}
                        size="sm"
                        variant={activeSection === section.id ? 'default' : 'ghost'}
                        className="min-h-10 shrink-0"
                        onClick={() => onSectionChange(section.id)}
                        aria-current={activeSection === section.id ? 'page' : undefined}
                    >
                        {t(section.labelKey)}
                    </Button>
                ))}
            </nav>

            {activeSection === 'general' && <>
            {/* General Section: Language & Theme */}
            <SettingsSection title={t("settings.general.title")}>
                <SettingsRow
                    icon={Globe}
                    label={t("settings.general.language")}
                    action={<LanguageToggle />}
                />
            {/* Theme controls live in the global header so appearance is reachable from every page. */}
            </SettingsSection>
            <SettingsSection title={t('updates.settingsTitle')}>
                <SettingsRow
                    icon={PackageCheck}
                    label="TG Vault"
                    description={updateStatus?.checkedAt
                        ? `${t('updates.lastChecked', { time: new Date(updateStatus.checkedAt).toLocaleString() })}${updateStatus.stale ? t('updates.staleSuffix') : ''}`
                        : updateStatus?.enabled === false ? t('updates.disabled') : t('updates.notChecked')}
                    stackActionOnMobile
                    action={
                        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                            <span className="text-xs text-muted-foreground">{t('updates.current', { version: updateStatus?.currentVersion || '—' })}</span>
                            <span className={cn("rounded-full px-2 py-1 text-xs font-semibold", updateStatus?.updateAvailable ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-200" : "bg-muted text-muted-foreground")}>
                                {updateStatus?.updateAvailable ? t('updates.latest', { version: updateStatus.latestVersion }) : updateStatus?.latestVersion ? t('updates.upToDate') : t('updates.waiting')}
                            </span>
                            {updateStatus?.releaseUrl && (
                                <a href={updateStatus.releaseUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium hover:bg-muted">
                                    {t('updates.releaseNotes')} <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                            )}
                            <Button size="sm" variant="outline" disabled={isCheckingUpdates || updateStatus?.enabled === false} onClick={() => void handleCheckForUpdates()}>
                                {isCheckingUpdates ? <IndeterminateSpinner label={t('updates.checking')} size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                {t('updates.checkNow')}
                            </Button>
                        </div>
                    }
                />
            </SettingsSection>
            </>}

            {activeSection === 'security' && <>
            {/* Security Section */}
            {/* i18n source: 安全设置 */}
            <SettingsSection title={t('settings.security.title')}>
                <div className="border-b border-border/50 p-4 space-y-4">
                    <div className="flex items-start gap-3">
                        <div className="p-2 rounded-lg bg-muted text-muted-foreground"><KeyRound className="h-4 w-4" /></div>
                        <div>
                            <p className="text-sm font-medium">修改管理员密码</p>
                            <p className="text-xs text-muted-foreground mt-1">修改成功后会撤销全部 Web 会话，所有设备都需要使用新密码重新登录。</p>
                        </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} placeholder="当前密码" className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                        <input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="新密码（至少 8 位）" className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                        <input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="再次输入新密码" className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-xs text-destructive">{passwordError}</p>
                        <Button size="sm" onClick={handleChangePassword} disabled={isChangingPassword || !currentPassword || !newPassword || !confirmPassword}>
                            {isChangingPassword ? '修改中...' : '修改并退出全部设备'}
                        </Button>
                    </div>
                </div>
                <SettingsRow
                    icon={LogOut}
                    label="退出当前设备"
                    description="立即撤销当前浏览器的登录会话。"
                    action={<Button size="sm" variant="outline" onClick={handleLogoutCurrentSession}>退出</Button>}
                />
                <SettingsRow
                    icon={UserX}
                    label="退出所有设备"
                    description="撤销当前密码下签发的全部 Web 会话。"
                    action={<Button size="sm" variant="outline" className="text-destructive" onClick={handleRevokeAllSessions}>全部退出</Button>}
                />
                <SettingsRow
                    icon={Shield}
                    label="双重验证 (2FA)"
                    description="启用 TOTP 二次验证以保护您的账户安全。支持 Google Authenticator, Authy 等应用。"
                    action={
                        <div className="flex items-center gap-2">
                            {is2FAActivated && (
                                <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 text-green-600 dark:text-green-400">
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                    <span className="text-xs font-semibold">已启用</span>
                                </div>
                            )}
                            <Button
                                size="sm"
                                variant={show2FA ? "outline" : "default"}
                                onClick={handleSetup2FA}
                                disabled={isLoading2FA}
                            >
                                {isLoading2FA ? "加载中..." : (show2FA ? "隐藏设置" : (is2FAActivated ? "重新配置" : "立即设置"))}
                            </Button>
                            {is2FAActivated && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-destructive hover:bg-destructive/10"
                                    onClick={handleDisable2FA}
                                    disabled={isLoading2FA}
                                >
                                    禁用
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
                                        <div className="p-3 bg-white rounded-xl shadow-inner inline-block mx-auto">
                                            <img src={twoFAQrCode} alt="2FA QR Code" className="w-48 h-48" />
                                        </div>

                                        <div className="space-y-2">
                                            <p className="text-sm font-medium">1. 扫描二维码</p>
                                            <p className="text-xs text-muted-foreground">
                                                使用您的 2FA App（如 Google Authenticator）扫描此二维码。
                                            </p>
                                        </div>

                                        {!is2FAActivated ? (
                                            <div className="pt-2 space-y-3">
                                                <p className="text-sm font-medium">2. 验证并激活</p>
                                                <p className="text-xs text-muted-foreground">
                                                    输入 App 生成的 6 位验证码以确认设置。
                                                </p>
                                                <div className="flex gap-2 justify-center">
                                                    <input
                                                        type="text"
                                                        maxLength={6}
                                                        value={activationCode}
                                                        onChange={(e) => setActivationCode(e.target.value.replace(/\D/g, ''))}
                                                        className="w-32 px-3 py-2 text-center text-lg tracking-widest font-mono rounded-lg border border-border bg-background focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                                        placeholder="000000"
                                                    />
                                                    <Button
                                                        onClick={handleActivate2FA}
                                                        disabled={isActivating2FA || activationCode.length !== 6}
                                                    >
                                                        {isActivating2FA ? "激活中..." : "验证激活"}
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="pt-2">
                                                <div className="flex items-center gap-2 justify-center text-green-600 dark:text-green-400">
                                                    <ShieldCheck className="h-4 w-4" />
                                                    <p className="text-sm font-medium">状态：已激活</p>
                                                </div>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    您的账户已受到 2FA 保护。登录时将要求输入验证码。
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="py-4 text-destructive flex flex-col items-center gap-2">
                                        <ShieldAlert className="h-8 w-8" />
                                        <p className="text-sm">{twoFAError || "无法加载 2FA 信息"}</p>
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
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3">
                            <div className={cn("rounded-lg p-2", config?.allowUnsafeWebdavEndpoints ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                                <Network className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-sm font-medium">允许内网和不安全的 WebDAV 地址</p>
                                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", config?.allowUnsafeWebdavEndpoints ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                                        {config?.allowUnsafeWebdavEndpoints ? '高风险模式' : '推荐：关闭'}
                                    </span>
                                </div>
                                <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">用于飞牛等局域网 WebDAV。开启后允许内网、回环、保留地址和 HTTP，可能带来 SSRF、局域网服务暴露及明文传输风险。</p>
                            </div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={!!config?.allowUnsafeWebdavEndpoints}
                            aria-label="允许内网和不安全的 WebDAV 地址"
                            onClick={handleUnsafeWebdavToggle}
                            disabled={!config || isSavingWebdavSecurity}
                            className={cn(
                                "relative h-7 w-12 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50",
                                config?.allowUnsafeWebdavEndpoints ? "border-destructive bg-destructive" : "border-border bg-muted",
                            )}
                        >
                            <span className={cn("absolute left-0 top-0.5 h-[22px] w-[22px] rounded-full bg-white shadow-sm transition-transform", config?.allowUnsafeWebdavEndpoints ? "translate-x-6" : "translate-x-0.5")} />
                            <span className="sr-only">{isSavingWebdavSecurity ? '保存中' : config?.allowUnsafeWebdavEndpoints ? '已开启' : '已关闭'}</span>
                        </button>
                    </div>
                </div>
            </SettingsSection>
            </>}

            {activeSection === 'maintenance' && <>
            {/* i18n source: 高级任务设置 */}
            <SettingsSection title={t('settings.maintenance.advancedTasks')}>
                {advancedTasks ? <div className="divide-y divide-border/50">
                    <SettingsRow icon={Gauge} label="单文件分片并发" description="与 Bot /download_workers 共用；12/16 需要二次确认。" action={
                        <select className="h-10 rounded-lg border border-border bg-background px-3" value={advancedTasks.telegramDownloadWorkers} onChange={event => void updateAdvancedTask({ telegramDownloadWorkers: Number(event.target.value) })}>
                            {[4, 8, 12, 16].map(value => <option key={value} value={value}>{value}</option>)}
                        </select>
                    } />
                    <SettingsRow icon={Gauge} label="同时下载文件数" description="与 Bot /file_concurrency 共用；4 需要二次确认。" action={
                        <select className="h-10 rounded-lg border border-border bg-background px-3" value={advancedTasks.telegramFileConcurrency} onChange={event => void updateAdvancedTask({ telegramFileConcurrency: Number(event.target.value) })}>
                            {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}
                        </select>
                    } />
                    <SettingsRow icon={Copy} label="重复文件处理" description="同名、同目录、同大小文件的统一策略。" action={
                        <select className="h-10 rounded-lg border border-border bg-background px-3" value={advancedTasks.duplicateMode} onChange={event => void updateAdvancedTask({ duplicateMode: event.target.value as 'copy' | 'skip' })}>
                            <option value="copy">生成副本</option><option value="skip">跳过重复</option>
                        </select>
                    } />
                    <SettingsRow icon={Copy} label="跳过频道普通图片" description="一般不需要开启。仅适合频道同时发布预览图片和原图文件，而你只想保存原图文件的场景。开启后，订阅和按日期批量下载（以及按标签批量下载）会跳过所有普通图片；频道只发普通图片时会漏图。" action={
                        <Button size="sm" variant={advancedTasks.skipTelegramPhotosInBatch ? 'default' : 'outline'} onClick={() => void updateAdvancedTask({ skipTelegramPhotosInBatch: !advancedTasks.skipTelegramPhotosInBatch })}>
                            {advancedTasks.skipTelegramPhotosInBatch ? '已开启' : '已关闭'}
                        </Button>
                    } />
                    <SettingsRow icon={Trash2} label="自动清理未索引临时文件" description="不删除文件索引或云端实体，只清理超过保护期的本地孤儿文件。" action={
                        <Button size="sm" variant={advancedTasks.autoCleanupOrphans ? 'default' : 'outline'} onClick={() => void updateAdvancedTask({ autoCleanupOrphans: !advancedTasks.autoCleanupOrphans })}>
                            {advancedTasks.autoCleanupOrphans ? '已开启' : '已关闭'}
                        </Button>
                    } />
                </div> : <div className="p-6 text-sm text-muted-foreground">正在加载高级任务设置…</div>}
            </SettingsSection>
            {/* i18n source: 数据维护 */}
            <SettingsSection title={t('settings.maintenance.title')}>
                <SettingsRow
                    icon={Database}
                    label="下载明细记录"
                    description="推荐仅保留错误：适合磁盘空间较小或不需要完整审计的设备。任务运行时仍会临时记录，完成后自动删除成功和跳过明细，只留下失败记录用于排错和重试。磁盘充足且需要逐条核对下载历史时，可选择保留全部。"
                    stackActionOnMobile
                    action={advancedTasks ? (
                        <select
                            value={advancedTasks.telegramDownloadHistoryPolicy}
                            onChange={(event) => void updateAdvancedTask({ telegramDownloadHistoryPolicy: event.target.value as AdvancedTaskSettings['telegramDownloadHistoryPolicy'] }).catch((error: any) => showNotice(errorMessage(error) || '更新下载明细记录失败', '操作失败'))}
                            className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:w-auto sm:min-w-48"
                            aria-label="下载明细记录策略"
                        >
                            <option value="errors_only">仅保留错误（推荐）</option>
                            <option value="all">保留全部（完整审计）</option>
                        </select>
                    ) : <span className="text-sm text-muted-foreground">正在加载…</span>}
                />
                <SettingsRow
                    icon={Trash2}
                    label="清理历史明细"
                    description="手动删除指定天数以前的 Telegram 下载审计明细。只清理记录，不删除文件索引，也不删除云端文件。"
                    stackActionOnMobile
                    action={
                        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:justify-end">
                            <select
                                value={cleanupRetentionDays}
                                onChange={(e) => setCleanupRetentionDays(Number(e.target.value))}
                                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
                                disabled={isCleaningDownloadItems}
                            >
                                <option value={1}>保留 1 天</option>
                                <option value={7}>保留 7 天</option>
                                <option value={30}>保留 30 天</option>
                                <option value={90}>保留 90 天</option>
                            </select>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-10 w-full whitespace-nowrap"
                                onClick={handleCleanupDownloadItems}
                                disabled={isCleaningDownloadItems}
                            >
                                {isCleaningDownloadItems ? "清理中..." : "立即清理"}
                            </Button>
                        </div>
                    }
                />
            </SettingsSection>
            </>}

            {activeSection === 'telegram' && <>
            {/* Telegram Download Section */}
            {/* i18n source: Telegram Bot 连接 */}
            <SettingsSection title={t('settings.telegram.botConnection')}>
                <div className="p-4 space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3">
                            <div className="p-2 rounded-lg bg-muted text-muted-foreground"><KeyRound className="h-4 w-4" /></div>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">Bot 凭证与连接</span>
                                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", telegramBotConfig?.status === 'ready' ? "bg-green-500/10 text-green-600" : telegramBotConfig?.configured ? "bg-amber-500/10 text-amber-700" : "bg-muted text-muted-foreground")}>{telegramBotConfig?.status === 'ready' ? '已连接' : telegramBotConfig?.configured ? '已配置' : '未配置'}</span>
                                    {telegramBotConfig?.source === 'environment' && <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-semibold text-blue-600">环境变量兼容</span>}
                                    {telegramBotConfig?.source === 'web' && <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-600">网页加密管理</span>}
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">配置后只显示状态，不会回显 Bot Token、API ID 或 API Hash。</p>
                                {telegramBotConfig?.configured && <div className="mt-2 text-xs leading-5 text-muted-foreground">
                                    <p>凭证已安全保存</p>
                                    {telegramBotConfig.bot?.username && <p>Bot：@{telegramBotConfig.bot.username}</p>}
                                    {telegramBotConfig.lastConnectedAt && <p>最近连接：{new Date(telegramBotConfig.lastConnectedAt).toLocaleString()}</p>}
                                    {telegramBotConfig.lastError && <p className="text-destructive">最近错误：{telegramBotConfig.lastError}</p>}
                                </div>}
                            </div>
                        </div>
                        <div className="w-full sm:w-auto">
                            {telegramBotConfig?.source === 'environment' && <div className="flex flex-wrap gap-2 sm:justify-end"><Button size="sm" onClick={handleMigrateTelegramBot} disabled={isSavingTelegramBot}>迁移到网页管理</Button>{telegramBotConfig?.configured && <Button size="sm" variant="outline" disabled={isChangingTelegramPin} onClick={() => { if (showTelegramPinForm) handleCancelTelegramPinChange(); else { handleCancelTelegramBotEdit(); clearTelegramPinChangeInputs(); setTelegramPinVerificationMethod(telegramBotConfig.pinConfigured ? 'current_pin' : 'web_password'); setShowTelegramPinForm(true); } }}>{showTelegramPinForm ? (telegramBotConfig.pinConfigured ? '取消修改 PIN' : '取消设置 PIN') : (telegramBotConfig.pinConfigured ? '修改 Bot PIN' : '设置 Bot PIN')}</Button>}</div>}
                            {telegramBotConfig?.source === 'web' && <div className="grid w-full grid-cols-3 gap-1.5 sm:w-auto sm:gap-2">
                                <Button size="sm" variant="outline" className="min-w-0 whitespace-nowrap px-1 text-[11px] sm:px-3 sm:text-xs" disabled={isSavingTelegramBot} onClick={() => { if (showTelegramBotForm) handleCancelTelegramBotEdit(); else { handleCancelTelegramPinChange(); clearTelegramBotInputs(); setShowTelegramBotForm(true); } }}>{showTelegramBotForm ? '取消更换' : '更换凭证'}</Button>
                                <Button size="sm" variant="outline" className="min-w-0 whitespace-nowrap px-1 text-[11px] sm:px-3 sm:text-xs" disabled={isChangingTelegramPin} onClick={() => { if (showTelegramPinForm) handleCancelTelegramPinChange(); else { handleCancelTelegramBotEdit(); clearTelegramPinChangeInputs(); setTelegramPinVerificationMethod(telegramBotConfig.pinConfigured ? 'current_pin' : 'web_password'); setShowTelegramPinForm(true); } }}>{showTelegramPinForm ? (telegramBotConfig.pinConfigured ? '取消修改 PIN' : '取消设置 PIN') : (telegramBotConfig.pinConfigured ? '修改 Bot PIN' : '设置 Bot PIN')}</Button>
                                <Button size="sm" variant="destructive" className="min-w-0 whitespace-nowrap px-1 text-[11px] sm:px-3 sm:text-xs" onClick={handleDeleteTelegramBot} disabled={isSavingTelegramBot}>删除配置</Button>
                            </div>}
                        </div>
                        {telegramBotConfig?.configured && !telegramBotConfig.pinConfigured && <p className="mt-3 rounded-lg border border-amber-300/60 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300">Telegram Bot PIN：未设置。请设置 4 位 PIN，供 Telegram 用户首次身份验证。</p>}
                        {!telegramBotConfig?.pinConfigured && telegramBotConfig?.source === 'environment' && <div className="mt-4 space-y-2"><label className="text-sm font-medium">Telegram Bot PIN（4 位数字）</label><input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="new-password" value={telegramPin} onChange={event => setTelegramPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="迁移前创建 PIN" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" /><p className="text-xs text-muted-foreground">迁移环境变量凭证前必须创建 PIN，且只能是正好 4 位数字。</p></div>}
                    </div>

                    {(!telegramBotConfig?.configured || showTelegramBotForm) && <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-4">
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div className="space-y-2 md:col-span-2"><label className="text-sm font-medium">Bot Token</label><input type="password" autoComplete="new-password" value={telegramBotToken} onChange={event => setTelegramBotToken(event.target.value)} placeholder="从 @BotFather 获取" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" /></div>
                            <div className="space-y-2"><label className="text-sm font-medium">API ID</label><input type="password" inputMode="numeric" autoComplete="new-password" value={telegramApiId} onChange={event => setTelegramApiId(event.target.value)} placeholder="从 my.telegram.org 获取" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" /></div>
                            <div className="space-y-2"><label className="text-sm font-medium">API Hash</label><input type="password" autoComplete="new-password" value={telegramApiHash} onChange={event => setTelegramApiHash(event.target.value)} placeholder="32 位 API Hash" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" /></div>
                            {telegramBotConfig?.pinConfigured && <p className="md:col-span-2 rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-muted-foreground">Telegram Bot PIN：已设置，本次更换不会修改</p>}
                            {!telegramBotConfig?.pinConfigured && <div className="space-y-2 md:col-span-2"><label className="text-sm font-medium">Telegram Bot PIN（4 位数字）</label><input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="new-password" value={telegramPin} onChange={event => setTelegramPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="用于 Bot 首次身份验证" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" /><p className="text-xs text-muted-foreground">PIN 只在首次配置时创建，必须正好是 4 位数字。</p></div>}
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">{telegramBotConfig?.configured && <Button variant="ghost" onClick={handleCancelTelegramBotEdit} disabled={isSavingTelegramBot}>取消</Button>}<Button variant="outline" onClick={handleTestTelegramBot} disabled={isSavingTelegramBot || !telegramBotToken || !telegramApiId || !telegramApiHash}>测试连接</Button><Button onClick={handleSaveTelegramBot} disabled={isSavingTelegramBot || !telegramBotToken || !telegramApiId || !telegramApiHash}>{isSavingTelegramBot ? '处理中...' : '保存并启用'}</Button></div>
                    </div>}

                    {showTelegramPinForm && telegramBotConfig?.configured && <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-4">
                        <div>
                            <h4 className="text-sm font-semibold">{telegramBotConfig.pinConfigured ? '修改 Telegram Bot PIN' : '设置 Telegram Bot PIN'}</h4>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">{telegramBotConfig.pinConfigured ? '请使用当前 PIN 或网页管理员密码验证身份。修改成功后，所有已认证的 Telegram 用户都需要使用新 PIN 重新验证。' : '未设置 PIN 时，需要使用网页管理员密码验证身份。设置后，Telegram 用户可使用该 4 位 PIN 完成首次身份验证。'}</p>
                        </div>
                        {telegramBotConfig.pinConfigured && <div className="space-y-2">
                            <label className="text-sm font-medium">验证方式</label>
                            <div className="grid grid-cols-2 gap-2">
                                <Button type="button" variant={telegramPinVerificationMethod === 'current_pin' ? 'default' : 'outline'} onClick={() => { setTelegramPinVerificationMethod('current_pin'); setTelegramPinVerificationSecret(''); }}>当前 PIN</Button>
                                <Button type="button" variant={telegramPinVerificationMethod === 'web_password' ? 'default' : 'outline'} onClick={() => { setTelegramPinVerificationMethod('web_password'); setTelegramPinVerificationSecret(''); }}>网页管理员密码</Button>
                            </div>
                        </div>}
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div className="space-y-2 md:col-span-2"><label className="text-sm font-medium">{telegramBotConfig.pinConfigured && telegramPinVerificationMethod === 'current_pin' ? '当前 PIN' : '网页管理员密码'}</label><input type="password" inputMode={telegramBotConfig.pinConfigured && telegramPinVerificationMethod === 'current_pin' ? 'numeric' : undefined} maxLength={telegramBotConfig.pinConfigured && telegramPinVerificationMethod === 'current_pin' ? 4 : 256} autoComplete="current-password" value={telegramPinVerificationSecret} onChange={event => setTelegramPinVerificationSecret(telegramBotConfig.pinConfigured && telegramPinVerificationMethod === 'current_pin' ? event.target.value.replace(/\D/g, '').slice(0, 4) : event.target.value)} placeholder={telegramBotConfig.pinConfigured && telegramPinVerificationMethod === 'current_pin' ? '输入当前 4 位 PIN' : '输入网页管理员密码'} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" /></div>
                            <div className="space-y-2"><label className="text-sm font-medium">新 PIN</label><input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="new-password" value={newTelegramPin} onChange={event => setNewTelegramPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="4 位数字" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" /></div>
                            <div className="space-y-2"><label className="text-sm font-medium">确认新 PIN</label><input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="new-password" value={confirmNewTelegramPin} onChange={event => setConfirmNewTelegramPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="再次输入 4 位数字" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" /></div>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={handleCancelTelegramPinChange} disabled={isChangingTelegramPin}>取消</Button><Button onClick={handleChangeTelegramPin} disabled={isChangingTelegramPin || !telegramPinVerificationSecret || newTelegramPin.length !== 4 || confirmNewTelegramPin.length !== 4}>{isChangingTelegramPin ? '处理中...' : (telegramBotConfig.pinConfigured ? '确认修改 PIN' : '确认设置 PIN')}</Button></div>
                    </div>}
                </div>
            </SettingsSection>

            <SettingsSection title={t('settings.telegram.permissions')}>
                <div className="p-4 bg-muted/20 border-b border-border/50">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3">
                            <div className="p-2 rounded-lg bg-muted text-muted-foreground">
                                <ShieldCheck className="h-4 w-4" />
                            </div>
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">允许使用 Bot 的 Telegram 用户</span>
                                    {config?.telegramAllowedUserIdsFromEnv ? (
                                        <span className="px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[11px] font-semibold">由环境变量管理</span>
                                    ) : config?.telegramAllowedUserIds?.length ? (
                                        <span className="px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 text-[11px] font-semibold">已配置 {config.telegramAllowedUserIds.length} 个</span>
                                    ) : (
                                        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[11px] font-semibold">未配置</span>
                                    )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">
                                    输入允许通过 Telegram Bot PIN 登录的 user id，多个用英文逗号、空格或换行分隔。空列表会拒绝所有用户；首次无人认证时，首个正确输入 PIN 的用户会自动加入。
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="p-4 space-y-3">
                    <textarea
                        value={telegramAllowedUserIdsInput}
                        onChange={(event) => setTelegramAllowedUserIdsInput(event.target.value)}
                        disabled={!!config?.telegramAllowedUserIdsFromEnv || isSavingTelegramAllowedUsers}
                        rows={3}
                        placeholder="例如：123456789, 987654321"
                        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:bg-muted/40 disabled:text-muted-foreground"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-xs text-muted-foreground">
                            获取 user id：让用户在 Telegram 私聊 <code className="px-1 py-0.5 rounded bg-muted">@userinfobot</code> 查看 Id。
                            {config?.telegramAllowedUserIdsFromEnv ? ' 当前后端设置了 TELEGRAM_ALLOWED_USER_IDS，请修改 .env 并重启后端。' : ''}
                        </p>
                        <Button
                            size="sm"
                            onClick={handleSaveTelegramAllowedUsers}
                            disabled={!!config?.telegramAllowedUserIdsFromEnv || isSavingTelegramAllowedUsers || !telegramAllowedUserIdsInput.trim()}
                        >
                            {isSavingTelegramAllowedUsers ? '保存中...' : '保存允许列表'}
                        </Button>
                    </div>
                </div>
            </SettingsSection>

            <SettingsSection title={t('settings.telegram.downloadSettings')}>
                <div className="p-4 bg-muted/20 border-b border-border/50">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3">
                            <div className="mt-0.5 shrink-0 p-2 rounded-lg bg-muted text-muted-foreground">
                                <Cloud className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">账号级下载器</span>
                                    {!showTelegramUserDownload ? (
                                        <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[11px] font-medium">未启用</span>
                                    ) : config?.telegramUserSessionReady ? (
                                        <span className="px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 text-[11px] font-semibold">已开启</span>
                                    ) : (
                                        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[11px] font-semibold">session 未就绪</span>
                                    )}
                                </div>
                                <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">开启后，文件下载由已启用的 Telegram 用户账号按权限、健康状态和负载智能调度</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant={showTelegramUserDownload ? "default" : "outline"}
                            className="w-full whitespace-normal sm:w-auto sm:shrink-0 sm:whitespace-nowrap"
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
                                    await showNotice(errorMessage(error) || '更新 Telegram 下载设置失败', '保存失败');
                                } finally {
                                    setIsSaving(false);
                                }
                            }}
                        >
                            {showTelegramUserDownload ? "停用账号级下载" : "启用账号级下载"}
                        </Button>
                    </div>
                </div>

                <TelegramUserAccountsPanel
                    configured={!!telegramBotConfig?.configured}
                    onNotice={showNotice}
                    requestConfirmation={requestConfirmation}
                />
            </SettingsSection>
            </>}

            {activeSection === 'storage' && <>
            {/* Storage Configuration Section (New) */}
            {/* i18n source: 存储源设置 */}
            <SettingsSection title={t('settings.storageSources.title')}>
                <div className="mx-4 mt-3 mb-4 p-3 rounded-lg border border-blue-500/20 bg-blue-500/5 flex items-center gap-3">
                    <BookOpen className="h-4 w-4 text-blue-500 flex-shrink-0" />
                    <p className="text-xs text-muted-foreground">
                        首次配置？请参阅{" "}
                        <a
                            href="https://hicocos.github.io/tg-vault/storage.html"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-500 hover:text-blue-600 font-medium hover:underline"
                        >
                            存储源配置指南
                            <ExternalLink className="h-3 w-3" />
                        </a>
                        {" "}查看详细教程。
                    </p>
                </div>
                <div className="border-b border-border/50">
                    <SettingsRow
                        icon={Database}
                        label="本地存储 (Local)"
                        description="文件存储在服务器本地磁盘。适合常规使用，速度最快。"
                        value={config?.provider === 'local' ? "正在使用" : ""}
                        action={
                            config?.provider === 'local' ? (
                                <CheckCircle className="h-5 w-5 text-green-500" />
                            ) : (
                                <Button
                                    size="sm" variant="outline"
                                    onClick={() => handleSwitchProvider('local')}
                                    disabled={isSaving || !config}
                                >
                                    切换使用
                                </Button>
                            )
                        }
                    />
                </div>

                <div className="p-4 bg-muted/20 border-b border-border/50">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-muted text-muted-foreground">
                                <Database className="h-4 w-4" />
                            </div>
                            <div>
                                <span className="text-sm font-medium">Google Drive 账户</span>
                                <p className="text-xs text-muted-foreground">管理及切换多个 Google Drive 账户</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowGDForm(!showGDForm)}
                        >
                            {showGDForm ? "取消添加" : "添加新账户"}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        {config?.accounts.filter(a => a.type === 'google_drive').map((account) => (
                            <div
                                key={account.id}
                                className={cn(
                                    "flex flex-col items-stretch gap-3 p-3 rounded-lg border transition-all sm:flex-row sm:items-center sm:justify-between",
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
                                        <p className="text-sm font-medium">{account.name || "未命名账户"}</p>
                                        <p className="break-all text-[10px] text-muted-foreground font-mono opacity-60">{account.id}</p>
                                        <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
                                    {account.is_active ? (
                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 text-green-600 dark:text-green-400">
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            <span className="text-xs font-semibold">正在使用</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 text-xs hover:bg-primary/10 hover:text-primary"
                                                onClick={() => handleSwitchProvider('google_drive', account.id)}
                                                disabled={isSaving}
                                            >
                                                切换到此账户
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
                            <div className="text-center py-6 border border-dashed rounded-lg border-border/50">
                                <p className="text-xs text-muted-foreground">尚未配置 Google Drive 账户</p>
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1"
                                    onClick={() => setShowGDForm(true)}
                                >
                                    立即添加
                                </Button>
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
                            <div className="p-6 space-y-6">
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                                        <Database className="h-4 w-4" />
                                        <span>Google Drive API 凭证</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        前往 <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Google Cloud Console</a> 创建 <b>OAuth 2.0 客户端 ID</b>。
                                        应用类型选择 <code>Web 应用程序</code>，并添加以下<b>已授权的重定向 URI</b>：
                                        <code className="block mt-1 p-1 bg-muted rounded text-primary">{config?.googleDriveRedirectUri || `${window.location.origin}/api/storage/google-drive/callback`}</code>
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium">账户名称 (显示名称)</label>
                                        <input
                                            type="text"
                                            value={gdAccountName}
                                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGdAccountName(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="例如: 我的 Google Drive"
                                        />
                                    </div>
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium">客户端 ID (Client ID)</label>
                                        <input
                                            type="text"
                                            value={gdClientId}
                                            onChange={e => setGdClientId(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="Google Cloud Client ID"
                                        />
                                    </div>
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium">客户端密钥 (Client Secret)</label>
                                        <input
                                            type="password"
                                            value={gdClientSecret}
                                            onChange={e => setGdClientSecret(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="Google Cloud Client Secret"
                                        />
                                    </div>
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium">共享云端硬盘 ID / 团队盘 ID（可选）</label>
                                        <input
                                            type="text"
                                            value={gdSharedDriveId}
                                            onChange={e => setGdSharedDriveId(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="例如: 0Axxxxxxxxxxxxxxxxx"
                                        />
                                        <p className="text-xs text-muted-foreground leading-relaxed">
                                            留空则使用“我的云端硬盘”。如需上传到共享云端硬盘，请填写 URL 中 <code>folders/</code> 后面的共享盘 ID；授权账号必须已加入该共享盘并具备创建文件权限。
                                        </p>
                                    </div>
                                </div>

                                <div className="p-4 rounded-xl border border-blue-500/20 bg-blue-500/5 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <h4 className="text-sm font-medium text-blue-600 dark:text-blue-400">开始授权</h4>
                                            <p className="text-xs text-muted-foreground">点击按钮前往 Google 页面完成授权。</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveGDConfig}
                                            disabled={isSaving || !gdClientId || !gdClientSecret}
                                            className="bg-blue-600 hover:bg-blue-700 text-white"
                                        >
                                            {isSaving ? "发起中..." : "保存并授权"}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowGDForm(false)}>关闭</Button>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                <div className="p-4 bg-muted/20 border-b border-border/50">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-muted text-muted-foreground">
                                <Cloud className="h-4 w-4" />
                            </div>
                            <div>
                                <span className="text-sm font-medium">Microsoft OneDrive 账户</span>
                                <p className="text-xs text-muted-foreground">管理及切换多个 OneDrive 账户</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowOneDriveForm(!showOneDriveForm)}
                        >
                            {showOneDriveForm ? "取消添加" : "添加新账户"}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        {config?.accounts.filter(a => a.type === 'onedrive').map((account) => (
                            <div
                                key={account.id}
                                className={cn(
                                    "flex flex-col items-stretch gap-3 p-3 rounded-lg border transition-all sm:flex-row sm:items-center sm:justify-between",
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
                                        <p className="text-sm font-medium">{account.name || "未命名账户"}</p>
                                        <p className="break-all text-[10px] text-muted-foreground font-mono opacity-60">{account.id}</p>
                                        <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
                                    {account.is_active ? (
                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 text-green-600 dark:text-green-400">
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            <span className="text-xs font-semibold">正在使用</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 text-xs hover:bg-primary/10 hover:text-primary"
                                                onClick={() => handleSwitchProvider('onedrive', account.id)}
                                                disabled={isSaving}
                                            >
                                                切换到此账户
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
                            <div className="text-center py-6 border border-dashed rounded-lg border-border/50">
                                <p className="text-xs text-muted-foreground">尚未配置 OneDrive 账户</p>
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1"
                                    onClick={() => setShowOneDriveForm(true)}
                                >
                                    立即添加
                                </Button>
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
                            <div className="p-6 space-y-6">
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                                        <Database className="h-4 w-4" />
                                        <span>Entra ID (Azure) 应用信息</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        前往 <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Microsoft Entra ID 控制台</a> 并登录。授权账号可与最终存储账号不同。
                                        注册应用时，<b>重定向 URI</b> 请选择 <code>Web</code>，并填写：
                                        <code className="block mt-1 p-1 bg-muted rounded text-primary">{config?.redirectUri || `${import.meta.env.VITE_API_URL || window.location.origin}/api/storage/onedrive/callback`}</code>
                                    </p>
                                    <p className="text-xs text-amber-600 dark:text-amber-400 leading-relaxed rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                                        如果填写客户端密码，请复制 Azure「证书和密码」里新建密码后的<b>值 Value</b>；不要复制“机密 ID/Secret ID”。复制错会导致 Microsoft 返回 <code>AADSTS7000215 Invalid client secret</code>。
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">应用程序 (客户端) ID</label>
                                        <input
                                            type="text"
                                            value={odClientId}
                                            onChange={e => setOdClientId(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="Azure App Client ID"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">租户 ID (Tenant ID)</label>
                                        <input
                                            type="text"
                                            value={odTenantId}
                                            onChange={e => setOdTenantId(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="默认为 common"
                                        />
                                    </div>
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium">账户名称 (可选)</label>
                                        <input
                                            type="text"
                                            value={odAccountName}
                                            onChange={e => setOdAccountName(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="自定义显示名称，例如：个人网盘"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">客户端密码 (Client Secret - 可选)</label>
                                    <input
                                        type="password"
                                        value={odClientSecret}
                                        onChange={e => setOdClientSecret(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                        placeholder="公共客户端模式可不填"
                                    />
                                </div>

                                <div className="p-4 rounded-xl border border-blue-500/20 bg-blue-500/5 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <h4 className="text-sm font-medium text-blue-600 dark:text-blue-400">开始授权新账户</h4>
                                            <p className="text-xs text-muted-foreground">点击下方按钮前往微软页面完成授权，系统将自动识别并添加该账户。</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveOneDriveConfig}
                                            disabled={isSaving || !odClientId}
                                            className="bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20"
                                        >
                                            {isSaving ? "发起中..." : "保存并授权"}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowOneDriveForm(false)}>关闭</Button>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </SettingsSection>

            {/* Aliyun OSS Configuration Section */}
            <SettingsSection title={t('settings.storageSources.aliyunTitle')}>
                <div className="p-4 bg-muted/20 border-b border-border/50">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-muted text-muted-foreground">
                                <Database className="h-4 w-4" />
                            </div>
                            <div>
                                <span className="text-sm font-medium">Aliyun OSS 账户</span>
                                <p className="text-xs text-muted-foreground">管理及切换多个阿里云 OSS 存储源</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowOSSForm(!showOSSForm)}
                        >
                            {showOSSForm ? "取消添加" : "添加新账户"}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        {config?.accounts.filter(a => a.type === 'aliyun_oss').map((account) => (
                            <div
                                key={account.id}
                                className={cn(
                                    "flex flex-col items-stretch gap-3 p-3 rounded-lg border transition-all sm:flex-row sm:items-center sm:justify-between",
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
                                        <p className="text-sm font-medium">{account.name || "未命名账户"}</p>
                                        <p className="break-all text-[10px] text-muted-foreground font-mono opacity-60">{account.id}</p>
                                        <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
                                    {account.is_active ? (
                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 text-green-600 dark:text-green-400">
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            <span className="text-xs font-semibold">正在使用</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 text-xs hover:bg-primary/10 hover:text-primary"
                                                onClick={() => handleSwitchProvider('aliyun_oss', account.id)}
                                                disabled={isSaving}
                                            >
                                                切换到此账户
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
                            <div className="text-center py-6 border border-dashed rounded-lg border-border/50">
                                <p className="text-xs text-muted-foreground">尚未配置 Aliyun OSS 账户</p>
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1"
                                    onClick={() => setShowOSSForm(true)}
                                >
                                    立即添加
                                </Button>
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
                            <div className="p-6 space-y-6">
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                                        <Database className="h-4 w-4" />
                                        <span>阿里云 OSS 凭证信息</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        请提供您的阿里云 OSS 访问凭证。建议使用具有最小权限的 RAM 用户。
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium">账户显示名称</label>
                                        <input
                                            type="text"
                                            value={ossAccountName}
                                            onChange={e => setOssAccountName(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="例如：我的备份 OSS"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">区域 (Region)</label>
                                        <input
                                            type="text"
                                            value={ossRegion}
                                            onChange={e => setOssRegion(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="oss-cn-hangzhou"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">存储空间 (Bucket)</label>
                                        <input
                                            type="text"
                                            value={ossBucket}
                                            onChange={e => setOssBucket(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="my-oss-bucket"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">AccessKey ID</label>
                                        <input
                                            type="text"
                                            value={ossAccessKeyId}
                                            onChange={e => setOssAccessKeyId(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">AccessKey Secret</label>
                                        <input
                                            type="password"
                                            value={ossAccessKeySecret}
                                            onChange={e => setOssAccessKeySecret(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                        />
                                    </div>
                                </div>

                                <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <h4 className="text-sm font-medium text-primary">保存配置</h4>
                                            <p className="text-xs text-muted-foreground">保存后系统将尝试连接此 OSS 账户。</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveOSSConfig}
                                            disabled={isSaving || !ossAccessKeyId}
                                        >
                                            {isSaving ? "正在保存..." : "保存账户"}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowOSSForm(false)}>关闭</Button>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </SettingsSection>

            {/* S3 Configuration Section */}
            <SettingsSection title={t('settings.storageSources.s3Title')}>
                <div className="p-4 bg-muted/20 border-b border-border/50">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-muted text-muted-foreground">
                                <Database className="h-4 w-4" />
                            </div>
                            <div>
                                <span className="text-sm font-medium">S3 兼容存储账户</span>
                                <p className="text-xs text-muted-foreground">管理及切换多个 S3 (MinIO, Cloudflare R2, AWS S3 等) 存储源</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowS3Form(!showS3Form)}
                        >
                            {showS3Form ? "取消添加" : "添加新账户"}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        {config?.accounts.filter(a => a.type === 's3').map((account) => (
                            <div
                                key={account.id}
                                className={cn(
                                    "flex flex-col items-stretch gap-3 p-3 rounded-lg border transition-all sm:flex-row sm:items-center sm:justify-between",
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
                                        <p className="text-sm font-medium">{account.name || "未命名账户"}</p>
                                        <p className="break-all text-[10px] text-muted-foreground font-mono opacity-60">{account.id}</p>
                                        <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
                                    {account.is_active ? (
                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 text-green-600 dark:text-green-400">
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            <span className="text-xs font-semibold">正在使用</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 text-xs hover:bg-primary/10 hover:text-primary"
                                                onClick={() => handleSwitchProvider('s3', account.id)}
                                                disabled={isSaving}
                                            >
                                                切换到此账户
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
                            <div className="text-center py-6 border border-dashed rounded-lg border-border/50">
                                <p className="text-xs text-muted-foreground">尚未配置 S3 兼容存储账户</p>
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1"
                                    onClick={() => setShowS3Form(true)}
                                >
                                    立即添加
                                </Button>
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
                            <div className="p-6 space-y-6">
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                                        <Database className="h-4 w-4" />
                                        <span>S3 兼容存储凭证信息</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        支持 MinIO, Cloudflare R2, AWS S3 等。请确保已开启跨域访问 (CORS)。
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium">账户显示名称</label>
                                        <input
                                            type="text"
                                            value={s3AccountName}
                                            onChange={e => setS3AccountName(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="例如：我的 MinIO 存储"
                                        />
                                    </div>
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium">节点地址 (Endpoint)</label>
                                        <input
                                            type="text"
                                            value={s3Endpoint}
                                            onChange={e => setS3Endpoint(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="https://s3.amazonaws.com"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">区域 (Region)</label>
                                        <input
                                            type="text"
                                            value={s3Region}
                                            onChange={e => setS3Region(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="us-east-1"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">存储空间 (Bucket)</label>
                                        <input
                                            type="text"
                                            value={s3Bucket}
                                            onChange={e => setS3Bucket(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="my-s3-bucket"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">AccessKey ID</label>
                                        <input
                                            type="text"
                                            value={s3AccessKeyId}
                                            onChange={e => setS3AccessKeyId(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">AccessKey Secret</label>
                                        <input
                                            type="password"
                                            value={s3AccessKeySecret}
                                            onChange={e => setS3AccessKeySecret(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                        />
                                    </div>
                                    <div className="flex items-center gap-2 pt-2 md:col-span-2">
                                        <input
                                            type="checkbox"
                                            id="forcePathStyle"
                                            checked={s3ForcePathStyle}
                                            onChange={e => setS3ForcePathStyle(e.target.checked)}
                                            className="rounded border-border"
                                        />
                                        <label htmlFor="forcePathStyle" className="text-xs text-muted-foreground">
                                            强制路径风格 (Force Path Style) - MinIO 或私有化部署建议勾选
                                        </label>
                                    </div>
                                </div>

                                <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <h4 className="text-sm font-medium text-primary">保存配置</h4>
                                            <p className="text-xs text-muted-foreground">保存后系统将尝试连接此 S3 账户。</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveS3Config}
                                            disabled={isSaving || !s3AccessKeyId}
                                        >
                                            {isSaving ? "正在保存..." : "保存账户"}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowS3Form(false)}>关闭</Button>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </SettingsSection>

            {/* WebDAV Configuration Section */}
            <SettingsSection title={t('settings.storageSources.webdavTitle')}>
                <div className="p-4 bg-muted/20 border-b border-border/50">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-muted text-muted-foreground">
                                <Network className="h-4 w-4" />
                            </div>
                            <div>
                                <span className="text-sm font-medium">WebDAV 存储账户</span>
                                <p className="text-xs text-muted-foreground">管理及切换多个 WebDAV (坚果云, InfiniCLOUD, Synology 等) 存储源</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowWebDAVForm(!showWebDAVForm)}
                        >
                            {showWebDAVForm ? "取消添加" : "添加新账户"}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        {config?.accounts.filter(a => a.type === 'webdav').map((account) => (
                            <div
                                key={account.id}
                                className={cn(
                                    "flex flex-col items-stretch gap-3 p-3 rounded-lg border transition-all sm:flex-row sm:items-center sm:justify-between",
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
                                        <p className="text-sm font-medium">{account.name || "未命名账户"}</p>
                                        <p className="break-all text-[10px] text-muted-foreground font-mono opacity-60">{account.id}</p>
                                        <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2 self-stretch sm:self-auto">
                                    {account.is_active ? (
                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 text-green-600 dark:text-green-400">
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            <span className="text-xs font-semibold">正在使用</span>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 text-xs hover:bg-primary/10 hover:text-primary"
                                                onClick={() => handleSwitchProvider('webdav', account.id)}
                                                disabled={isSaving}
                                            >
                                                切换到此账户
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
                            <div className="text-center py-6 border border-dashed rounded-lg border-border/50">
                                <p className="text-xs text-muted-foreground">尚未配置 WebDAV 存储账户</p>
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1"
                                    onClick={() => setShowWebDAVForm(true)}
                                >
                                    立即添加
                                </Button>
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
                            <div className="p-6 space-y-6">
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                                        <Network className="h-4 w-4" />
                                        <span>WebDAV 凭证信息</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        请提供您的 WebDAV 服务器地址及登录凭证。
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium">账户显示名称</label>
                                        <input
                                            type="text"
                                            value={webdavAccountName}
                                            onChange={e => setWebdavAccountName(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="例如：我的坚果云"
                                        />
                                    </div>
                                    <div className="space-y-2 md:col-span-2">
                                        <label className="text-sm font-medium">服务器 URL</label>
                                        <input
                                            type="text"
                                            value={webdavUrl}
                                            onChange={e => setWebdavUrl(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="https://dav.jianguoyun.com/dav/"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">用户名 (可选)</label>
                                        <input
                                            type="text"
                                            value={webdavUsername}
                                            onChange={e => setWebdavUsername(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="WebDAV 用户名"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">密码 / 应用口令 (可选)</label>
                                        <input
                                            type="password"
                                            value={webdavPassword}
                                            onChange={e => setWebdavPassword(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                                            placeholder="WebDAV 密码"
                                        />
                                    </div>
                                </div>

                                <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <h4 className="text-sm font-medium text-primary">保存配置</h4>
                                            <p className="text-xs text-muted-foreground">保存后系统将尝试连接此 WebDAV 账户。</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveWebDAVConfig}
                                            disabled={isSaving || !webdavUrl}
                                        >
                                            {isSaving ? "正在保存..." : "保存账户"}
                                        </Button>
                                    </div>
                                </div>

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowWebDAVForm(false)}>关闭</Button>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </SettingsSection>

            {/* OpenList native storage: connection and account switching only. */}
            <SettingsSection title={t('settings.openlist.title')}>
                <div className="border-b border-border/50 bg-muted/20 p-4">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <div className="rounded-lg bg-muted p-2 text-muted-foreground"><Server className="h-4 w-4" /></div>
                            <div>
                                <span className="text-sm font-medium">{t('settings.openlist.accounts')}</span>
                                <p className="text-xs text-muted-foreground">{t('settings.openlist.description')}</p>
                            </div>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => setShowOpenListForm(!showOpenListForm)}>
                            {showOpenListForm ? t('settings.openlist.cancelAdd') : t('settings.openlist.addAccount')}
                        </Button>
                    </div>
                    <div className="space-y-2">
                        {config?.accounts.filter(account => account.type === 'openlist').map(account => (
                            <div key={account.id} className={cn("flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between", account.is_active ? "border-primary/20 bg-primary/5" : "border-border bg-background")}>
                                <div className="min-w-0">
                                    <p className="text-sm font-medium">{account.name || t('settings.openlist.unnamed')}</p>
                                    <p className="break-all font-mono text-[10px] text-muted-foreground opacity-60">{account.id}</p>
                                    <StorageProbeStatus account={account} busy={probingAccountId === account.id} feedback={probeFeedback?.accountId === account.id ? probeFeedback : null} onProbe={() => void handleProbeAccount(account)} />
                                </div>
                                <div className="flex items-center justify-end gap-2">
                                    {account.is_active ? <span className="rounded bg-green-500/10 px-2 py-1 text-xs font-semibold text-green-600">{t('settings.openlist.inUse')}</span> : <>
                                        <Button size="sm" variant="ghost" onClick={() => handleSwitchProvider('openlist', account.id)} disabled={isSaving}>{t('settings.openlist.switchAccount')}</Button>
                                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => handleDeleteAccount(account.id, account.name)} disabled={isSaving} title={t('settings.openlist.deleteTitle')}><Trash2 className="h-3.5 w-3.5" /></Button>
                                    </>}
                                </div>
                            </div>
                        ))}
                        {config?.accounts.filter(account => account.type === 'openlist').length === 0 && !showOpenListForm && <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">{t('settings.openlist.empty')}</p>}
                    </div>
                </div>
                <AnimatePresence>
                    {showOpenListForm && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="border-t border-border/50 bg-muted/30">
                        <div className="space-y-5 p-6">
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                <div className="space-y-2 md:col-span-2"><label className="text-sm font-medium">{t('settings.openlist.accountName')}</label><input value={openlistAccountName} onChange={event => setOpenlistAccountName(event.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder={t('settings.openlist.accountPlaceholder')} /></div>
                                <div className="space-y-2 md:col-span-2"><label className="text-sm font-medium">{t('settings.openlist.address')}</label><input type="url" value={openlistBaseUrl} onChange={event => setOpenlistBaseUrl(event.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="https://openlist.example.com" /></div>
                                <div className="space-y-2 md:col-span-2"><label className="text-sm font-medium">{t('settings.openlist.rootPath')}</label><input value={openlistRootPath} onChange={event => setOpenlistRootPath(event.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="/" /><p className="text-xs text-muted-foreground">{t('settings.openlist.rootHint')}</p></div>
                                <div className="space-y-2"><label className="text-sm font-medium">{t('settings.openlist.username')}</label><input autoComplete="username" value={openlistUsername} onChange={event => setOpenlistUsername(event.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></div>
                                <div className="space-y-2"><label className="text-sm font-medium">{t('settings.openlist.password')}</label><input type="password" autoComplete="new-password" value={openlistPassword} onChange={event => setOpenlistPassword(event.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></div>
                            </div>
                            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => { setShowOpenListForm(false); setOpenlistPassword(''); }}>{t('settings.openlist.cancel')}</Button><Button onClick={handleSaveOpenListConfig} disabled={isSaving || !openlistBaseUrl || !openlistUsername || !openlistPassword}>{isSaving ? t('settings.openlist.saving') : t('settings.openlist.save')}</Button></div>
                        </div>
                    </motion.div>}
                </AnimatePresence>
            </SettingsSection>
            <SettingsSection title={t("settings.storage.title")}>
                <div className="p-6 space-y-6">
                    {storageStats ? (
                        <>
                            {/* 服务器存储 */}
                            <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                                            <Server className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-medium">服务器存储</p>
                                            <div className="flex items-baseline gap-1">
                                                <span className="text-2xl font-bold tracking-tight">{storageStats.server.used}</span>
                                                <span className="text-sm text-muted-foreground font-medium">/ {storageStats.server.total}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm text-muted-foreground">可用空间</span>
                                            <span className="text-sm font-medium text-green-600">{storageStats.server.free}</span>
                                        </div>
                                        <span className={cn(
                                            "text-lg font-semibold",
                                            storageStats.server.usedPercent > 90 ? "text-red-500" :
                                                storageStats.server.usedPercent > 70 ? "text-yellow-500" : "text-green-500"
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
                                        <div className="h-10 w-10 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-500">
                                            <Cloud className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-medium">TG Vault 存储</p>
                                            <div className="flex items-baseline gap-1">
                                                <span className="text-2xl font-bold tracking-tight">{storageStats.tgvault.used}</span>
                                                <span className="text-sm text-muted-foreground font-medium">
                                                    ({t('storage.fileCount', { count: storageStats.tgvault.fileCount })})
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
                                <p className="text-sm">加载存储信息中...</p>
                            </div>
                        </div>
                    )}
                </div>
            </SettingsSection>
            </>}

        </motion.div>
    );
};
