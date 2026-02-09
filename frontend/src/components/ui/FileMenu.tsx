import { motion, AnimatePresence } from "framer-motion";
import { MoreVertical, Trash2 } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";

interface FileMenuProps {
    onDelete: () => void;
}

export const FileMenu = ({ onDelete }: FileMenuProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    return (
        <div className="relative" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted transition-colors"
                onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen(!isOpen);
                }}
            >
                <MoreVertical className="h-4 w-4" />
            </Button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 5 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 5 }}
                        transition={{ duration: 0.1 }}
                        className="absolute right-0 top-full mt-1 w-32 bg-white dark:bg-zinc-900 border border-border rounded-lg shadow-lg overflow-hidden z-50 p-1"
                    >
                        <button
                            className="w-full flex items-center gap-2 px-2.5 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md transition-colors text-left font-medium"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete();
                                setIsOpen(false);
                            }}
                        >
                            <Trash2 className="h-4 w-4" />
                            {t("file.delete") || "Delete"}
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
