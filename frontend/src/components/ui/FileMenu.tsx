import { motion, AnimatePresence } from "framer-motion";
import { Download, FolderInput, MoreVertical, Pencil, Trash2, Star } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";

interface FileMenuProps {
    onDelete?: () => void;
    onToggleFavorite?: () => void;
    onDownload?: () => void;
    onRename?: () => void;
    onMove?: () => void;
    isFavorite?: boolean;
}

export const FileMenu = ({ onDelete, onToggleFavorite, onDownload, onRename, onMove, isFavorite = false }: FileMenuProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsOpen(false);
        };

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEscape);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, []);

    return (
        <div className="relative" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted transition-colors touch-manipulation"
                onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen(!isOpen);
                }}
                aria-label={t("file.moreActions")}
                aria-haspopup="menu"
                aria-expanded={isOpen}
            >
                <MoreVertical className="h-5 w-5" />
            </Button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        role="menu"
                        initial={{ opacity: 0, scale: 0.95, y: 5 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 5 }}
                        transition={{ duration: 0.1 }}
                        className="absolute right-0 top-full mt-1 w-36 bg-white dark:bg-zinc-900 border border-border rounded-xl shadow-lg overflow-hidden z-50 p-1.5"
                    >
                        {onDownload && <button role="menuitem" className="w-full min-h-11 flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted rounded-lg text-left" onClick={e => { e.stopPropagation(); onDownload(); setIsOpen(false); }}><Download className="h-4 w-4" />{t("file.download")}</button>}
                        {onRename && <button role="menuitem" className="w-full min-h-11 flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted rounded-lg text-left" onClick={e => { e.stopPropagation(); onRename(); setIsOpen(false); }}><Pencil className="h-4 w-4" />{t("file.rename")}</button>}
                        {onMove && <button role="menuitem" className="w-full min-h-11 flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted rounded-lg text-left" onClick={e => { e.stopPropagation(); onMove(); setIsOpen(false); }}><FolderInput className="h-4 w-4" />{t("file.move")}</button>}
                        {onDelete && <button
                            role="menuitem"
                            className="w-full min-h-11 flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors text-left font-medium touch-manipulation"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete();
                                setIsOpen(false);
                            }}
                        >
                            <Trash2 className="h-4 w-4" />
                            {t("file.delete")}
                        </button>}
                        <button
                            role="menuitem"
                            className="w-full min-h-11 flex items-center gap-2 px-3 py-2 text-sm text-yellow-600 dark:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10 rounded-lg transition-colors text-left font-medium touch-manipulation"
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleFavorite?.();
                                setIsOpen(false);
                            }}
                        >
                            <Star className={`h-4 w-4 ${isFavorite ? 'fill-current' : ''}`} />
                            {isFavorite ? t("file.unfavorite") : t("file.favorite")}
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
