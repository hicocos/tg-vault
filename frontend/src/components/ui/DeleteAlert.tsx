import { useState } from "react";
import { motion } from "framer-motion";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import type { BatchDeleteResult } from "../../services/api";
import { formatDeleteSize } from "./deletePresentation";

interface DeleteAlertProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
    fileName?: string;
    itemCount?: number;
    dataFileCount?: number;
    placeholderCount?: number;
    folderCount?: number;
    totalSizeBytes?: number;
    result?: BatchDeleteResult | null;
}

export const DeleteAlert = ({
    isOpen,
    onClose,
    onConfirm,
    fileName,
    itemCount = 0,
    dataFileCount = 0,
    placeholderCount = 0,
    folderCount = 0,
    totalSizeBytes = 0,
    result,
}: DeleteAlertProps) => {
    const { t } = useTranslation();
    const [isDeleting, setIsDeleting] = useState(false);

    if (!isOpen) return null;

    const handleConfirm = async () => {
        if (isDeleting) return;
        setIsDeleting(true);
        try {
            await onConfirm();
        } finally {
            setIsDeleting(false);
        }
    };

    const isPartial = result?.status === 'partial';
    const modalContent = (
        <Dialog open={isOpen} onClose={onClose} labelledBy="delete-alert-title" alert closeOnEscape={!isDeleting} closeOnBackdrop={!isDeleting} className="w-full max-w-md">
                <motion.div
                    initial={{ scale: 0.95, opacity: 0, y: 10 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: 10 }}
                    transition={{ type: "spring", stiffness: 350, damping: 25 }}
                    className="w-full overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
                >
                    <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-muted/30">
                        <div className="h-10 w-10 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0">
                            <Trash2 className="h-5 w-5" />
                        </div>
                        <div className="flex flex-col">
                            <h3 id="delete-alert-title" className="font-semibold text-lg leading-none tracking-tight">
                                {isPartial ? t('files.ui.deleteDialog.partialTitle') : t('files.ui.deleteDialog.title')}
                            </h3>
                            <p className="text-sm text-muted-foreground mt-1.5">
                                {isPartial ? t('files.ui.deleteDialog.partialSubtitle') : t('files.ui.deleteDialog.subtitle')}
                            </p>
                        </div>
                    </div>

                    <div className="p-6">
                        {isPartial ? (
                            <div className="space-y-3 text-sm">
                                <p className="text-foreground/80">
                                    {t('files.ui.deleteDialog.partialSummary', { deleted: result.deletedIds.length, failed: result.failedFiles.length })}
                                </p>
                                <ul className="max-h-48 space-y-2 overflow-auto rounded-lg border border-border bg-muted/20 p-3">
                                    {result.failedFiles.map(file => (
                                        <li key={file.id} className="break-all">
                                            <span className="font-medium">{file.name}</span>
                                            <span className="block text-xs text-muted-foreground">{file.error}</span>
                                        </li>
                                    ))}
                                </ul>
                                <p className="text-xs text-muted-foreground">{t('files.ui.deleteDialog.partialRetryHint')}</p>
                            </div>
                        ) : (
                            <div className="flex items-start gap-4">
                                <div className="flex-1">
                                    <p className="text-sm text-foreground/80 leading-relaxed">
                                        {itemCount > 0 ? (
                                            <>
                                                {t('files.ui.deleteDialog.dataFiles', { count: dataFileCount })}
                                                {totalSizeBytes > 0 && t('files.ui.deleteDialog.totalSize', { size: formatDeleteSize(totalSizeBytes) })}
                                                {placeholderCount > 0 && (
                                                    <><br />{t('files.ui.deleteDialog.placeholders', { count: placeholderCount })}</>
                                                )}
                                                {folderCount > 0 && (
                                                    <><br />{t('files.ui.deleteDialog.affectedFolders', { count: folderCount })}</>
                                                )}
                                                <br className="mb-2" />
                                                {t('files.ui.deleteDialog.irreversibleQuestion')}
                                            </>
                                        ) : fileName ? (
                                            <>
                                                {t('files.ui.deleteDialog.deleteFile', { name: fileName })}
                                                <br className="mb-2" />
                                                {t('files.ui.deleteDialog.irreversibleQuestion')}
                                            </>
                                        ) : (
                                            t('files.ui.deleteDialog.description')
                                        )}
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex justify-end gap-3 px-6 py-4 border-t border-border bg-muted/30">
                        <Button
                            variant="outline"
                            className="h-10 px-5 text-sm font-medium border-border/80 hover:bg-muted"
                            onClick={isDeleting ? undefined : onClose}
                        >
                            {isPartial ? t('common.actions.close') : t('common.actions.cancel')}
                        </Button>
                        {!isPartial && (
                            <Button
                                className="h-10 px-5 text-sm font-medium bg-red-600 hover:bg-red-700 text-white shadow-sm border border-red-700/50"
                                onClick={handleConfirm}
                                disabled={isDeleting}
                            >
                                {isDeleting ? t('files.ui.deleteDialog.deleting') : t('files.ui.deleteDialog.confirm')}
                            </Button>
                        )}
                    </div>
                </motion.div>
        </Dialog>
    );

    return modalContent;
};
