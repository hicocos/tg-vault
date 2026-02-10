import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { createPortal } from "react-dom";

interface FolderPromptModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (folderName: string) => void;
    onCancel: () => void;
}

export const FolderPromptModal = ({ isOpen, onClose, onConfirm, onCancel }: FolderPromptModalProps) => {
    useTranslation();
    const [folderName, setFolderName] = useState("");

    if (!isOpen) return null;

    const handleConfirm = () => {
        if (folderName.trim()) {
            onConfirm(folderName.trim());
            setFolderName("");
            onClose();
        }
        // 如果用户没有输入文件夹名称而是直接点击确认创建文件夹则不返回响应
    };

    const handleNoFolder = () => {
        onCancel();
        setFolderName("");
        onClose();
    };

    const modalContent = (
        <AnimatePresence>
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
                {/* Backdrop */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                    onClick={onClose}
                />

                {/* Modal Container */}
                <motion.div
                    initial={{ scale: 0.95, opacity: 0, y: 10 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: 10 }}
                    transition={{ type: "spring", stiffness: 350, damping: 25 }}
                    className="relative w-full max-w-md bg-background border border-border rounded-xl shadow-2xl overflow-hidden z-[70] flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-muted/30">
                        <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                            <FolderPlus className="h-5 w-5" />
                        </div>
                        <div className="flex flex-col">
                            <h3 className="font-semibold text-lg leading-none tracking-tight">
                                是否创建文件夹？
                            </h3>
                            <p className="text-sm text-muted-foreground mt-1.5">
                                为本次上传的多文件创建一个文件夹进行管理
                            </p>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="p-6">
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <label htmlFor="folderName" className="text-sm font-medium text-foreground">
                                    自定义文件夹名称
                                </label>
                                <input
                                    id="folderName"
                                    type="text"
                                    className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                                    placeholder="输入文件夹名称..."
                                    value={folderName}
                                    onChange={(e) => setFolderName(e.target.value)}
                                    autoFocus
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") handleConfirm();
                                    }}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Footer - Buttons */}
                    <div className="flex items-center gap-3 px-6 py-4 border-t border-border bg-muted/30">
                        <Button
                            className="flex-1 h-10 px-5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm"
                            onClick={handleConfirm}
                        >
                            确认创建文件夹
                        </Button>
                        <Button
                            variant="outline"
                            className="flex-1 h-10 px-5 text-sm font-medium border-border/80 hover:bg-muted"
                            onClick={handleNoFolder}
                        >
                            不需要文件夹
                        </Button>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );

    return createPortal(modalContent, document.body);
};
