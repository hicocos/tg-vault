import { motion, AnimatePresence } from "framer-motion";
import { Trash2, X, CheckSquare } from "lucide-react";
import { Button } from "./Button";

interface BulkActionToolbarProps {
    selectedFilesCount: number;
    selectedFoldersCount: number;
    onDelete: () => void;
    onCancel: () => void;
    isVisible: boolean;
}

export const BulkActionToolbar = ({
    selectedFilesCount,
    selectedFoldersCount,
    onDelete,
    onCancel,
    isVisible
}: BulkActionToolbarProps) => {
    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    initial={{ height: 0, opacity: 0, y: -20 }}
                    animate={{ height: "auto", opacity: 1, y: 0 }}
                    exit={{ height: 0, opacity: 0, y: -20 }}
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                    className="z-40 w-full overflow-hidden"
                >
                    <div className="bg-card/60 backdrop-blur-md border border-primary/20 shadow-lg rounded-2xl p-3 flex items-center justify-between gap-4 mb-6">
                        <div className="flex items-center gap-3 pl-1">
                            <div className="bg-primary/10 p-1.5 rounded-lg">
                                <CheckSquare className="h-4 w-4 text-primary" />
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs font-semibold">
                                    选中 {selectedFilesCount + selectedFoldersCount} 项
                                </span>
                                <span className="text-[9px] text-muted-foreground uppercase font-medium">
                                    {selectedFoldersCount} 文件夹 · {selectedFilesCount} 文件
                                </span>
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 px-3 text-xs flex items-center gap-1.5 hover:bg-muted"
                                onClick={onCancel}
                            >
                                <X className="h-3.5 w-3.5" />
                                <span>取消</span>
                            </Button>
                            <Button
                                variant="destructive"
                                size="sm"
                                className="h-8 px-3 text-xs flex items-center gap-1.5 shadow-md shadow-red-500/10"
                                onClick={onDelete}
                                disabled={selectedFilesCount + selectedFoldersCount === 0}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                                <span>删除</span>
                            </Button>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
