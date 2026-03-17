import { motion, AnimatePresence } from "framer-motion";
<<<<<<< HEAD
import { Pencil, Download, Trash2, Star } from "lucide-react";
=======
import { Pencil, Download, Trash2, Star, FolderInput } from "lucide-react";
>>>>>>> 17bc88a (feat: add move file and folder functionality)
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    variant?: "default" | "danger";
}

interface ContextMenuProps {
    x: number;
    y: number;
    isOpen: boolean;
    onClose: () => void;
    items: ContextMenuItem[];
}

export const ContextMenu = ({ x, y, isOpen, onClose, items }: ContextMenuProps) => {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        };

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };

        const handleScroll = () => onClose();

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEscape);
        window.addEventListener("scroll", handleScroll, true);

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
            window.removeEventListener("scroll", handleScroll, true);
        };
    }, [isOpen, onClose]);

    // Adjust position to keep menu within viewport
    useEffect(() => {
        if (!isOpen || !menuRef.current) return;
        const menu = menuRef.current;
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        if (rect.right > vw) {
            menu.style.left = `${x - rect.width}px`;
        }
        if (rect.bottom > vh) {
            menu.style.top = `${y - rect.height}px`;
        }
    }, [isOpen, x, y]);

    return createPortal(
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    ref={menuRef}
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.92 }}
                    transition={{ duration: 0.12 }}
                    className="fixed z-[9999] min-w-[140px] bg-white dark:bg-zinc-900 border border-border rounded-lg shadow-xl overflow-hidden p-1"
                    style={{ left: x, top: y }}
                >
                    {items.map((item, index) => (
                        <button
                            key={index}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-md transition-colors text-left font-medium ${item.variant === "danger"
                                ? "text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                                : "text-foreground hover:bg-muted"
                                }`}
                            onClick={(e) => {
                                e.stopPropagation();
                                item.onClick();
                                onClose();
                            }}
                        >
                            {item.icon}
                            {item.label}
                        </button>
                    ))}
                </motion.div>
            )}
        </AnimatePresence>,
        document.body
    );
};

// Helper to create standard file context menu items
export const createFileMenuItems = (
    t: (key: string) => string,
    onRename?: () => void,
    onDownload?: () => void,
    onToggleFavorite?: () => void,
    isFavorite: boolean = false,
<<<<<<< HEAD
    onDelete?: () => void
=======
    onDelete?: () => void,
    onMove?: () => void
>>>>>>> 17bc88a (feat: add move file and folder functionality)
): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    if (onRename) {
        items.push({
            label: t("file.rename") || "重命名",
            icon: <Pencil className="h-4 w-4" />,
            onClick: onRename,
        });
    }

<<<<<<< HEAD
=======
    if (onMove) {
        items.push({
            label: t("file.move") || "移动",
            icon: <FolderInput className="h-4 w-4" />,
            onClick: onMove,
        });
    }

>>>>>>> 17bc88a (feat: add move file and folder functionality)
    if (onDownload) {
        items.push({
            label: t("file.download") || "下载",
            icon: <Download className="h-4 w-4" />,
            onClick: onDownload,
        });
    }

    if (onToggleFavorite) {
        items.push({
            label: isFavorite ? (t("file.unfavorite") || "取消收藏") : (t("file.favorite") || "收藏"),
            icon: <Star className={`h-4 w-4 ${isFavorite ? 'fill-current' : ''}`} />,
            onClick: onToggleFavorite,
        });
    }

    if (onDelete) {
        items.push({
            label: t("file.delete") || "删除",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: onDelete,
            variant: "danger",
        });
    }

    return items;
};

// Helper to create standard folder context menu items
export const createFolderMenuItems = (
    t: (key: string) => string,
    onRename?: () => void,
    onToggleFavorite?: () => void,
    isFavorite: boolean = false,
<<<<<<< HEAD
    onDelete?: () => void
=======
    onDelete?: () => void,
    onMove?: () => void
>>>>>>> 17bc88a (feat: add move file and folder functionality)
): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    if (onRename) {
        items.push({
            label: t("file.rename") || "重命名",
            icon: <Pencil className="h-4 w-4" />,
            onClick: onRename,
        });
    }

<<<<<<< HEAD
=======
    if (onMove) {
        items.push({
            label: t("file.move") || "移动",
            icon: <FolderInput className="h-4 w-4" />,
            onClick: onMove,
        });
    }

>>>>>>> 17bc88a (feat: add move file and folder functionality)
    if (onDelete) {
        items.push({
            label: t("file.delete") || "删除",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: onDelete,
            variant: "danger",
        });
    }

    if (onToggleFavorite) {
        items.splice(onDelete ? items.length - 1 : items.length, 0, {
            label: isFavorite ? (t("file.unfavorite") || "取消收藏") : (t("file.favorite") || "收藏"),
            icon: <Star className={`h-4 w-4 ${isFavorite ? 'fill-current' : ''}`} />,
            onClick: onToggleFavorite,
        });
    }

    return items;
};
