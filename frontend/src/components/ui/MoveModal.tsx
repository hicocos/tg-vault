import { motion, AnimatePresence } from "framer-motion";
import { Folder, FolderRoot, X, Check, ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { FolderMovePreview } from "../../services/api";

interface MoveModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (destinationFolder: string | null) => void;
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

    useEffect(() => {
        if (isOpen) {
            setSelectedFolder(currentFolder);
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
                if (error?.name !== 'AbortError') setPreviewError(error?.message || '无法获取移动预览');
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
    const formatBytes = (bytes: number) => {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        return `${(bytes / (1024 ** unit)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
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
                            <ArrowRight className="h-5 w-5" />
                        </div>
                        <div className="flex flex-col flex-1">
                            <h3 className="font-semibold text-lg leading-none tracking-tight">
                                {title || t("app.moveTo") || "移动到"}
                            </h3>
                            <p className="text-sm text-muted-foreground mt-1.5">选择目标文件夹位置</p>
                        </div>
                        <button
                            onClick={onClose}
                            className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-muted transition-colors"
                        >
                            <X className="h-4 w-4 text-muted-foreground" />
                        </button>
                    </div>

                    {/* Current location hint */}
                    {currentFolder && (
                        <div className="px-6 py-3 border-b border-border/50 bg-muted/10">
                            <div className="flex items-center gap-2 text-xs">
                                <span className="text-muted-foreground font-medium">当前位置:</span>
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
                                <p className="text-muted-foreground">正在检查最终路径和冲突...</p>
                            ) : previewError ? (
                                <p className="text-destructive">{previewError}</p>
                            ) : preview ? (
                                <div className="space-y-1.5">
                                    <p><span className="text-muted-foreground">最终路径：</span><strong>{preview.finalPath}</strong></p>
                                    <p className="text-muted-foreground">将移动 {preview.folderCount} 个目录、{preview.fileCount} 个文件（{formatBytes(preview.totalSizeBytes)}）</p>
                                    {preview.conflict && <p className="text-destructive">{preview.conflictReason}</p>}
                                </div>
                            ) : null}
                        </div>
                    )}

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
                                    {t("app.rootDirectory") || "根目录"}
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
                                    <p className="text-xs">{t("app.noOtherFolders") || "暂无其它文件夹"}</p>
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
                        >
                            {t("app.cancel") || "取消"}
                        </Button>
                        <Button 
                            onClick={() => {
                                onConfirm(selectedFolder);
                                onClose();
                            }} 
                            className="h-10 px-5 text-sm font-medium shadow-sm"
                            disabled={!canConfirm}
                        >
                            {t("app.confirm") || "确认移动"}
                        </Button>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );

    return createPortal(modalContent, document.body);
};
