import { useState } from "react";
import { motion } from "framer-motion";
import { FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { performAsyncMutation } from "../../services/asyncMutation";

interface CreateFolderModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (folderName: string) => Promise<void>;
    currentFolder?: string | null;
}

export const CreateFolderModal = ({ isOpen, onClose, onConfirm, currentFolder }: CreateFolderModalProps) => {
    const { t } = useTranslation();
    const [folderName, setFolderName] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    if (!isOpen) return null;

    const handleConfirm = async () => {
        if (folderName.trim() && !isSubmitting) {
            setIsSubmitting(true);
            setSubmitError(null);
            await performAsyncMutation({
                action: () => onConfirm(folderName.trim()),
                onSuccess: () => {
                    setFolderName("");
                    onClose();
                },
                onFailure: error => setSubmitError(error instanceof Error ? error.message : t('files.ui.createFolder.failed')),
                onSettled: () => setIsSubmitting(false),
            });
        }
    };

    const handleClose = () => {
        setFolderName("");
        onClose();
    };

    const modalContent = (
        <Dialog open={isOpen} onClose={handleClose} closeOnEscape={!isSubmitting} closeOnBackdrop={!isSubmitting} labelledBy="create-folder-title" className="relative w-full max-w-md bg-background border border-border rounded-xl shadow-2xl overflow-hidden z-[70] flex flex-col">
            <motion.div initial={{ scale: 0.95, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 10 }} transition={{ type: "spring", stiffness: 350, damping: 25 }}>
                    {/* Header */}
                    <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-muted/30">
                        <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                            <FolderPlus className="h-5 w-5" />
                        </div>
                        <div className="flex flex-col">
                            <h3 id="create-folder-title" className="font-semibold text-lg leading-none tracking-tight">
                                {t('files.ui.createFolder.title')}
                            </h3>
                            <p className="text-sm text-muted-foreground mt-1.5">
                                {t('files.ui.createFolder.location', { location: currentFolder || t('files.root') })}
                            </p>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="p-6">
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <label htmlFor="newFolderName" className="text-sm font-medium text-foreground">
                                    {t('files.ui.createFolder.nameLabel')}
                                </label>
                                <input
                                    id="newFolderName"
                                    type="text"
                                    className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                                    placeholder={t('files.ui.createFolder.placeholder')}
                                    value={folderName}
                                    onChange={(e) => setFolderName(e.target.value)}
                                    disabled={isSubmitting}
                                    autoFocus
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") void handleConfirm();
                                    }}
                                />
                            </div>
                            {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
                        </div>
                    </div>

                    {/* Footer - Buttons */}
                    <div className="flex items-center gap-3 px-6 py-4 border-t border-border bg-muted/30">
                        <Button
                            className="flex-1 h-10 px-5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm"
                            onClick={handleConfirm}
                            disabled={isSubmitting || !folderName.trim()}
                        >
                            {isSubmitting ? t('files.ui.createFolder.creating') : t('files.ui.createFolder.confirm')}
                        </Button>
                        <Button
                            variant="outline"
                            className="flex-1 h-10 px-5 text-sm font-medium border-border/80 hover:bg-muted"
                            onClick={handleClose}
                            disabled={isSubmitting}
                        >
                            {t('common.actions.cancel')}
                        </Button>
                    </div>
            </motion.div>
        </Dialog>
    );

    return modalContent;
};
