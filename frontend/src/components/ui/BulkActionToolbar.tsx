import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trash2, X, CheckSquare, Share2, Copy, Calendar, Lock, Check } from "lucide-react";
import { Button } from "./Button";

interface BulkActionToolbarProps {
    selectedFilesCount: number;
    selectedFoldersCount: number;
    onDelete: () => void;
    onCancel: () => void;
    onShare: (password: string, expiration: string) => Promise<string | null>;
    isVisible: boolean;
}

export const BulkActionToolbar = ({
    selectedFilesCount,
    selectedFoldersCount,
    onDelete,
    onCancel,
    onShare,
    isVisible
}: BulkActionToolbarProps) => {
    const [showShareSettings, setShowShareSettings] = useState(false);
    const [expiration, setExpiration] = useState("");
    const [password, setPassword] = useState("");
    const [isCopying, setIsCopying] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Share is only available when exactly one item is selected
    const canShare = selectedFilesCount + selectedFoldersCount === 1;

    const handleShareClick = () => {
        if (showShareSettings) {
            setShowShareSettings(false);
            setErrorMsg(null);
        } else {
            setShowShareSettings(true);
            setExpiration("");
            setPassword("");
            setErrorMsg(null);
        }
    };

    const handleCopyLink = async () => {
        setIsCopying(true);
        setErrorMsg(null);
        try {
            const link = await onShare(password, expiration);
            if (link) {
                await navigator.clipboard.writeText(link);
                setCopySuccess(true);
                setTimeout(() => setCopySuccess(false), 2000);
                setTimeout(() => setShowShareSettings(false), 3000); // Auto close after success
            }
        } catch (err: any) {
            console.error("Copy failed", err);
            setErrorMsg(err.message || "创建链接失败");
        } finally {
            setIsCopying(false);
        }
    };

    return (
        <AnimatePresence>
            {isVisible && (
                <div className="w-full">
                    <motion.div
                        initial={{ height: 0, opacity: 0, y: -20 }}
                        animate={{ height: "auto", opacity: 1, y: 0 }}
                        exit={{ height: 0, opacity: 0, y: -20 }}
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                        className="z-40 w-full overflow-hidden"
                    >
                        <div className="bg-card/60 backdrop-blur-md border border-primary/20 shadow-lg rounded-2xl p-3 flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3 pl-1">
                                <div className="bg-primary/10 p-1.5 rounded-lg">
                                    <CheckSquare className="h-4 w-4 text-primary" />
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-xs font-semibold">
                                        选中 {selectedFilesCount + selectedFoldersCount} 项
                                    </span>
                                    <span className="text-xs text-muted-foreground uppercase font-medium">
                                        {selectedFoldersCount} 文件夹 · {selectedFilesCount} 文件
                                    </span>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 px-3 text-xs flex items-center gap-1.5 hover:bg-muted"
                                    onClick={() => {
                                        setShowShareSettings(false);
                                        onCancel();
                                    }}
                                >
                                    <X className="h-3.5 w-3.5" />
                                    <span>取消</span>
                                </Button>

                                <Button
                                    variant={showShareSettings ? "secondary" : "ghost"}
                                    size="sm"
                                    className="h-8 px-3 text-xs flex items-center gap-1.5 hover:bg-primary/10 text-blue-600 hover:text-blue-700"
                                    onClick={handleShareClick}
                                    disabled={!canShare}
                                    title={!canShare ? "请选择单个文件或文件夹进行分享" : "分享"}
                                >
                                    <Share2 className="h-3.5 w-3.5" />
                                    <span>分享</span>
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

                        {/* Share Settings Panel */}
                        <AnimatePresence>
                            {showShareSettings && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    className="overflow-hidden mt-2"
                                >
                                    <div className="bg-card/90 backdrop-blur-xl border border-border shadow-xl rounded-xl p-4 flex flex-col gap-4">
                                        <div className="flex items-start md:items-center flex-col md:flex-row gap-4">
                                            {/* Expiration Input */}
                                            <div className="flex-1 w-full relative group">
                                                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors">
                                                    <Calendar className="h-4 w-4" />
                                                </div>
                                                <input
                                                    type="text"
                                                    value={expiration}
                                                    onChange={(e) => setExpiration(e.target.value)}
                                                    placeholder="YYYY/MM/DD (过期时间)"
                                                    className="w-full h-9 pl-9 pr-3 rounded-lg border border-border bg-background/50 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all hover:bg-background"
                                                />
                                            </div>

                                            {/* Password Input */}
                                            <div className="flex-1 w-full relative group">
                                                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors">
                                                    <Lock className="h-4 w-4" />
                                                </div>
                                                <input
                                                    type="text"
                                                    value={password}
                                                    onChange={(e) => setPassword(e.target.value)}
                                                    placeholder="设置访问密码 (可选)"
                                                    className="w-full h-9 pl-9 pr-3 rounded-lg border border-border bg-background/50 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all hover:bg-background"
                                                />
                                            </div>

                                            {/* Copy Button */}
                                            <Button
                                                size="sm"
                                                className={`h-9 min-w-[100px] shrink-0 font-medium transition-all ${copySuccess ? 'bg-green-500 hover:bg-green-600 text-white' : ''}`}
                                                onClick={handleCopyLink}
                                                disabled={isCopying}
                                            >
                                                {isCopying ? (
                                                    <span className="flex items-center gap-2">
                                                        <div className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                                                        生成中...
                                                    </span>
                                                ) : copySuccess ? (
                                                    <span className="flex items-center gap-2">
                                                        <Check className="h-4 w-4" />
                                                        已复制
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-2">
                                                        <Copy className="h-4 w-4" />
                                                        复制链接
                                                    </span>
                                                )}
                                            </Button>
                                        </div>

                                        {/* Error Message */}
                                        {errorMsg && (
                                            <motion.div
                                                initial={{ opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: "auto" }}
                                                className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg"
                                            >
                                                {errorMsg}
                                            </motion.div>
                                        )}

                                        <div className="text-[10px] text-muted-foreground/60 px-1">
                                            * 如果 OneDrive 账户不支持密码/日期设置，请留空直接生成
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
