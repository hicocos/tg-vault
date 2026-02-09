import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { FileText, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "./Button";
import { cn } from "../../lib/utils";
import { useEffect, useState } from "react";

export interface QueueItem {
    id: string;
    file: File;
    status: 'pending' | 'uploading' | 'completed' | 'error';
    progress: number;
    error?: string;
}

interface UploadQueueModalProps {
    isOpen: boolean;
    onClose: () => void;
    items: QueueItem[];
}

export const UploadQueueModal = ({ isOpen, onClose, items }: UploadQueueModalProps) => {
    const [isComplete, setIsComplete] = useState(false);

    // 检查是否全部完成
    useEffect(() => {
        if (items.length > 0 && items.every(item => item.status === 'completed' || item.status === 'error')) {
            setIsComplete(true);
        } else {
            setIsComplete(false);
        }
    }, [items]);

    // 计算总体完成进度
    const completedCount = items.filter(i => i.status === 'completed' || i.status === 'error').length;
    const totalCount = items.length;

    if (!isOpen) return null;

    const modalContent = (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* 背景遮罩 - 可选，目前设为透明以便用户可以看到后面 */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/50"
                onClick={() => {
                    // 禁用点击背景关闭，强制手动关闭
                }}
            />

            <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="relative z-50 bg-background border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
            >
                {/* 头部 */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/30">
                    <div className="flex flex-col gap-1">
                        <h3 className="font-semibold text-lg flex items-center gap-2">
                            {isComplete
                                ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                                : <Loader2 className="w-5 h-5 text-primary animate-spin" />
                            }
                            {isComplete ? "上传完成" : "正在上传..."}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                            {completedCount} / {totalCount} 个文件
                        </p>
                    </div>
                </div>

                {/* 列表内容 */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <AnimatePresence>
                        {items.map((item) => (
                            <motion.div
                                key={item.id}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-card/50 hover:bg-card transition-colors"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="h-8 w-8 shrink-0 rounded bg-muted flex items-center justify-center">
                                        <FileText className="w-4 h-4 text-muted-foreground" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium truncate" title={item.file.name}>{item.file.name}</p>
                                        <div className="flex justify-between items-center mt-1">
                                            <span className={cn(
                                                "text-xs shrink-0 font-medium",
                                                item.status === 'completed' && "text-green-500",
                                                item.status === 'error' && "text-red-500",
                                                item.status === 'uploading' && "text-primary"
                                            )}>
                                                {item.status === 'completed' && "完成"}
                                                {item.status === 'error' && "失败"}
                                                {item.status === 'uploading' && `${item.progress}%`}
                                                {item.status === 'pending' && "等待中"}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="shrink-0">
                                        {item.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-green-500" />}
                                        {item.status === 'error' && <AlertCircle className="w-5 h-5 text-red-500" />}
                                        {item.status === 'uploading' && <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />}
                                    </div>
                                </div>

                                {/* 进度条 */}
                                {(item.status === 'uploading' || item.progress > 0) && (
                                    <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
                                        <motion.div
                                            className={cn(
                                                "h-full rounded-full",
                                                item.status === 'error' ? "bg-red-500" : "bg-primary"
                                            )}
                                            initial={{ width: 0 }}
                                            animate={{ width: `${item.progress}%` }}
                                            transition={{ duration: 0.1 }}
                                        />
                                    </div>
                                )}
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </div>

                {/* 底部 - 只有在全部完成时显示关闭按钮 */}
                {isComplete && (
                    <div className="p-4 border-t border-border bg-muted/30 flex justify-end">
                        <Button onClick={onClose} className="w-full sm:w-auto min-w-[100px]">
                            关闭
                        </Button>
                    </div>
                )}
            </motion.div>
        </div>
    );

    return createPortal(modalContent, document.body);
};
