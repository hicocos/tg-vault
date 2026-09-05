import { useState } from "react";
import { motion } from "framer-motion";
import { FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

interface FolderPromptModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (folderName: string) => void;
    onCancel: () => void;
    onRoot?: () => void;
    currentFolder?: string | null;
}

export const FolderPromptModal = ({ isOpen, onClose, onConfirm, onCancel, onRoot, currentFolder }: FolderPromptModalProps) => {
    const { t } = useTranslation();
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
        <Dialog open={isOpen} onClose={onClose} labelledBy="folder-prompt-title" className="w-full max-w-md">
                <motion.div
                    initial={{ scale: 0.95, opacity: 0, y: 10 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: 10 }}
                    transition={{ type: "spring", stiffness: 350, damping: 25 }}
                    className="w-full overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
                >
                    {/* Header */}
                    <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-muted/30">
                        <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                            <FolderPlus className="h-5 w-5" />
                        </div>
                        <div className="flex flex-col">
                            <h3 id="folder-prompt-title" className="font-semibold text-lg leading-none tracking-tight">
                                {t('files.ui.folderPrompt.title')}
                            </h3>
                            <p className="text-sm text-muted-foreground mt-1.5">
                                {t('files.ui.folderPrompt.target', { location: currentFolder || t('files.root') })}
                            </p>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="p-6">
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <label htmlFor="folderName" className="text-sm font-medium text-foreground">
                                    {t('files.ui.folderPrompt.nameLabel')}
                                </label>
                                <input
                                    id="folderName"
                                    type="text"
                                    className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                                    placeholder={t('files.ui.folderPrompt.placeholder')}
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
                            {t('files.ui.folderPrompt.create')}
                        </Button>
                        <Button
                            variant="outline"
                            className="flex-1 h-10 px-5 text-sm font-medium border-border/80 hover:bg-muted"
                            onClick={handleNoFolder}
                        >
                            {t('files.ui.folderPrompt.uploadHere')}
                        </Button>
                        {currentFolder && onRoot && (
                            <Button
                                variant="ghost"
                                className="flex-1 h-10 px-5 text-sm font-medium"
                                onClick={() => {
                                    onRoot();
                                    setFolderName("");
                                    onClose();
                                }}
                            >
                                {t('files.ui.folderPrompt.uploadRoot')}
                            </Button>
                        )}
                    </div>
                </motion.div>
        </Dialog>
    );

    return modalContent;
};
