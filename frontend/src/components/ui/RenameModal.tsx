import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

interface RenameModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (newName: string) => void | Promise<void>;
    currentName: string;
    type: "file" | "folder";
}

export const RenameModal = ({ isOpen, onClose, onConfirm, currentName, type }: RenameModalProps) => {
    const { t } = useTranslation();

    // Split file name into base + extension
    const getBaseName = (name: string) => {
        if (type === "folder") return name;
        const dotIndex = name.lastIndexOf(".");
        return dotIndex > 0 ? name.slice(0, dotIndex) : name;
    };

    const getExtension = (name: string) => {
        if (type === "folder") return "";
        const dotIndex = name.lastIndexOf(".");
        return dotIndex > 0 ? name.slice(dotIndex) : "";
    };

    const [baseName, setBaseName] = useState(getBaseName(currentName));
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const extension = getExtension(currentName);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setBaseName(getBaseName(currentName));
            setError("");
            setIsSubmitting(false);
            // Auto-focus and select text
            setTimeout(() => {
                if (inputRef.current) {
                    inputRef.current.focus();
                    inputRef.current.select();
                }
            }, 100);
        }
    }, [isOpen, currentName]);

    const handleConfirm = async () => {
        if (isSubmitting) return;
        const trimmed = baseName.trim();
        if (trimmed.length === 0) {
            setError(t(type === 'file' ? 'files.ui.rename.fileNameRequired' : 'files.ui.rename.folderNameRequired'));
            return;
        }
        if (/[\\:*?"<>|/]/.test(trimmed)) {
            setError(t('files.ui.rename.invalidCharacters'));
            return;
        }
        const newName = type === "file" ? trimmed + extension : trimmed;
        if (newName === currentName) {
            onClose();
            return;
        }
        setIsSubmitting(true);
        setError("");
        try {
            await onConfirm(newName);
        } catch (confirmError) {
            setError(confirmError instanceof Error ? confirmError.message : t('files.ui.rename.failed'));
        } finally {
            setIsSubmitting(false);
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (isSubmitting) return;
        if (e.key === "Enter") {
            e.preventDefault();
            void handleConfirm();
        } else if (e.key === "Escape") {
            onClose();
        }
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <Dialog
                    open={isOpen}
                    onClose={onClose}
                    closeOnEscape={!isSubmitting}
                    closeOnBackdrop={!isSubmitting}
                    labelledBy="rename-modal-title"
                    describedBy={error ? "rename-modal-error" : undefined}
                    className="w-full max-w-md"
                >
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 10 }}
                        transition={{ duration: 0.15 }}
                        className="w-full bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-border overflow-hidden"
                    >
                        {/* Header */}
                        <div className="flex items-center gap-3 px-6 pt-6 pb-2">
                            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                                <Pencil className="h-5 w-5 text-primary" />
                            </div>
                            <div>
                                <h3 id="rename-modal-title" className="text-lg font-semibold text-foreground">
                                    {t('files.ui.rename.title')}
                                </h3>
                                {type === "file" && extension && (
                                    <p className="text-xs text-muted-foreground">
                                        {t('files.ui.rename.extensionHint')}
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* Input */}
                        <div className="px-6 py-4">
                            <div className="flex items-center rounded-xl border border-border bg-muted/30 focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/50 transition-all overflow-hidden">
                                <input
                                    ref={inputRef}
                                    type="text"
                                    className="flex-1 px-4 py-3 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
                                    placeholder={t('files.ui.rename.placeholder')}
                                    value={baseName}
                                    onChange={(e) => {
                                        setBaseName(e.target.value);
                                        setError("");
                                    }}
                                    onKeyDown={handleKeyDown}
                                />
                                {type === "file" && extension && (
                                    <span className="pr-4 text-sm text-muted-foreground font-medium select-none">
                                        {extension}
                                    </span>
                                )}
                            </div>
                            {error && (
                                <p id="rename-modal-error" className="mt-2 text-xs text-red-500 font-medium">{error}</p>
                            )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center justify-end gap-3 px-6 pb-6">
                            <Button
                                variant="ghost"
                                className="rounded-xl px-5"
                                onClick={isSubmitting ? undefined : onClose}
                                disabled={isSubmitting}
                            >
                                {t('common.actions.cancel')}
                            </Button>
                            <Button
                                className="rounded-xl px-5 bg-primary text-primary-foreground hover:bg-primary/90"
                                onClick={() => void handleConfirm()}
                                disabled={isSubmitting}
                            >
                                {isSubmitting ? t('files.ui.rename.renaming') : t('files.ui.rename.confirm')}
                            </Button>
                        </div>
                    </motion.div>
                </Dialog>
            )}
        </AnimatePresence>
    );
};
