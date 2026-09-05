import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Folder, Settings, Menu, X, Star, LogOut, ListChecks, ListFilter, Monitor, Moon, Sun, UploadCloud, ExternalLink, Sparkles } from "lucide-react";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import { useTranslation } from "react-i18next";
import { StorageWidget } from "../ui/StorageWidget";
import { LanguageToggle } from "../ui/LanguageToggle";
import fileApi, { type StorageStats, type UpdateStatus } from "../../services/api";
import { useTheme } from "../../hooks/useTheme";

const HeaderThemeSwitch = () => {
    const { theme, setTheme } = useTheme();
    const { t } = useTranslation();
    const options = [
        { value: "light" as const, label: t('settings.general.themeLight'), icon: Sun },
        { value: "dark" as const, label: t('settings.general.themeDark'), icon: Moon },
        { value: "system" as const, label: t('settings.general.themeSystem'), icon: Monitor },
    ];
    return (
        <div data-testid="header-theme-switch" className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/50 p-1" role="group" aria-label={t('settings.general.theme')}>
            {options.map(option => {
                const Icon = option.icon;
                const selected = theme === option.value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        className={cn("flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40", selected && "bg-background text-foreground shadow-sm")}
                        onClick={() => setTheme(option.value)}
                        aria-label={option.label}
                        title={option.label}
                        aria-pressed={selected}
                    >
                        <Icon className="h-4 w-4" />
                    </button>
                );
            })}
        </div>
    );
};

interface SidebarItemProps {
    icon: React.ElementType;
    label: string;
    isActive?: boolean;
    href: string;
    onNavigate?: () => void;
    collapsed?: boolean;
}

const SidebarItem = ({ icon: Icon, label, isActive, href, onNavigate, collapsed }: SidebarItemProps) => {
    return (
        <a
            href={href}
            aria-current={isActive ? 'page' : undefined}
            onClick={(event) => { if (onNavigate) { event.preventDefault(); onNavigate(); } }}
            className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all group relative",
                isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                collapsed && "justify-center px-2"
            )}
        >
            <Icon className={cn("h-4 w-4 shrink-0 transition-transform duration-300", isActive && "scale-110")} />
            {!collapsed && <span className="flex-1 text-left truncate">{label}</span>}
        </a>
    );
};

export const AppLayout = ({ children, activeCategory, onCategoryChange, storageStats, onLogout }: { children: React.ReactNode; activeCategory: string; onCategoryChange?: (category: string) => void; storageStats?: StorageStats | null; onLogout?: () => void | Promise<void> }) => {
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
    const [dismissedRelease, setDismissedRelease] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        const applyStatus = (status: UpdateStatus) => {
            if (!active) return;
            setUpdateStatus(status);
            if (!status.latestVersion) {
                setDismissedRelease(null);
                return;
            }
            try {
                setDismissedRelease(window.localStorage.getItem(`tgvault:update-dismissed:${status.latestVersion}`));
            } catch {
                setDismissedRelease(null);
            }
        };
        const loadStatus = () => { void fileApi.getUpdateStatus().then(applyStatus).catch(() => undefined); };
        const handleStatusEvent = (event: Event) => {
            const status = (event as CustomEvent<UpdateStatus>).detail;
            if (status) applyStatus(status);
        };
        const handleVisibility = () => { if (document.visibilityState === 'visible') loadStatus(); };
        loadStatus();
        const timer = window.setInterval(loadStatus, 15 * 60 * 1000);
        window.addEventListener('tgvault:update-status', handleStatusEvent);
        document.addEventListener('visibilitychange', handleVisibility);
        return () => {
            active = false;
            window.clearInterval(timer);
            window.removeEventListener('tgvault:update-status', handleStatusEvent);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, []);

    const dismissUpdate = () => {
        if (!updateStatus?.latestVersion) return;
        const key = `tgvault:update-dismissed:${updateStatus.latestVersion}`;
        try { window.localStorage.setItem(key, 'true'); } catch { /* memory-only dismissal remains available */ }
        setDismissedRelease('true');
    };
    const showUpdateBanner = Boolean(updateStatus?.updateAvailable && updateStatus.latestVersion && updateStatus.releaseUrl && dismissedRelease !== 'true');

    const { t } = useTranslation();

    const handleTabClick = (id: string) => {
        onCategoryChange?.(id);
        setIsMobileMenuOpen(false); // Close mobile menu on selection
    };

    const categories = [
        { id: "upload", href: "/", icon: UploadCloud, label: t("sidebar.uploadCenter") },
        { id: "all", href: "/files", icon: Folder, label: t("sidebar.files") },

        { id: "favorites", href: "/files/favorites", icon: Star, label: t("sidebar.favorites") },
        { id: "tasks", href: "/tasks", icon: ListChecks, label: t("sidebar.tasks") },
        { id: "subscriptions", href: "/subscriptions", icon: ListFilter, label: t('sidebar.subscriptions') },
        { id: "settings", href: "/settings/general", icon: Settings, label: t("sidebar.settings") },
    ];

    const renderSidebarContent = (mobile = false) => {
        const collapsed = !mobile && !isSidebarOpen;

        return (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                <div className={cn("flex-1 space-y-1 overflow-y-auto scrollbar-hide", mobile ? "" : "px-4 py-6")}>
                    {categories.map(cat => (
                        <SidebarItem
                            key={cat.id}
                            icon={cat.icon}
                            label={cat.label}
                            href={cat.href}
                            isActive={activeCategory === cat.id}
                            onNavigate={() => handleTabClick(cat.id)}
                            collapsed={collapsed}
                        />
                    ))}
                </div>

                {!collapsed && (
                    <div className={cn("border-t border-border/40 shrink-0", mobile ? "mt-auto pt-4 space-y-4" : "p-4 space-y-4")}>
                        <StorageWidget stats={storageStats} />
                        <div className="flex items-center justify-between">
                            <LanguageToggle />
                            {!mobile && (
                                <Button variant="ghost" size="icon" className="h-8 w-8 ml-auto text-muted-foreground" onClick={() => setIsSidebarOpen(false)} aria-label={t('sidebar.collapse')} title={t('sidebar.collapse')}>
                                    <Menu className="h-4 w-4" />
                                </Button>
                            )}
                        </div>
                        <Button
                            variant="ghost"
                            className="w-full justify-start gap-2 text-muted-foreground hover:text-destructive"
                            onClick={() => void onLogout?.()}
                        >
                            <LogOut className="h-4 w-4" />
                            {t("sidebar.logout")}
                        </Button>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="flex h-screen w-full overflow-hidden bg-background font-sans">
            {/* Sidebar - Desktop */}
            <motion.aside
                initial={false}
                animate={{ width: isSidebarOpen ? 260 : 80 }}
                className="hidden md:flex h-full flex-col border-r border-border/40 bg-card/30 backdrop-blur-xl transition-all duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
            >
                <div className="flex h-[72px] items-center border-b border-border/40 px-5 gap-3 justify-between shrink-0">
                    <div className={cn("flex items-center gap-3 overflow-hidden", !isSidebarOpen && "justify-center w-full")}>
                        <img src="/logo-80.webp?v=tg-vault" alt="TG Vault" width="40" height="40" decoding="async" className="h-10 w-10 rounded-xl object-contain shadow-sm" />
                        {isSidebarOpen && (
                            <motion.span
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="font-bold tracking-tight text-xl truncate"
                            >
                                {t("app.title")}
                            </motion.span>
                        )}
                    </div>
                </div>

                {renderSidebarContent(false)}

                {!isSidebarOpen && (
                    <div className="flex flex-col items-center py-4 gap-4 border-t border-border/40">
                        <LanguageToggle compact className="w-14 px-1 [&_svg]:hidden [&_select]:w-full" />
                        <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(true)} aria-label={t('sidebar.expand')} title={t('sidebar.expand')}>
                            <Menu className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title={t("sidebar.logout")} aria-label={t("sidebar.logout")} onClick={() => void onLogout?.()}>
                            <LogOut className="h-4 w-4" />
                        </Button>
                    </div>
                )}
            </motion.aside>

            {/* Mobile Menu Drawer */}
            <AnimatePresence>
                {isMobileMenuOpen && (
                    <>
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setIsMobileMenuOpen(false)}
                            className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
                        />
                        <motion.div
                            initial={{ x: "100%" }}
                            animate={{ x: 0 }}
                            exit={{ x: "100%" }}
                            transition={{ type: "spring", damping: 20, stiffness: 300 }}
                            className="fixed inset-y-0 right-0 z-50 h-full w-4/5 max-w-xs border-l border-border bg-background p-6 shadow-xl md:hidden flex flex-col"
                        >
                            <div className="flex items-center justify-between mb-8">
                                <div className="flex items-center gap-2">
                                    <img src="/logo-80.webp?v=tg-vault" alt="TG Vault" width="40" height="40" decoding="async" className="h-10 w-10 rounded-xl object-contain shadow-sm" />
                                    <span className="font-bold text-xl">{t("app.title")}</span>
                                </div>
                                <Button size="icon" variant="ghost" onClick={() => setIsMobileMenuOpen(false)} aria-label={t('sidebar.closeNavigation')} title={t('sidebar.closeNavigation')}>
                                    <X className="h-5 w-5" />
                                </Button>
                            </div>

                            {renderSidebarContent(true)}
                        </motion.div>
                    </>
                )}
            </AnimatePresence>

            {/* Main Content */}
            <main className="flex-1 flex flex-col h-full min-h-0 overflow-hidden relative bg-gradient-to-br from-background to-muted/20">
                <header data-testid="app-header" className="h-[72px] min-w-0 px-4 sm:px-8 flex items-center justify-between bg-background border-b border-border/40 transition-all">
                    <div data-testid="mobile-brand" className="flex min-w-0 items-center gap-2 md:hidden">
                        <img src="/logo-80.webp?v=tg-vault" alt="TG Vault" width="40" height="40" decoding="async" className="h-10 w-10 shrink-0 rounded-xl object-contain shadow-sm" />
                        <div className="flex min-w-0 flex-col justify-center h-full pt-4 pb-4">
                            <h1 className="text-xl font-bold tracking-tight text-foreground">{t("app.title")}</h1>
                            <p className="text-xs text-muted-foreground">{categories.find(c => c.id === activeCategory)?.label || activeCategory}</p>
                        </div>
                    </div>

                    <div data-testid="header-actions" className="ml-auto flex shrink-0 items-center gap-2">
                        <LanguageToggle compact className="max-[420px]:w-[84px] max-[420px]:px-2 max-[420px]:[&_svg]:hidden max-[420px]:[&_select]:w-full max-[420px]:[&_select]:max-w-none" />
                        <div className="max-[420px]:hidden"><HeaderThemeSwitch /></div>
                        <div className="md:hidden">
                            <Button size="icon" variant="ghost" onClick={() => setIsMobileMenuOpen(true)} aria-label={t('sidebar.openNavigation')} title={t('sidebar.openNavigation')}>
                                <Menu className="h-6 w-6" />
                            </Button>
                        </div>
                    </div>
                </header>
                {showUpdateBanner && updateStatus && (
                    <div className="border-b border-sky-200/70 bg-sky-50/90 px-4 py-3 text-sky-950 dark:border-sky-900/70 dark:bg-sky-950/35 dark:text-sky-100 sm:px-8" role="status">
                        <div className="mx-auto flex max-w-7xl items-start gap-3 sm:items-center">
                            <span className="mt-0.5 rounded-full bg-sky-100 p-1.5 text-sky-700 dark:bg-sky-900/70 dark:text-sky-200 sm:mt-0"><Sparkles className="h-4 w-4" /></span>
                            <p className="min-w-0 flex-1 text-sm leading-5">
                                <span className="font-semibold">{t('updates.bannerTitle', { latest: updateStatus.latestVersion })}</span>
                                <span className="ml-1 text-sky-800/80 dark:text-sky-200/80">{t('updates.bannerCurrent', { current: updateStatus.currentVersion })}</span>
                            </p>
                            <a href={updateStatus.releaseUrl || '#'} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-sky-800 transition-colors hover:bg-sky-100 dark:text-sky-200 dark:hover:bg-sky-900/70">
                                {t('updates.viewRelease')} <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                            <button type="button" onClick={dismissUpdate} className="shrink-0 rounded-md p-1 text-sky-700/70 transition-colors hover:bg-sky-100 hover:text-sky-900 dark:text-sky-200/70 dark:hover:bg-sky-900/70 dark:hover:text-sky-100" aria-label={t('updates.dismiss')} title={t('updates.dismiss')}>
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                )}
                <div className="flex-1 overflow-auto p-4 sm:p-8 scroll-smooth will-change-transform">
                    {children}
                </div>
            </main>
        </div>
    );
};
