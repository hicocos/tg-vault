import { motion, AnimatePresence } from "framer-motion";
import { Folder, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { useState, useEffect } from "react";

interface MoveModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (destinationFolder: string | null) => void;
    currentFolder: string | null;
    folders: string[]; // List of available folder names
    title?: string;
}

export const MoveModal = ({ isOpen, onClose, onConfirm, currentFolder, folders, title }: MoveModalProps) => {
    const { t } = useTranslation();
    const [selectedFolder, setSelectedFolder] = useState<string | null>(currentFolder);

    useEffect(() => {
        if (isOpen) {
            setSelectedFolder(currentFolder);
        }
    }, [isOpen, currentFolder]);

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                    onClick={onClose}
                />
                
                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 10 }}
                    transition={{ duration: 0.15 }}
                    className="relative w-full max-w-md bg-card rounded-2xl shadow-xl border border-border overflow-hidden"
                >
                    <div className="flex items-center justify-between p-4 border-b border-border/50 bg-muted/30">
                        <h3 className="text-lg font-semibold text-foreground">
                            {title || t("app.moveTo") || "移动到"}
                        </h3>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={onClose}
                            className="h-8 w-8 rounded-full hover:bg-black/5"
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </div>

                    <div className="p-2 max-h-[50vh] overflow-y-auto min-h-[250px] custom-scrollbar">
                        <div className="space-y-1">
                            {/* Root Folder Option */}
                            <button
                                onClick={() => setSelectedFolder(null)}
                                className={`w-full flex items-center gap-3 p-3 rounded-xl transition-colors text-left ${
                                    selectedFolder === null
                                        ? "bg-primary/10 text-primary font-medium"
                                        : "hover:bg-muted text-foreground"
                                }`}
                            >
                                <Folder className={`h-5 w-5 ${selectedFolder === null ? "text-primary fill-primary/20" : "text-muted-foreground"}`} />
                                <span>{t("app.rootDirectory") || "根目录"}</span>
                            </button>

                            {/* Existing Folders */}
                            {folders.map((folder) => (
                                <button
                                    key={folder}
                                    onClick={() => setSelectedFolder(folder)}
                                    className={`w-full flex items-center gap-3 p-3 rounded-xl transition-colors text-left ${
                                        selectedFolder === folder
                                            ? "bg-primary/10 text-primary font-medium"
                                            : "hover:bg-muted text-foreground"
                                    }`}
                                >
                                    <Folder className={`h-5 w-5 ${selectedFolder === folder ? "text-primary fill-primary/20" : "text-muted-foreground"}`} />
                                    <span className="truncate">{folder}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="p-4 border-t border-border/50 bg-muted/10 flex justify-end gap-3">
                        <Button variant="secondary" onClick={onClose} className="px-5 rounded-xl">
                            {t("app.cancel") || "取消"}
                        </Button>
                        <Button 
                            onClick={() => {
                                onConfirm(selectedFolder);
                                onClose();
                            }} 
                            className="px-5 shadow-sm rounded-xl"
                            disabled={selectedFolder === currentFolder} // Prevent moving to same location
                        >
                            {t("app.confirm") || "确定"}
                        </Button>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );
};
