import { useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { UploadCloud, File as FileIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { useTranslation } from "react-i18next";
import type { UploadCapabilities } from "../../services/api";
import { IndeterminateSpinner } from "./IndeterminateSpinner";

interface UploadZoneProps {
    onDrop?: (files: File[]) => void;
    uploading?: boolean;
    uploadProgress?: number;
    capabilities?: UploadCapabilities | null;
}

function formatGiB(bytes: number): string {
    const value = bytes / 1024 / 1024 / 1024;
    return `${Number.isInteger(value) ? value : value.toFixed(1)} GiB`;
}

export const UploadZone = ({ onDrop, uploading = false, uploadProgress = 0, capabilities }: UploadZoneProps) => {
    const [isDragActive, setIsDragActive] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { t } = useTranslation();

    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragActive(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragActive(false);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragActive(false);

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const files = Array.from(e.dataTransfer.files);
            onDrop?.(files);
        }
    }, [onDrop]);

    const handleClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const files = Array.from(e.target.files);
            onDrop?.(files);
            // 重置 input 以便可以再次选择同一文件
            e.target.value = '';
        }
    };

    return (
        <div
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={handleClick}
            className={cn(
                "relative group flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border py-10 px-4 text-center transition-all duration-300 ease-out cursor-pointer overflow-hidden",
                isDragActive
                    ? "border-primary bg-primary/5 scale-[1.01]"
                    : "hover:border-primary/50 hover:bg-accent/30"
            )}
            aria-label={t("app.dropTitle")}
        >
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
            />

            <div className="absolute inset-0 bg-grid-slate-100 [mask-image:linear-gradient(0deg,#fff,rgba(255,255,255,0.6))] dark:bg-grid-slate-700/25 pointer-events-none" />

            {/* 上传进度条 */}
            {uploading && uploadProgress > 0 && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-muted overflow-hidden">
                    <motion.div
                        className="h-full bg-primary"
                        initial={{ width: 0 }}
                        animate={{ width: `${uploadProgress}%` }}
                        transition={{ duration: 0.3 }}
                    />
                </div>
            )}

            <motion.div
                animate={{
                    scale: isDragActive ? 1.1 : 1,
                    y: isDragActive ? -5 : 0
                }}
                className="z-10 bg-background p-4 rounded-full shadow-sm mb-4 ring-1 ring-border group-hover:shadow-md transition-shadow"
            >
                {uploading ? (
                    <IndeterminateSpinner label="正在处理上传" size="lg" />
                ) : (
                    <UploadCloud className={cn("h-8 w-8 transition-colors", isDragActive ? "text-primary" : "text-muted-foreground")} />
                )}
            </motion.div>

            <div className="z-10 flex flex-col gap-1">
                <h3 className="text-lg font-semibold tracking-tight">
                    {uploading
                        ? t("upload.uploading", { percent: uploadProgress })
                        : isDragActive
                            ? t("app.dropActive")
                            : t("app.dropTitle")
                    }
                </h3>
                <p className="text-sm text-muted-foreground">
                    {uploading
                        ? t("upload.keepUsing")
                        : capabilities
                            ? `${t("upload.anyFile")} · 超过 ${Math.round(capabilities.simpleUploadThresholdBytes / 1024 / 1024)} MiB 自动分片 · 最大 ${formatGiB(capabilities.maxChunkUploadBytes)}`
                            : `${t("upload.anyFile")} · 上传限制加载中…`
                    }
                </p>
            </div>

            <AnimatePresence>
                {isDragActive && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-primary/10 backdrop-blur-[1px] flex items-center justify-center"
                    >
                        <motion.div
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            className="bg-background px-6 py-3 rounded-full shadow-lg font-medium text-primary flex items-center gap-2"
                        >
                            <FileIcon className="h-4 w-4" />
                            {t("app.release") || "放开以上传"}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
