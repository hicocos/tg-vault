import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trash2, X, CheckSquare, Share2, Copy, Calendar, Lock, Check } from "lucide-react";
import { Button } from "./Button";
import { errorMessage } from "../../services/unknownError";
import { DatePicker } from "./DatePicker";
import { IndeterminateSpinner } from "./IndeterminateSpinner";
import { useTranslation } from "react-i18next";

import type { StorageCapabilities } from "../../services/api";

interface BulkActionToolbarProps {
    selectedFilesCount: number;
    selectedFoldersCount: number;
    selectedFileId?: string;
    onDelete: () => void;
    onCancel: () => void;
    onShare: (password: string, expiration: string) => Promise<string | null>;
    shareCapabilities?: StorageCapabilities;
    canDelete?: boolean;
    isVisible: boolean;
}

export const BulkActionToolbar = ({
    selectedFilesCount,
    selectedFoldersCount,
    selectedFileId,
    onDelete,
    onCancel,
    onShare,
    shareCapabilities,
    canDelete = true,
    isVisible
}: BulkActionToolbarProps) => {
    const { t } = useTranslation();
    const [showShareSettings, setShowShareSettings] = useState(false);
    const [expiration, setExpiration] = useState("");
    const [password, setPassword] = useState("");
    const [isCopying, setIsCopying] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [selectedExpDate, setSelectedExpDate] = useState<Date | null>(null);

    const [generatedLink, setGeneratedLink] = useState<string | null>(null);

    useEffect(() => {
        setGeneratedLink(null);
        setCopySuccess(false);
        setErrorMsg(null);
        setShowShareSettings(false);
    }, [selectedFileId]);

    // Share is currently only available for exactly one file (not folders).
    const canShare = selectedFilesCount === 1 && selectedFoldersCount === 0 && shareCapabilities?.share === true;
    const shareUnavailableReason = selectedFilesCount !== 1 || selectedFoldersCount !== 0
        ? t('files.ui.share.singleFileOnly')
        : shareCapabilities?.share ? t('files.ui.share.action') : t('files.ui.share.unsupported');

    const handleShareClick = () => {
        if (showShareSettings) {
            setShowShareSettings(false);
            setGeneratedLink(null);
            setErrorMsg(null);
        } else {
            setShowShareSettings(true);
            setExpiration("");
            setSelectedExpDate(null);
            setShowDatePicker(false);
            setPassword("");
            setGeneratedLink(null);
            setErrorMsg(null);
        }
    };

    const handleDateSelect = (date: Date) => {
        setSelectedExpDate(date);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        setExpiration(`${y}/${m}/${d}`);
        setShowDatePicker(false);
    };

    const handleCopyLink = async () => {
        // If we already have a generated link, just copy it
        if (generatedLink) {
            try {
                await navigator.clipboard.writeText(generatedLink);
                setCopySuccess(true);
                setTimeout(() => setCopySuccess(false), 2000);
            } catch (err) {
                console.error("Manual copy failed", err);
                setErrorMsg(t('files.ui.share.copyFailed'));
            }
            return;
        }

        setIsCopying(true);
        setErrorMsg(null);
        try {
            let formattedExpiration = "";
            if (expiration) {
                let date: Date | null = null;
                const cleanDate = expiration.replace(/\D/g, '');

                // Strategy 1: YYYYMMDD (strict 8 digits)
                if (cleanDate === expiration && cleanDate.length === 8) {
                    const year = parseInt(cleanDate.substring(0, 4));
                    const month = parseInt(cleanDate.substring(4, 6)) - 1; // Month is 0-indexed
                    const day = parseInt(cleanDate.substring(6, 8));
                    date = new Date(Date.UTC(year, month, day, 23, 59, 59));
                }
                // Strategy 2: YYYYMMD or YYYYMDD etc (loose digits) - unsafe to guess, better fail
                // Strategy 3: Standard JS Date parsing (for 2024/01/01, 2024-01-01)
                else {
                    const parsed = new Date(expiration);
                    if (!isNaN(parsed.getTime())) {
                        // Set to end of day in UTC
                        date = new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 23, 59, 59));
                    }
                }

                if (date && !isNaN(date.getTime())) {
                    formattedExpiration = date.toISOString();
                } else {
                    throw new Error(t('files.ui.share.invalidDate'));
                }
            }

            const link = await onShare(password, formattedExpiration);
            if (link) {
                setGeneratedLink(link);
                try {
                    await navigator.clipboard.writeText(link);
                    setCopySuccess(true);
                    setTimeout(() => setCopySuccess(false), 2000);
                } catch (err) {
                    console.warn("Auto-copy failed, showing link for manual copy", err);
                    // Don't show error message, just let user see the link
                }
            }
        } catch (err: unknown) {
            console.error("Copy failed", err);
            setErrorMsg(errorMessage(err, t('files.ui.share.createFailed')));
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
                        className="z-40 w-full"
                    >
                        <div className="bg-white dark:bg-zinc-900 border border-primary/20 shadow-lg rounded-2xl p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                            <div className="flex items-center gap-3 pl-1">
                                <div className="bg-primary/10 p-1.5 rounded-lg">
                                    <CheckSquare className="h-4 w-4 text-primary" />
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-xs font-semibold">
                                        {t('files.ui.share.selected', { count: selectedFilesCount + selectedFoldersCount })}
                                    </span>
                                    <span className="text-xs text-muted-foreground uppercase font-medium">
                                        {t('files.ui.share.selectionBreakdown', { folders: selectedFoldersCount, files: selectedFilesCount })}
                                    </span>
                                </div>
                            </div>

                            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-11 px-4 text-sm flex items-center gap-1.5 hover:bg-muted touch-manipulation"
                                    onClick={() => {
                                        setShowShareSettings(false);
                                        onCancel();
                                    }}
                                >
                                    <X className="h-3.5 w-3.5" />
                                    <span>{t('common.actions.cancel')}</span>
                                </Button>

                                <Button
                                    variant={showShareSettings ? "secondary" : "ghost"}
                                    size="sm"
                                    className="h-11 px-4 text-sm flex items-center gap-1.5 hover:bg-primary/10 text-blue-600 hover:text-blue-700 touch-manipulation"
                                    onClick={handleShareClick}
                                    disabled={!canShare}
                                    title={shareUnavailableReason}
                                >
                                    <Share2 className="h-3.5 w-3.5" />
                                    <span>{t('files.ui.share.action')}</span>
                                </Button>

                                {canDelete && <Button
                                    variant="destructive"
                                    size="sm"
                                    className="h-11 px-4 text-sm flex items-center gap-1.5 shadow-md shadow-red-500/10 touch-manipulation"
                                    onClick={onDelete}
                                    disabled={selectedFilesCount + selectedFoldersCount === 0}
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    <span>{t('common.actions.delete')}</span>
                                </Button>}
                            </div>
                        </div>

                        {/* Share Settings Panel */}
                        <AnimatePresence>
                            {showShareSettings && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    className="mt-2"
                                >
                                    <div className="bg-white dark:bg-zinc-900 border border-border shadow-xl rounded-xl p-4 flex flex-col gap-4">

                                        {!generatedLink ? (
                                            <div className="flex items-start md:items-center flex-col md:flex-row gap-4">
                                                {/* Expiration Input */}
                                                {shareCapabilities?.shareExpiration && <div className="flex-1 w-full relative group">
                                                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors">
                                                        <Calendar className="h-4 w-4" />
                                                    </div>
                                                    <div className="relative">
                                                        <input
                                                            type="text"
                                                            value={expiration}
                                                            readOnly
                                                            onClick={() => setShowDatePicker(!showDatePicker)}
                                                            placeholder={t('files.ui.share.expirationPlaceholder')}
                                                            className="w-full h-9 pl-9 pr-3 rounded-lg border border-border bg-background/50 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all hover:bg-background cursor-pointer"
                                                        />
                                                        <AnimatePresence>
                                                            {showDatePicker && (
                                                                <div className="absolute top-full mt-2 left-0 z-[60]">
                                                                    <DatePicker
                                                                        selectedDate={selectedExpDate}
                                                                        onChange={handleDateSelect}
                                                                        onClose={() => setShowDatePicker(false)}
                                                                    />
                                                                </div>
                                                            )}
                                                        </AnimatePresence>
                                                    </div>
                                                </div>}

                                                {/* Password Input */}
                                                {shareCapabilities?.sharePassword && <div className="flex-1 w-full relative group">
                                                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors">
                                                        <Lock className="h-4 w-4" />
                                                    </div>
                                                    <input
                                                        type="text"
                                                        value={password}
                                                        onChange={(e) => setPassword(e.target.value)}
                                                        placeholder={t('files.ui.share.passwordPlaceholder')}
                                                        className="w-full h-9 pl-9 pr-3 rounded-lg border border-border bg-background/50 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all hover:bg-background"
                                                    />
                                                </div>}

                                                {/* Copy/Generate Button */}
                                                <Button
                                                    size="sm"
                                                    className={`h-9 min-w-[100px] shrink-0 font-medium transition-all ${copySuccess ? 'bg-green-500 hover:bg-green-600 text-white' : ''}`}
                                                    onClick={handleCopyLink}
                                                    disabled={isCopying}
                                                >
                                                    {isCopying ? (
                                                        <span className="flex items-center gap-2">
                                                            <IndeterminateSpinner label={t('files.ui.share.generatingLabel')} size="sm" tone="current" />
                                                            {t('files.ui.share.generating')}
                                                        </span>
                                                    ) : (
                                                        <span className="flex items-center gap-2">
                                                            <Copy className="h-4 w-4" />
                                                            {t('files.ui.share.generate')}
                                                        </span>
                                                    )}
                                                </Button>
                                            </div>
                                        ) : (
                                            <div className="flex flex-col gap-3">
                                                <div className="flex items-center gap-3">
                                                    <div className="flex-1 relative group">
                                                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors text-primary">
                                                            <Share2 className="h-4 w-4" />
                                                        </div>
                                                        <input
                                                            type="text"
                                                            value={generatedLink}
                                                            readOnly
                                                            className="w-full h-9 pl-9 pr-3 rounded-lg border border-primary/30 bg-primary/5 text-sm text-primary font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 hover:bg-primary/10 select-all"
                                                        />
                                                    </div>
                                                    <Button
                                                        size="sm"
                                                        className={`h-9 min-w-[100px] shrink-0 font-medium transition-all ${copySuccess ? 'bg-green-500 hover:bg-green-600 text-white' : ''}`}
                                                        onClick={handleCopyLink}
                                                    >
                                                        {copySuccess ? (
                                                            <span className="flex items-center gap-2">
                                                                <Check className="h-4 w-4" />
                                                                {t('files.ui.share.copied')}
                                                            </span>
                                                        ) : (
                                                            <span className="flex items-center gap-2">
                                                                <Copy className="h-4 w-4" />
                                                                {t('files.ui.share.copy')}
                                                            </span>
                                                        )}
                                                    </Button>
                                                </div>
                                                <div className="text-[10px] text-green-600 dark:text-green-400 px-1 font-medium">
                                                    {t('files.ui.share.ready')}
                                                </div>
                                            </div>
                                        )}

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

                                        {!generatedLink && (
                                            <div className="text-[10px] text-muted-foreground/60 px-1">
                                                {t('files.ui.share.providerHint')}
                                            </div>
                                        )}
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
