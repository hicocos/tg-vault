import { motion } from "framer-motion";
import { Folder, FolderRoot, X, Check, ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { useState, useEffect } from "react";
import { Dialog } from "./Dialog";
import type { FolderMovePreview } from "../../services/api";
import { performAsyncMutation } from "../../services/asyncMutation";
import { formatBytes } from "../../services/formatBytes";

interface MoveModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (destinationFolder: string | null) => Promise<void>;
    currentFolder: string | null;
    folders: string[]; // List of available folder names
    title?: string;
    sourceFolder?: string;
    isFolder?: boolean;
    onPreview?: (destinationFolder: string | null, signal: AbortSignal) => Promise<FolderMovePreview>;
}

export const MoveModal = ({ isOpen, onClose, onConfirm, currentFolder, folders, title, sourceFolder, isFolder = false, onPreview }: MoveModalProps) => {
    const { t } = useTranslation();
    const [selectedFolder, setSelectedFolder] = useState<string | null>(currentFolder);
    const [preview, setPreview] = useState<FolderMovePreview | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            setSelectedFolder(currentFolder);
            setSubmitError(null);
            setIsSubmitting(false);
        }
    }, [isOpen, currentFolder]);

    useEffect(() => {
        if (!isOpen || !isFolder || !onPreview || selectedFolder === currentFolder) {
            setPreview(null);
            setPreviewError(null);
            setIsPreviewLoading(false);
            return;
        }
        const controller = new AbortController();
        setIsPreviewLoading(true);
        setPreviewError(null);
        onPreview(selectedFolder, controller.signal)
            .then(result => setPreview(result))
            .catch(error => {
                if (error?.name !== 'AbortError') setPreviewError(error?.message || t('files.ui.move.previewFailed'));
            })
            .finally(() => {
                if (!controller.signal.aborted) setIsPreviewLoading(false);
            });
        return () => controller.abort();
    }, [currentFolder, isFolder, isOpen, onPreview, selectedFolder]);

    // Filter out the current folder from the list
    const availableFolders = folders.filter(folder =>
        folder !== currentFolder
        && (!isFolder || !sourceFolder || (folder !== sourceFolder && !folder.startsWith(`${sourceFolder}/`)))
    );

    if (!isOpen) return null;

    const isChanged = selectedFolder !== currentFolder;
    const canConfirm = isChanged && !isPreviewLoading && !previewError && (!isFolder || (!!preview && !preview.conflict));

    const modalContent = (
        <Dialog open={isOpen} onClose={onClose} labelledBy="move-modal-title" closeOnEscape={!isSubmitting} closeOnBackdrop={!isSubmitting} className="w-full max-w-md">
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
                            <ArrowRight className="h-5 w-5" />
                        </div>
                        <div className="flex flex-col flex-1">
                            <h3 id="move-modal-title" className="font-semibold text-lg leading-none tracking-tight">
                                {title || t('files.ui.move.title')}
                            </h3>
                            <p className="text-sm text-muted-foreground mt-1.5">{t('files.ui.move.subtitle')}</p>
                        </div>
                        <button
                            type="button"
                            onClick={isSubmitting ? undefined : onClose}
                            disabled={isSubmitting}
                            className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-muted transition-colors"
                            aria-label={t('files.ui.move.close')}
                            title={t('files.ui.move.close')}
                        >
                            <X className="h-4 w-4 text-muted-foreground" />
                        </button>
                    </div>

                    {/* Current location hint */}
                    {currentFolder && (
                        <div className="px-6 py-3 border-b border-border/50 bg-muted/10">
                            <div className="flex items-center gap-2 text-xs">
                                <span className="text-muted-foreground font-medium">{t('files.ui.move.currentLocation')}</span>
                                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-background border border-border/40">
                                    <Folder className="h-3 w-3 text-muted-foreground" />
                                    <span className="font-semibold text-foreground truncate max-w-[200px]">{currentFolder}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {isFolder && isChanged && (
                        <div className="px-6 py-3 border-b border-border/50 text-xs">
                            {isPreviewLoading ? (
                                <p className="text-muted-foreground">{t('files.ui.move.previewLoading')}</p>
                            ) : previewError ? (
                                <p className="text-destructive">{previewError}</p>
                            ) : preview ? (
                                <div className="space-y-1.5">
                                    <p><span className="text-muted-foreground">{t('files.ui.move.finalPath')}</span><strong>{preview.finalPath}</strong></p>
                                    <p className="text-muted-foreground">{t('files.ui.move.impact', { folders: preview.folderCount, files: preview.fileCount, size: formatBytes(preview.totalSizeBytes) })}</p>
                                    {preview.conflict && <p className="text-destructive">{preview.conflictReason}</p>}
                                </div>
                            ) : null}
                        </div>
                    )}

                    {submitError && <p role="alert" className="px-6 py-3 text-sm text-destructive">{submitError}</p>}

                    {/* Folder List */}
                    <div className="px-4 py-3 max-h-[45vh] overflow-y-auto min-h-[200px]"
                        style={{
                            scrollbarWidth: 'thin',
                            scrollbarColor: 'hsl(var(--muted-foreground) / 0.2) transparent',
                        }}
                    >
                        <div className="space-y-1">
                            {/* Root Folder Option */}
                            <button
                                onClick={() => setSelectedFolder(null)}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 text-left group ${
                                    selectedFolder === null
                                        ? "bg-primary/10 ring-1 ring-primary/30"
                                        : "hover:bg-muted/60"
                                }`}
                            >
                                <div className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
                                    selectedFolder === null
                                        ? "bg-primary text-primary-foreground"
                                        : "bg-muted text-muted-foreground group-hover:bg-background"
                                }`}>
                                    <FolderRoot className="h-4 w-4" />
                                </div>
                                <span className={`flex-1 text-sm truncate ${
                                    selectedFolder === null ? "text-primary font-medium" : "text-foreground"
                                }`}>
                                    {t('files.root')}
                                </span>
                                {selectedFolder === null && (
                                    <motion.div
                                        initial={{ scale: 0 }}
                                        animate={{ scale: 1 }}
                                        className="flex items-center justify-center w-5 h-5 rounded-full bg-primary"
                                    >
                                        <Check className="h-3 w-3 text-primary-foreground" />
                                    </motion.div>
                                )}
                            </button>

                            {/* Divider */}
                            {availableFolders.length > 0 && (
                                <div className="my-1.5 mx-3 border-t border-border/30" />
                            )}

                            {/* Existing Folders */}
                            {availableFolders.map((folder) => (
                                <button
                                    key={folder}
                                    onClick={() => setSelectedFolder(folder)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 text-left group ${
                                        selectedFolder === folder
                                            ? "bg-primary/10 ring-1 ring-primary/30"
                                            : "hover:bg-muted/60"
                                    }`}
                                >
                                    <div className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
                                        selectedFolder === folder
                                            ? "bg-primary text-primary-foreground"
                                            : "bg-muted text-muted-foreground group-hover:bg-background"
                                    }`}>
                                        <Folder className="h-4 w-4" />
                                    </div>
                                    <span className={`flex-1 text-sm truncate ${
                                        selectedFolder === folder ? "text-primary font-medium" : "text-foreground"
                                    }`} title={folder}>
                                        {folder}
                                    </span>
                                    {selectedFolder === folder && (
                                        <motion.div
                                            initial={{ scale: 0 }}
                                            animate={{ scale: 1 }}
                                            className="flex items-center justify-center w-5 h-5 rounded-full bg-primary"
                                        >
                                            <Check className="h-3 w-3 text-primary-foreground" />
                                        </motion.div>
                                    )}
                                </button>
                            ))}

                            {/* Empty state */}
                            {availableFolders.length === 0 && (
                                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground/60">
                                    <Folder className="h-10 w-10 mb-2 opacity-20" />
                                    <p className="text-xs">{t("app.noOtherFolders")}</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="flex justify-end gap-3 px-6 py-4 border-t border-border bg-muted/30">
                        <Button
                            variant="outline"
                            className="h-10 px-5 text-sm font-medium border-border/80 hover:bg-muted"
                            onClick={onClose}
                            disabled={isSubmitting}
                        >
                            {t('common.actions.cancel')}
                        </Button>
                        <Button 
                            onClick={async () => {
                                if (isSubmitting) return;
                                setIsSubmitting(true);
                                setSubmitError(null);
                                await performAsyncMutation({
                                    action: () => onConfirm(selectedFolder),
                                    onSuccess: onClose,
                                    onFailure: error => setSubmitError(error instanceof Error ? error.message : t('files.ui.move.failed')),
                                    onSettled: () => setIsSubmitting(false),
                                });
                            }} 
                            className="h-10 px-5 text-sm font-medium shadow-sm"
                            disabled={!canConfirm || isSubmitting}
                        >
                            {isSubmitting ? t('files.ui.move.moving') : t('files.ui.move.confirm')}
                        </Button>
                    </div>
                </motion.div>
        </Dialog>
    );

    return modalContent;
};
