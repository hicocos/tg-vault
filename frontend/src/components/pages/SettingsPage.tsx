import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { HardDrive, ChevronRight, Moon, Sun, Monitor, Palette, Globe, Cloud, Server, Database, CheckCircle, Trash2, Network, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "../ui/Button";
import { LanguageToggle } from "../ui/LanguageToggle";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { fileApi, type StorageStats } from "../../services/api";
import { authService } from "../../services/auth";

interface SettingsPageProps {
    storageStats?: StorageStats | null;
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
}

const SettingsRow = ({ icon: Icon, label, value, action, onClick, description }: SettingsRowProps) => (
    <div
        className={cn(
            "flex items-center justify-between p-4 border-b border-border/50 last:border-0 transition-colors",
            onClick ? "cursor-pointer hover:bg-muted/30" : ""
        )}
        onClick={onClick}
    >
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-muted text-muted-foreground">
                    <Icon className="h-4 w-4" />
                </div>
                <span className="text-sm font-medium">{label}</span>
            </div>
            {description && <p className="text-xs text-muted-foreground pl-9">{description}</p>}
        </div>
        <div className="flex items-center gap-3">
            {value && <span className="text-sm text-muted-foreground">{value}</span>}
            {action && <div>{action}</div>}
            {!action && onClick && <ChevronRight className="h-4 w-4 text-muted-foreground/50" />}
        </div>
    </div>
);

export const SettingsPage = ({ storageStats }: SettingsPageProps) => {
    const { t } = useTranslation();
    const { theme, setTheme } = useTheme();

    // Storage Configuration State
    const [config, setConfig] = useState<{
        provider: string;
        activeAccountId: string | null;
        accounts: any[];
        redirectUri: string;
        googleDriveRedirectUri?: string;
    } | null>(null);
    const [isSaving, setIsSaving] = useState(false);
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

    // Google Drive Form State
    const [gdClientId, setGdClientId] = useState("");
    const [gdClientSecret, setGdClientSecret] = useState("");
    const [showGDForm, setShowGDForm] = useState(false);

    // 2FA State
    const [twoFAQrCode, setTwoFAQrCode] = useState<string | null>(null);
    const [show2FA, setShow2FA] = useState(false);
    const [isLoading2FA, setIsLoading2FA] = useState(false);
    const [twoFAError, setTwoFAError] = useState<string | null>(null);
    const [is2FAActivated, setIs2FAActivated] = useState(false);
    const [activationCode, setActivationCode] = useState("");
    const [isActivating2FA, setIsActivating2FA] = useState(false);

    // Load initial config
    useEffect(() => {
        const loadConfig = async () => {
            try {
                const data = await fileApi.getStorageConfig();
                setConfig(data);
            } catch (error) {
                console.error("Failed to load storage config:", error);
            }
        };
        loadConfig();
    }, []);

    const handleSwitchProvider = async (provider: 'local' | 'onedrive' | 'aliyun_oss' | 's3' | 'webdav' | 'google_drive', accountId?: string) => {
        if (isSaving) return;

        // If switching to the same account/provider, do nothing
        if (provider === 'local' && config?.provider === 'local') return;
        if (provider === 'onedrive' && accountId === config?.activeAccountId) return;
        if (provider === 'aliyun_oss' && accountId === config?.activeAccountId) return;
        if (provider === 's3' && accountId === config?.activeAccountId) return;
        if (provider === 'webdav' && accountId === config?.activeAccountId) return;
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
            'google_drive': 'Google Drive'
        };
        const providerName = providerNames[provider];

        if (!window.confirm(`确定要切换存储源到 ${providerName}${accountId ? ' (指定账户)' : ''} 吗？`)) return;

        setIsSaving(true);
        try {
            await fileApi.switchStorageProvider(provider as any, accountId);
            const data = await fileApi.getStorageConfig();
            setConfig(data);
            alert(`已成功切换到 ${providerName}`);
            window.location.reload();
        } catch (error: any) {
            alert(error.message);
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveGDConfig = async () => {
        if (!gdClientId || !gdClientSecret) {
            alert("请填写 Client ID 和 Client Secret");
            return;
        }
        setIsSaving(true);
        try {
            const redirectUri = config?.googleDriveRedirectUri || config?.redirectUri?.replace('onedrive', 'google-drive') || `${window.location.origin}/api/storage/google-drive/callback`;
            const { authUrl } = await fileApi.getGoogleDriveAuthUrl(gdClientId, gdClientSecret, redirectUri);

            const width = 600;
            const height = 700;
            const left = window.screenX + (window.innerWidth - width) / 2;
            const top = window.screenY + (window.innerHeight - height) / 2;

            window.open(authUrl, 'GoogleDriveAuth', `width=${width},height=${height},left=${left},top=${top},status=yes,toolbar=no,menubar=no`);

            const messageHandler = async (event: MessageEvent) => {
                if (event.data === 'google_drive_auth_success') {
                    const newData = await fileApi.getStorageConfig();
                    setConfig(newData);
                    alert("Google Drive 授权成功并已启用！");
                    setShowGDForm(false);
                    window.removeEventListener('message', messageHandler);
                }
            };
            window.addEventListener('message', messageHandler);
        } catch (error: any) {
            alert("发起授权失败: " + error.message);
        } finally {
            setIsSaving(false);
        }
    };

    const handleDeleteAccount = async (accountId: string, accountName: string) => {
        if (!window.confirm(`确定要删除账户 "${accountName}" 吗？\n\n该账户中已上传的文件记录会保留，但将不再关联到任何账户。`)) return;
        try {
            const result = await fileApi.deleteAccount(accountId);
            alert(result.message);
            const data = await fileApi.getStorageConfig();
            setConfig(data);
        } catch (error: any) {
            alert(error.message);
        }
    };

    const handleSaveOneDriveConfig = async () => {
        if (!odClientId) {
            alert("请填写 Client ID");
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.updateOneDriveConfig(odClientId, odClientSecret, 'pending', odTenantId || 'common', odAccountName);
            const redirectUri = config?.redirectUri || `${(window as any)._env_?.VITE_API_URL || import.meta.env.VITE_API_URL || window.location.origin}/api/storage/onedrive/callback`;
            const { authUrl } = await fileApi.getOneDriveAuthUrl(odClientId, odTenantId || 'common', redirectUri, odClientSecret);

            const width = 600;
            const height = 700;
            const left = window.screenX + (window.innerWidth - width) / 2;
            const top = window.screenY + (window.innerHeight - height) / 2;

            window.open(authUrl, 'OneDriveAuth', `width=${width},height=${height},left=${left},top=${top},status=yes,toolbar=no,menubar=no`);

            const messageHandler = async (event: MessageEvent) => {
                if (event.data === 'onedrive_auth_success') {
                    const newData = await fileApi.getStorageConfig();
                    setConfig(newData);
                    alert("OneDrive 授权成功并已启用！");
                    window.removeEventListener('message', messageHandler);
                }
            };
            window.addEventListener('message', messageHandler);
        } catch (error: any) {
            alert("发起授权失败: " + error.message);
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveOSSConfig = async () => {
        if (!ossAccountName || !ossRegion || !ossAccessKeyId || !ossAccessKeySecret || !ossBucket) {
            alert("请填写所有必填项");
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.addAliyunOSSAccount(ossAccountName, ossRegion, ossAccessKeyId, ossAccessKeySecret, ossBucket);
            const data = await fileApi.getStorageConfig();
            setConfig(data);
            alert("阿里云 OSS 账户添加成功！");
            setShowOSSForm(false);
        } catch (error: any) {
            alert("添加阿里云 OSS 账户失败: " + error.message);
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveS3Config = async () => {
        if (!s3AccountName || !s3Endpoint || !s3Region || !s3AccessKeyId || !s3AccessKeySecret || !s3Bucket) {
            alert("请填写所有必填项");
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.addS3Account(s3AccountName, s3Endpoint, s3Region, s3AccessKeyId, s3AccessKeySecret, s3Bucket, s3ForcePathStyle);
            const data = await fileApi.getStorageConfig();
            setConfig(data);
            alert("S3 兼容存储账户添加成功！");
            setShowS3Form(false);
        } catch (error: any) {
            alert("添加 S3 兼容存储账户失败: " + error.message);
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveWebDAVConfig = async () => {
        if (!webdavAccountName || !webdavUrl) {
            alert("请填写账户名称和 URL");
            return;
        }
        setIsSaving(true);
        try {
            await fileApi.addWebDAVAccount(webdavAccountName, webdavUrl, webdavUsername, webdavPassword);
            const data = await fileApi.getStorageConfig();
            setConfig(data);
            alert("WebDAV 存储账户添加成功！");
            setShowWebDAVForm(false);
        } catch (error: any) {
            alert("添加 WebDAV 存储账户失败: " + error.message);
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
        } catch (error: any) {
            setTwoFAError(error.message);
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
        } catch (error: any) {
            setTwoFAError(error.message);
        } finally {
            setIsActivating2FA(false);
        }
    };

    const handleDisable2FA = async () => {
        const password = window.prompt("为了安全，请确认您的管理员密码以禁用 2FA：");
        if (!password) return;

        setIsLoading2FA(true);
        try {
            const result = await authService.disable2FA(password);
            if (result.success) {
                setIs2FAActivated(false);
                setShow2FA(false);
            } else {
                alert(result.error || "禁用失败");
            }
        } catch (error: any) {
            alert(error.message);
        } finally {
            setIsLoading2FA(false);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-3xl mx-auto space-y-8 pb-10 mt-6"
        >
            <div className="flex items-center gap-4 mb-2">
                <div className="p-3 bg-secondary rounded-xl">
                    <Palette className="h-6 w-6 text-foreground" />
                </div>
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">{t("settings.title")}</h2>
                    <p className="text-muted-foreground">Customize your experience & system settings.</p>
                </div>
            </div>

            {/* General Section: Language & Theme */}
            <SettingsSection title={t("settings.general.title")}>
                <SettingsRow
                    icon={Globe}
                    label={t("settings.general.language")}
                    action={<LanguageToggle />}
                />
                <SettingsRow
                    icon={Sun}
                    label={t("settings.general.theme")}
                    action={
                        <div className="flex items-center gap-1 bg-muted/60 p-1 rounded-lg border border-border/30">
                            <Button
                                size="icon"
                                variant="ghost"
                                className={cn("h-7 w-7 transition-all", theme === "light" && "bg-background shadow-sm text-primary")}
                                onClick={() => setTheme("light")}
                                title={t("settings.general.themeLight")}
                            >
                                <Sun className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                                size="icon"
                                variant="ghost"
                                className={cn("h-7 w-7 transition-all", theme === "dark" && "bg-background shadow-sm text-primary")}
                                onClick={() => setTheme("dark")}
                                title={t("settings.general.themeDark")}
                            >
                                <Moon className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                                size="icon"
                                variant="ghost"
                                className={cn("h-7 w-7 transition-all", theme === "system" && "bg-background shadow-sm text-primary")}
                                onClick={() => setTheme("system")}
                                title={t("settings.general.themeSystem")}
                            >
                                <Monitor className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    }
                />
            </SettingsSection>

            {/* Security Section */}
            <SettingsSection title="安全设置">
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

            {/* Storage Configuration Section (New) */}
            <SettingsSection title="存储源设置">
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
                                    "flex items-center justify-between p-3 rounded-lg border transition-all",
                                    account.is_active
                                        ? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
                                        : "bg-background border-border hover:border-border/80"
                                )}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={cn(
                                        "h-2 w-2 rounded-full",
                                        account.is_active ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                                    )} />
                                    <div>
                                        <p className="text-sm font-medium">{account.name || "未命名账户"}</p>
                                        <p className="text-[10px] text-muted-foreground font-mono opacity-60">{account.id}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
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
                                        <code className="block mt-1 p-1 bg-muted rounded text-primary">{(config as any)?.googleDriveRedirectUri || `${window.location.origin}/api/storage/google-drive/callback`}</code>
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                                    "flex items-center justify-between p-3 rounded-lg border transition-all",
                                    account.is_active
                                        ? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
                                        : "bg-background border-border hover:border-border/80"
                                )}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={cn(
                                        "h-2 w-2 rounded-full",
                                        account.is_active ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                                    )} />
                                    <div>
                                        <p className="text-sm font-medium">{account.name || "未命名账户"}</p>
                                        <p className="text-[10px] text-muted-foreground font-mono opacity-60">{account.id}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
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
                                        注册应用时，<b>重定向 URI</b> 请选择 <code>Web</code>（或公共客户端），并填写：
                                        <code className="block mt-1 p-1 bg-muted rounded text-primary">{(config as any)?.redirectUri || `${(window as any)._env_?.VITE_API_URL || import.meta.env.VITE_API_URL || window.location.origin}/api/storage/onedrive/callback`}</code>
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
            <SettingsSection title="阿里云 OSS 设置">
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
                                    "flex items-center justify-between p-3 rounded-lg border transition-all",
                                    account.is_active
                                        ? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
                                        : "bg-background border-border hover:border-border/80"
                                )}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={cn(
                                        "h-2 w-2 rounded-full",
                                        account.is_active ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                                    )} />
                                    <div>
                                        <p className="text-sm font-medium">{account.name || "未命名账户"}</p>
                                        <p className="text-[10px] text-muted-foreground font-mono opacity-60">{account.id}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
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
            <SettingsSection title="S3 兼容存储设置">
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
                                    "flex items-center justify-between p-3 rounded-lg border transition-all",
                                    account.is_active
                                        ? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
                                        : "bg-background border-border hover:border-border/80"
                                )}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={cn(
                                        "h-2 w-2 rounded-full",
                                        account.is_active ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                                    )} />
                                    <div>
                                        <p className="text-sm font-medium">{account.name || "未命名账户"}</p>
                                        <p className="text-[10px] text-muted-foreground font-mono opacity-60">{account.id}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
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
            <SettingsSection title="WebDAV 存储设置">
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
                                    "flex items-center justify-between p-3 rounded-lg border transition-all",
                                    account.is_active
                                        ? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
                                        : "bg-background border-border hover:border-border/80"
                                )}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={cn(
                                        "h-2 w-2 rounded-full",
                                        account.is_active ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                                    )} />
                                    <div>
                                        <p className="text-sm font-medium">{account.name || "未命名账户"}</p>
                                        <p className="text-[10px] text-muted-foreground font-mono opacity-60">{account.id}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
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
                                    <span className={cn(
                                        "text-lg font-semibold",
                                        storageStats.server.usedPercent > 90 ? "text-red-500" :
                                            storageStats.server.usedPercent > 70 ? "text-yellow-500" : "text-green-500"
                                    )}>
                                        {storageStats.server.usedPercent}%
                                    </span>
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

                            {/* FoomClous 使用量 */}
                            <div className="space-y-3">
                                <div className="flex items-center">
                                    <div className="flex items-center gap-3">
                                        <div className="h-10 w-10 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-500">
                                            <Cloud className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-medium">FoomClous 存储</p>
                                            <div className="flex items-baseline gap-1">
                                                <span className="text-2xl font-bold tracking-tight">{storageStats.foomclous.used}</span>
                                                <span className="text-sm text-muted-foreground font-medium">
                                                    ({storageStats.foomclous.fileCount} 个文件)
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* 可用空间 */}
                            <div className="mt-4 p-4 bg-muted/30 rounded-xl border border-border/30">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-muted-foreground">可用空间</span>
                                    <span className="text-sm font-medium text-green-600">{storageStats.server.free}</span>
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

        </motion.div>
    );
};
