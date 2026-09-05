import { motion, AnimatePresence } from "framer-motion";
import { Trash2, Star, Download, Share2 } from "lucide-react";
import { useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface MobileMenuProps {
    onDelete?: () => void;
    onToggleFavorite?: () => void;
    onDownload?: () => void;
    onShare?: () => void;
    isFavorite?: boolean;
    isOpen: boolean;
    onClose: () => void;
    x: number;
    y: number;
}

export const MobileMenu = ({ 
    onDelete, 
    onToggleFavorite, 
    onDownload, 
    onShare,
    isFavorite = false, 
    isOpen, 
    onClose, 
    x, 
    y 
}: MobileMenuProps) => {
    const menuRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener("mousedown", handleClickOutside);
        }

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [isOpen, onClose]);

    // 调整菜单位置以避免超出屏幕边界
    const adjustedX = Math.min(x, window.innerWidth - 200);
    const adjustedY = Math.min(y, window.innerHeight - 250);

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-40"
                        onClick={onClose}
                    />
                    <motion.div
                        ref={menuRef}
                        initial={{ opacity: 0, scale: 0.95, y: 5 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 5 }}
                        transition={{ duration: 0.1 }}
                        className="fixed bg-white dark:bg-zinc-900 border border-border rounded-lg shadow-lg overflow-hidden z-50 p-1"
                        style={{
                            left: `${adjustedX}px`,
                            top: `${adjustedY}px`,
                            minWidth: '160px'
                        }}
                    >
                        {onToggleFavorite && (
                            <button
                                className="w-full flex items-center gap-2 px-2.5 py-2 text-sm text-yellow-600 dark:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10 rounded-md transition-colors text-left font-medium"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleFavorite();
                                    onClose();
                                }}
                            >
                                <Star className={`h-4 w-4 ${isFavorite ? 'fill-current' : ''}`} />
                                {isFavorite ? t("file.unfavorite") : t("file.favorite")}
                            </button>
                        )}
                        
                        {onDownload && (
                            <button
                                className="w-full flex items-center gap-2 px-2.5 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-md transition-colors text-left font-medium"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDownload();
                                    onClose();
                                }}
                            >
                                <Download className="h-4 w-4" />
                                {t("file.download")}
                            </button>
                        )}

                        {onShare && (
                            <button
                                className="w-full flex items-center gap-2 px-2.5 py-2 text-sm text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-500/10 rounded-md transition-colors text-left font-medium"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onShare();
                                    onClose();
                                }}
                            >
                                <Share2 className="h-4 w-4" />
                                {t("file.share")}
                            </button>
                        )}

                        {onDelete && (
                            <button
                                className="w-full flex items-center gap-2 px-2.5 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md transition-colors text-left font-medium"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete();
                                    onClose();
                                }}
                            >
                                <Trash2 className="h-4 w-4" />
                                {t("file.delete")}
                            </button>
                        )}
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};
