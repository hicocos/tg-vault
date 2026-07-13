import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { createPortal } from "react-dom";
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
        <AnimatePresence>
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                    onClick={isDeleting ? undefined : onClose}
                />

                <motion.div
                    initial={{ scale: 0.95, opacity: 0, y: 10 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: 10 }}
                    transition={{ type: "spring", stiffness: 350, damping: 25 }}
                    className="relative w-full max-w-md bg-background border border-border rounded-xl shadow-2xl overflow-hidden z-[70] flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-muted/30">
                        <div className="h-10 w-10 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0">
                            <Trash2 className="h-5 w-5" />
                        </div>
                        <div className="flex flex-col">
                            <h3 className="font-semibold text-lg leading-none tracking-tight">
                                {isPartial ? "部分删除完成" : (t("delete.title") || "确认删除")}
                            </h3>
                            <p className="text-sm text-muted-foreground mt-1.5">
                                {isPartial ? "失败项目仍保留索引并保持选中" : (t("delete.subtitle") || "此操作无法撤销")}
                            </p>
                        </div>
                    </div>

                    <div className="p-6">
                        {isPartial ? (
                            <div className="space-y-3 text-sm">
                                <p className="text-foreground/80">
                                    已删除 <span className="font-semibold">{result.deletedIds.length}</span> 个项目；
                                    <span className="font-semibold text-red-600"> {result.failedFiles.length}</span> 个项目删除失败。
                                </p>
                                <ul className="max-h-48 space-y-2 overflow-auto rounded-lg border border-border bg-muted/20 p-3">
                                    {result.failedFiles.map(file => (
                                        <li key={file.id} className="break-all">
                                            <span className="font-medium">{file.name}</span>
                                            <span className="block text-xs text-muted-foreground">{file.error}</span>
                                        </li>
                                    ))}
                                </ul>
                                <p className="text-xs text-muted-foreground">请关闭后重新预览失败项目再重试；旧确认令牌已消费，不能重复使用。</p>
                            </div>
                        ) : (
                            <div className="flex items-start gap-4">
                                <div className="flex-1">
                                    <p className="text-sm text-foreground/80 leading-relaxed">
                                        {itemCount > 0 ? (
                                            <>
                                                即将永久删除 <span className="font-semibold text-foreground">{dataFileCount}</span> 个数据文件
                                                {totalSizeBytes > 0 && <>，总大小约 <span className="font-semibold text-foreground">{formatDeleteSize(totalSizeBytes)}</span></>}。
                                                {placeholderCount > 0 && (
                                                    <><br />另有 <span className="font-semibold text-foreground">{placeholderCount}</span> 个空文件夹占位符（不计入数据文件和容量）。</>
                                                )}
                                                {folderCount > 0 && (
                                                    <><br />影响 <span className="font-semibold text-foreground">{folderCount}</span> 个当前存储范围内实际存在的文件夹。</>
                                                )}
                                                <br className="mb-2" />
                                                删除后将无法恢复，请确认是否继续？
                                            </>
                                        ) : fileName ? (
                                            <>
                                                即将删除文件 <span className="font-semibold text-foreground break-all">"{fileName}"</span>。
                                                <br className="mb-2" />
                                                删除后将无法恢复，请确认是否继续？
                                            </>
                                        ) : (
                                            t("delete.description") || "确定要永久删除此文件吗？删除后将无法恢复。"
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
                            {isPartial ? "关闭" : (t("delete.cancel") || "取消")}
                        </Button>
                        {!isPartial && (
                            <Button
                                className="h-10 px-5 text-sm font-medium bg-red-600 hover:bg-red-700 text-white shadow-sm border border-red-700/50"
                                onClick={handleConfirm}
                                disabled={isDeleting}
                            >
                                {isDeleting ? "删除中..." : (t("delete.confirm") || "确认删除")}
                            </Button>
                        )}
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );

    return createPortal(modalContent, document.body);
};
