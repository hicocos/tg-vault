import { aboutCopy } from '../pages/AboutPage';
import React, { useEffect, useRef, useState } from "react";
import { MotionConfig } from "framer-motion";
import { Folder, Settings, Menu, X, Star, LogOut, ListChecks, ListFilter, Monitor, Moon, Sun, UploadCloud, ExternalLink, Sparkles, CircleHelp, Download } from "../ui/icons";
import { cn } from "../../lib/utils";
import { useTranslation } from "react-i18next";
import { normalizeLocale } from "../../i18n/registry";
import { StorageWidget } from "../ui/StorageWidget";
import { LanguageToggle } from "../ui/LanguageToggle";
import fileApi, { type StorageStats, type UpdateStatus } from "../../services/api";
import { useTheme } from "../../hooks/useTheme";
import "./shell.css";

const shellCopy = {
    'zh-CN': { workspace: '工作空间', management: '管理', console: '文件管理控制台', navigation: '主导航', skip: '跳到主要内容' },
    en: { workspace: 'Workspace', management: 'Management', console: 'File management console', navigation: 'Main navigation', skip: 'Skip to main content' },
    ru: { workspace: 'Рабочее пространство', management: 'Управление', console: 'Управление файлами', navigation: 'Основная навигация', skip: 'Перейти к содержимому' },
};

const ThemeSwitch = () => {
    const { theme, setTheme } = useTheme();
    const { t } = useTranslation();
    const options = [
        { value: "light" as const, label: t('settings.general.themeLight'), icon: Sun },
        { value: "dark" as const, label: t('settings.general.themeDark'), icon: Moon },
        { value: "system" as const, label: t('settings.general.themeSystem'), icon: Monitor },
    ];
    return (
        <div className="tv-theme-switch" role="group" aria-label={t('settings.general.theme')}>
            {options.map(option => {
                const Icon = option.icon;
                return (
                    <button key={option.value} type="button" onClick={() => setTheme(option.value)}
                        aria-label={option.label} title={option.label} aria-pressed={theme === option.value}>
                        <Icon size={16} aria-hidden="true" />
                    </button>
                );
            })}
        </div>
    );
};

const HeaderThemeSwitch = () => <div data-testid="header-theme-switch"><ThemeSwitch /></div>;

interface SidebarItemProps {
    icon: React.ElementType;
    label: string;
    isActive?: boolean;
    href: string;
    onNavigate?: () => void;
}

// Keep real destinations and native modified/new-tab clicks; ordinary clicks use SPA history.
const SidebarItem = ({ icon: Icon, label, isActive, href, onNavigate }: SidebarItemProps) => (
    <a href={href} aria-current={isActive ? 'page' : undefined} title={label}
        onClick={event => {
            if (onNavigate && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                onNavigate();
            }
        }} className={cn('tv-nav-link', isActive && 'is-active')}>
        <Icon size={19} aria-hidden="true" />
        <span className="tv-nav-label">{label}</span>
    </a>
);

export const AppLayout = ({ children, activeCategory, onCategoryChange, storageStats, onLogout, qbittorrentEnabled = false }: { children: React.ReactNode; activeCategory: string; onCategoryChange?: (category: string) => void; storageStats?: StorageStats | null; onLogout?: () => void | Promise<void>; qbittorrentEnabled?: boolean }) => {
    const { t, i18n } = useTranslation();
    const copy = shellCopy[normalizeLocale(i18n.resolvedLanguage || i18n.language)];
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && (window.matchMedia?.('(min-width: 761px)').matches ?? true));
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
    const [dismissedRelease, setDismissedRelease] = useState<string | null>(null);
    const sidebarRef = useRef<HTMLElement>(null);
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const mainRef = useRef<HTMLElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const mobileOpen = isMobileMenuOpen && !isDesktop;

    useEffect(() => {
        const media = window.matchMedia?.('(min-width: 761px)');
        if (!media) return;
        const handleResize = () => {
            setIsDesktop(media.matches);
            if (media.matches) setIsMobileMenuOpen(false);
        };
        media.addEventListener('change', handleResize);
        return () => media.removeEventListener('change', handleResize);
    }, []);

    useEffect(() => { setIsMobileMenuOpen(false); }, [activeCategory]);

    useEffect(() => {
        const closeNavigation = () => setIsMobileMenuOpen(false);
        window.addEventListener('popstate', closeNavigation);
        window.addEventListener('hashchange', closeNavigation);
        return () => {
            window.removeEventListener('popstate', closeNavigation);
            window.removeEventListener('hashchange', closeNavigation);
        };
    }, []);

    useEffect(() => {
        if (!mobileOpen) return;
        const sidebar = sidebarRef.current;
        const scroll = scrollRef.current;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const previousBodyOverflow = document.body.style.overflow;
        const previousScrollOverflow = scroll?.style.overflow || '';
        document.body.style.overflow = 'hidden';
        if (scroll) scroll.style.overflow = 'hidden';
        const focusables = () => Array.from(sidebar?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) || []).filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'));
        closeButtonRef.current?.focus({ preventScroll: true });
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setIsMobileMenuOpen(false);
                return;
            }
            if (event.key !== 'Tab') return;
            const elements = focusables();
            const first = elements[0], last = elements[elements.length - 1];
            if (!first) { event.preventDefault(); sidebar?.focus(); return; }
            if (event.shiftKey && (document.activeElement === first || !sidebar?.contains(document.activeElement))) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !sidebar?.contains(document.activeElement))) {
                event.preventDefault(); first.focus();
            }
        };
        const containFocus = (event: FocusEvent) => {
            if (event.target instanceof Node && !sidebar?.contains(event.target)) {
                (focusables()[0] || sidebar)?.focus({ preventScroll: true });
            }
        };
        document.addEventListener('keydown', handleKeyDown, true);
        document.addEventListener('focusin', containFocus);
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
            document.removeEventListener('focusin', containFocus);
            document.body.style.overflow = previousBodyOverflow;
            if (scroll) scroll.style.overflow = previousScrollOverflow;
            const target = previousFocus?.isConnected && previousFocus.getClientRects().length ? previousFocus
                : menuButtonRef.current?.getClientRects().length ? menuButtonRef.current : mainRef.current;
            target?.focus({ preventScroll: true });
        };
    }, [mobileOpen]);

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
    const handleTabClick = (id: string) => {
        onCategoryChange?.(id);
        setIsMobileMenuOpen(false);
    };
    const categories = [
        { id: "upload", href: "/", icon: UploadCloud, label: t("sidebar.uploadCenter") },
        { id: "all", href: "/files", icon: Folder, label: t("sidebar.files") },
        { id: "favorites", href: "/files/favorites", icon: Star, label: t("sidebar.favorites") },
        { id: "tasks", href: "/tasks", icon: ListChecks, label: t("sidebar.tasks") },
        ...(qbittorrentEnabled ? [{ id: 'downloads', href: '/downloads', icon: Download, label: t('qbittorrent.nav') }] : []),
        { id: "subscriptions", href: "/subscriptions", icon: ListFilter, label: t('sidebar.subscriptions') },
        { id: "settings", href: "/settings/general", icon: Settings, label: t("sidebar.settings") },
        { id: "about", href: "/about", icon: CircleHelp, label: aboutCopy[normalizeLocale(i18n.resolvedLanguage || i18n.language)].title },
    ];
    const currentLabel = categories.find(category => category.id === activeCategory)?.label || activeCategory;
    const navigateHome = (event: React.MouseEvent<HTMLAnchorElement>) => {
        if (onCategoryChange && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            event.preventDefault(); handleTabClick('upload');
        }
    };

    return (
        <MotionConfig reducedMotion="user">
            <div className={cn('tv-shell tv-textured-canvas', !isSidebarOpen && 'is-sidebar-collapsed')}>
                <a className="tv-skip-link" href="#main-content" inert={mobileOpen}>{copy.skip}</a>
                {mobileOpen && <button type="button" className="tv-sidebar-overlay" tabIndex={-1} aria-label={t('sidebar.closeNavigation')} onClick={() => setIsMobileMenuOpen(false)} />}
                <aside id="app-navigation" ref={sidebarRef} className={cn('tv-sidebar tv-textured-chrome', mobileOpen && 'is-open')}
                    role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen || undefined} aria-label={copy.navigation}
                    inert={!isDesktop && !mobileOpen} tabIndex={-1}>
                    <div className="tv-sidebar-brand-row">
                        <a href="/" onClick={navigateHome} className="tv-shell-brand" title={t('app.title')}>
                            <img src="/logo-80.webp?v=tg-vault" alt="" width="38" height="38" decoding="async" />
                            <span className="tv-brand-copy"><strong>{t('app.title')}</strong><small>{copy.console}</small></span>
                        </a>
                        <button ref={closeButtonRef} type="button" className="tv-icon-button tv-mobile-close" onClick={() => setIsMobileMenuOpen(false)} aria-label={t('sidebar.closeNavigation')} title={t('sidebar.closeNavigation')}><X size={18} aria-hidden="true" /></button>
                    </div>
                    <nav className="tv-sidebar-nav" aria-label={copy.navigation}>
                        <span className="tv-nav-group">{copy.workspace}</span>
                        {categories.map(cat => (
                            <React.Fragment key={cat.id}>
                                {cat.id === 'settings' && <span className="tv-nav-group">{copy.management}</span>}
                                <SidebarItem {...cat} isActive={activeCategory === cat.id} onNavigate={onCategoryChange ? () => handleTabClick(cat.id) : undefined} />
                            </React.Fragment>
                        ))}
                    </nav>
                    <div className="tv-sidebar-bottom">
                        <section className="tv-sidebar-storage" aria-label={t('sidebar.storage.uc')}>
                            <StorageWidget stats={storageStats} />
                        </section>
                        <div className="tv-sidebar-preferences">
                            <LanguageToggle compact />
                            <button type="button" className="tv-icon-button tv-sidebar-collapse" onClick={() => setIsSidebarOpen(open => !open)} aria-label={isSidebarOpen ? t('sidebar.collapse') : t('sidebar.expand')} title={isSidebarOpen ? t('sidebar.collapse') : t('sidebar.expand')}><Menu size={18} aria-hidden="true" /></button>
                        </div>
                        <div className="tv-sidebar-theme"><span>{t('settings.general.theme')}</span><ThemeSwitch /></div>
                        <button type="button" className="tv-sidebar-logout" title={t('sidebar.logout')} aria-label={t('sidebar.logout')} onClick={() => { setIsMobileMenuOpen(false); void onLogout?.(); }}>
                            <LogOut size={18} aria-hidden="true" /><span>{t('sidebar.logout')}</span>
                        </button>
                    </div>
                </aside>

                {/* Preserve the main > scrolling div contract used by file browsing. */}
                <main ref={mainRef} className="tv-workspace" inert={mobileOpen} tabIndex={-1}>
                    <header data-testid="app-header" className="tv-topbar tv-textured-chrome min-w-0">
                        <div className="tv-topbar-location">
                            <button ref={menuButtonRef} type="button" className="tv-icon-button tv-mobile-menu" onClick={() => setIsMobileMenuOpen(true)} aria-controls="app-navigation" aria-expanded={mobileOpen} aria-label={t('sidebar.openNavigation')} title={t('sidebar.openNavigation')}><Menu size={21} aria-hidden="true" /></button>
                            <div className="tv-desktop-breadcrumb"><span>{copy.workspace}</span><span aria-hidden="true">/</span><strong>{currentLabel}</strong></div>
                            <div data-testid="mobile-brand" className="tv-mobile-brand min-w-0"><strong>{t('app.title')}</strong><span>{currentLabel}</span></div>
                        </div>
                        <div data-testid="header-actions" className="tv-header-actions shrink-0">
                            <LanguageToggle compact className="max-[420px]:w-[120px] max-[420px]:shrink-0 max-[420px]:px-2 max-[420px]:[&_svg]:hidden max-[420px]:[&_select]:w-full max-[420px]:[&_select]:max-w-none" />
                            <div className="max-[420px]:hidden"><HeaderThemeSwitch /></div>
                        </div>
                    </header>
                    {showUpdateBanner && updateStatus && (
                        <div className="tv-update-banner" role="status">
                            <div className="tv-update-inner">
                                <Sparkles size={18} aria-hidden="true" />
                                <p><strong>{t('updates.bannerTitle', { latest: updateStatus.latestVersion })}</strong><span>{t('updates.bannerCurrent', { current: updateStatus.currentVersion })}</span></p>
                                <a href={updateStatus.releaseUrl || undefined} target="_blank" rel="noopener noreferrer">{t('updates.viewRelease')}<ExternalLink size={14} aria-hidden="true" /></a>
                                <button type="button" className="tv-icon-button" onClick={dismissUpdate} aria-label={t('updates.dismiss')} title={t('updates.dismiss')}><X size={16} aria-hidden="true" /></button>
                            </div>
                        </div>
                    )}
                    <div id="main-content" ref={scrollRef} className="tv-main-scroll flex-1 overflow-auto" tabIndex={-1}>
                        <div className="tv-main-content">{children}</div>
                    </div>
                </main>
            </div>
        </MotionConfig>
    );
};
