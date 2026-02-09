import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { HardDrive, ChevronRight, Moon, Sun, Monitor, Palette, Globe, Cloud, Server, Database, CheckCircle } from "lucide-react";
import { Button } from "../ui/Button";
import { LanguageToggle } from "../ui/LanguageToggle";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { fileApi, type StorageStats } from "../../services/api";

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
    const [config, setConfig] = useState<{ provider: string; onedrive: { clientId: string | null; tenantId?: string; hasSecret: boolean; hasRefreshToken: boolean } } | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [showOneDriveForm, setShowOneDriveForm] = useState(false);

    // OneDrive Form State
    const [odClientId, setOdClientId] = useState("");
    const [odClientSecret, setOdClientSecret] = useState("");
    const [odRefreshToken] = useState("");
    const [odTenantId, setOdTenantId] = useState("");

    // Load initial config
    useEffect(() => {
        const loadConfig = async () => {
            try {
                const data = await fileApi.getStorageConfig();
                setConfig(data);
                if (data.provider === 'onedrive') {
                    // prefill logic
                    if (data.onedrive.clientId) setOdClientId(data.onedrive.clientId);
                    if (data.onedrive.tenantId) setOdTenantId(data.onedrive.tenantId);
                }
            } catch (error) {
                console.error("Failed to load storage config:", error);
            }
        };
        loadConfig();
    }, []);

    const handleSwitchProvider = async (provider: 'local' | 'onedrive') => {
        if (isSaving) return;
        if (provider === config?.provider) return;

        // If switching to OneDrive and not configured, show form
        if (provider === 'onedrive' && (!config?.onedrive.hasRefreshToken)) {
            setShowOneDriveForm(true);
            return;
        }

        if (!window.confirm(`确定要切换存储源到 ${provider === 'local' ? '本地存储' : 'OneDrive'} 吗？`)) return;

        setIsSaving(true);
        try {
            await fileApi.switchStorageProvider(provider);
            const data = await fileApi.getStorageConfig();
            setConfig(data);
            alert(`已成功切换到 ${provider === 'local' ? '本地存储' : 'OneDrive'}`);
        } catch (error: any) {
            alert(error.message);
            if (provider === 'onedrive') setShowOneDriveForm(true); // Maybe re-configure
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveOneDriveConfig = async () => {
        if (!odClientId) {
            alert("请填写 Client ID");
            return;
        }
        setIsSaving(true);
        try {
            // 首先保存基础配置（Client ID 和 Secret)
            // 注意：此时可能还没有 Refresh Token，后端需要处理这种情况
            await fileApi.updateOneDriveConfig(odClientId, odClientSecret, odRefreshToken || 'pending', odTenantId || 'common');

            // 获取后端 API 基础路径，如果没有配置（同域代理模式），则使用当前源
            const apiBase = (window as any)._env_?.VITE_API_URL || import.meta.env.VITE_API_URL || window.location.origin;
            const redirectUri = `${apiBase.replace(/\/$/, '')}/api/storage/onedrive/callback`;

            // 获取授权 URL
            const { authUrl } = await fileApi.getOneDriveAuthUrl(odClientId, odTenantId || 'common', redirectUri);

            // 打开弹出窗口进行授权
            const width = 600;
            const height = 700;
            const left = window.screenX + (window.innerWidth - width) / 2;
            const top = window.screenY + (window.innerHeight - height) / 2;

            window.open(
                authUrl,
                'OneDriveAuth',
                `width=${width},height=${height},left=${left},top=${top},status=yes,toolbar=no,menubar=no`
            );

            // 监听来自授权窗口的消息
            const messageHandler = async (event: MessageEvent) => {
                if (event.data === 'onedrive_auth_success') {
                    console.log('OneDrive Auth Success message received!');
                    // 重新加载配置
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

    // 计算 FoomClous 在服务器中的占比
    const foomclousPercent = storageStats
        ? Math.round((storageStats.foomclous.usedBytes / storageStats.server.totalBytes) * 100)
        : 0;

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

            {/* Storage Configuration Section (New) */}
            <SettingsSection title="存储源设置">
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
                <SettingsRow
                    icon={Cloud}
                    label="Microsoft OneDrive"
                    description="文件存储在 OneDrive 网盘。节省服务器空间，支持大文件。"
                    value={config?.provider === 'onedrive' ? "正在使用" : config?.onedrive.hasRefreshToken ? "已配置" : "未配置"}
                    action={
                        <div className="flex items-center gap-2">
                            {config?.provider === 'onedrive' && <CheckCircle className="h-5 w-5 text-green-500" />}
                            <Button
                                size="sm"
                                variant={config?.provider === 'onedrive' ? "secondary" : "outline"}
                                onClick={() => setShowOneDriveForm(!showOneDriveForm)}
                            >
                                {config?.onedrive.hasRefreshToken ? "修改配置" : "配置"}
                            </Button>
                            {config?.provider !== 'onedrive' && config?.onedrive.hasRefreshToken && (
                                <Button
                                    size="sm" variant="outline"
                                    onClick={() => handleSwitchProvider('onedrive')}
                                    disabled={isSaving}
                                >
                                    切换使用
                                </Button>
                            )}
                        </div>
                    }
                />

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
                                        注册应用时，<b>重定向 URI</b> 请选择 <code>公共客户端/原生</code>，并填写：
                                        <code className="block mt-1 p-1 bg-muted rounded text-primary">{(window as any)._env_?.VITE_API_URL || import.meta.env.VITE_API_URL || window.location.origin}/api/storage/onedrive/callback</code>
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
                                            <h4 className="text-sm font-medium">账号授权</h4>
                                            <p className="text-xs text-muted-foreground">点击下方按钮前往微软页面完成授权，系统将全自动获取令牌。</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveOneDriveConfig}
                                            disabled={isSaving || !odClientId}
                                            className="shadow-lg shadow-primary/20"
                                        >
                                            {isSaving ? "发起授权中..." : "保存并开始授权"}
                                        </Button>
                                    </div>
                                </div>

                                {config?.onedrive.hasRefreshToken && (
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium opacity-50">Refresh Token (只读)</label>
                                        <div className="px-3 py-2 rounded-lg border border-border bg-black/5 text-xs font-mono text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                                            已配置 (加密隐藏)
                                        </div>
                                    </div>
                                )}

                                <div className="flex justify-end pt-2">
                                    <Button variant="ghost" onClick={() => setShowOneDriveForm(false)}>关闭</Button>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </SettingsSection>

            {/* Storage Stats Section - Real Data */}
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
                                <div className="flex items-center justify-between">
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
                                    <span className="text-lg font-semibold text-blue-500">
                                        {foomclousPercent}%
                                    </span>
                                </div>
                                <div className="h-3 w-full bg-secondary/50 rounded-full overflow-hidden">
                                    <motion.div
                                        initial={{ width: 0 }}
                                        animate={{ width: `${Math.min(foomclousPercent, 100)}%` }}
                                        transition={{ duration: 1, ease: "easeOut" }}
                                        className="h-full bg-blue-500 rounded-full"
                                    />
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    FoomClous 占用服务器总存储的 {foomclousPercent}%
                                </p>
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
