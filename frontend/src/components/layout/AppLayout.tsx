import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Folder, Settings, Menu, Image as ImageIcon, Video, Music, FileText, ChevronRight, X, Star, Download } from "lucide-react";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import { useTranslation } from "react-i18next";
import { StorageWidget } from "../ui/StorageWidget";
import { LanguageToggle } from "../ui/LanguageToggle";
import type { StorageStats } from "../../services/api";

interface SidebarItemProps {
    icon: React.ElementType;
    label: string;
    isActive?: boolean;
    onClick?: () => void;
    collapsed?: boolean;
    hasSubItems?: boolean;
    isOpen?: boolean;
}

const SidebarItem = ({ icon: Icon, label, isActive, onClick, collapsed, hasSubItems, isOpen }: SidebarItemProps) => {
    return (
        <button
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all group relative",
                isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                collapsed && "justify-center px-2"
            )}
        >
            <Icon className={cn("h-4 w-4 shrink-0 transition-transform duration-300", isActive && "scale-110")} />
            {!collapsed && (
                <>
                    <span className="flex-1 text-left truncate">{label}</span>
                    {hasSubItems && (
                        <ChevronRight className={cn("h-3 w-3 transition-transform text-muted-foreground/70", isOpen && "rotate-90")} />
                    )}
                </>
            )}
        </button>
    );
};

export const AppLayout = ({ children, onCategoryChange, storageStats }: { children: React.ReactNode; onCategoryChange?: (category: string) => void; storageStats?: StorageStats | null }) => {
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [activeTab, setActiveTab] = useState("all");
    const [mediaOpen, setMediaOpen] = useState(true);
    const { t } = useTranslation();

    const handleTabClick = (id: string) => {
        setActiveTab(id);
        onCategoryChange?.(id);
        setIsMobileMenuOpen(false); // Close mobile menu on selection
    };

    const toggleMedia = () => {
        setMediaOpen(!mediaOpen);
    };

    const categories = [
        { id: "all", icon: Folder, label: t("sidebar.files") },
        {
            id: "media",
            icon: ImageIcon,
            label: t("sidebar.media"),
            hasSubItems: true,
            isOpen: mediaOpen,
            onClick: toggleMedia,
            subItems: [
                { id: "image", icon: ImageIcon, label: t("sidebar.categories.images") },
                { id: "video", icon: Video, label: t("sidebar.categories.videos") },
                { id: "audio", icon: Music, label: t("sidebar.categories.audio") },
            ]
        },
        { id: "document", icon: FileText, label: t("sidebar.categories.docs") },
        { id: "ytdlp", icon: Download, label: "YT-DLP" },
        { id: "favorites", icon: Star, label: t("sidebar.favorites") || "Favorites" },
        { id: "settings", icon: Settings, label: t("sidebar.settings") },
    ];

    const renderSidebarContent = (mobile = false) => {
        const collapsed = !mobile && !isSidebarOpen;

        return (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                <div className={cn("flex-1 space-y-1 overflow-y-auto scrollbar-hide", mobile ? "" : "px-4 py-6")}>
                    {categories.map((cat) => (
                        <React.Fragment key={cat.id}>
                            {cat.id === 'ytdlp' && !collapsed && (
                                <div className="px-3 pt-3 pb-1">
                                    <div className="text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">
                                        YT-DLP
                                    </div>
                                </div>
                            )}
                            {cat.hasSubItems ? (
                                <>
                                    <SidebarItem
                                        icon={cat.icon}
                                        label={cat.label}
                                        isActive={activeTab === cat.id}
                                        onClick={cat.onClick}
                                        collapsed={collapsed}
                                        hasSubItems
                                        isOpen={cat.isOpen}
                                    />
                                    <AnimatePresence>
                                        {cat.isOpen && (mobile || isSidebarOpen) && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: "auto", opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                className="overflow-hidden ml-4 pl-3 border-l-2 border-border/50 space-y-1"
                                            >
                                                {cat.subItems?.map(sub => (
                                                    <SidebarItem
                                                        key={sub.id}
                                                        icon={sub.icon}
                                                        label={sub.label}
                                                        isActive={activeTab === sub.id}
                                                        onClick={() => handleTabClick(sub.id)}
                                                        collapsed={false}
                                                    />
                                                ))}
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </>
                            ) : (
                                <SidebarItem
                                    icon={cat.icon}
                                    label={cat.label}
                                    isActive={activeTab === cat.id}
                                    onClick={() => handleTabClick(cat.id)}
                                    collapsed={collapsed}
                                />
                            )}
                        </React.Fragment>
                    ))}
                </div>

                {!collapsed && (
                    <div className={cn("border-t border-border/40 shrink-0", mobile ? "mt-auto pt-4 space-y-4" : "p-4 space-y-4")}>
                        <StorageWidget stats={storageStats} />
                        <div className="flex items-center justify-between">
                            <LanguageToggle />
                            {!mobile && (
                                <Button variant="ghost" size="icon" className="h-8 w-8 ml-auto text-muted-foreground" onClick={() => setIsSidebarOpen(false)}>
                                    <Menu className="h-4 w-4" />
                                </Button>
                            )}
                        </div>
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
                        <img src="/logo.png" alt="Logo" className="h-10 w-10 rounded-xl object-contain shadow-sm" />
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
                        <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(true)}>
                            <Menu className="h-4 w-4" />
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
                                    <img src="/logo.png" alt="Logo" className="h-10 w-10 rounded-xl object-contain shadow-sm" />
                                    <span className="font-bold text-xl">{t("app.title")}</span>
                                </div>
                                <Button size="icon" variant="ghost" onClick={() => setIsMobileMenuOpen(false)}>
                                    <X className="h-5 w-5" />
                                </Button>
                            </div>

                            {renderSidebarContent(true)}
                        </motion.div>
                    </>
                )}
            </AnimatePresence>

            {/* Main Content */}
            <main className="flex-1 flex flex-col h-full overflow-hidden relative bg-gradient-to-br from-background to-muted/20">
                <header className="h-[72px] px-4 sm:px-8 flex items-center justify-between bg-background border-b border-border/40 transition-all">
                    <div className="flex items-center gap-3 md:hidden">
                        <img src="/logo.png" alt="Logo" className="h-10 w-10 rounded-xl object-contain shadow-sm" />
                        <div className="flex flex-col justify-center h-full pt-4 pb-4">
                            <h1 className="text-xl font-bold tracking-tight text-foreground">{t("app.title")}</h1>
                            <p className="text-xs text-muted-foreground hidden sm:block">Home / {categories.find(c => c.id === activeTab)?.label || activeTab}</p>
                        </div>
                    </div>

                    {/* Mobile Menu Toggle */}
                    <div className="md:hidden">
                        <Button size="icon" variant="ghost" onClick={() => setIsMobileMenuOpen(true)}>
                            <Menu className="h-6 w-6" />
                        </Button>
                    </div>
                </header>
                <div className="flex-1 overflow-auto p-4 sm:p-8 scroll-smooth will-change-transform">
                    {children}
                </div>
            </main>
        </div>
    );
};
