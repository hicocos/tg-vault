import { useEffect, useState } from "react";
import { Trash2, X, CheckSquare, Share2, Copy, Calendar, Lock, Check, FolderInput } from "./icons";
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
    onMove?: () => void;
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
    onMove,
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
    }, [selectedFileId, selectedFilesCount, selectedFoldersCount]);

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

    if (!isVisible) return null;

    return (
        <section className="tv-bulk-toolbar" aria-label={t('files.ui.share.selected', { count: selectedFilesCount + selectedFoldersCount })}>
            <div className="tv-bulk-summary-row">
                <div className="tv-bulk-summary">
                    <CheckSquare aria-hidden="true" />
                    <div><strong>{t('files.ui.share.selected', { count: selectedFilesCount + selectedFoldersCount })}</strong><span>{t('files.ui.share.selectionBreakdown', { folders: selectedFoldersCount, files: selectedFilesCount })}</span></div>
                </div>
                <div className="tv-bulk-actions">
                    {onMove && <Button variant="outline" size="sm" onClick={onMove} disabled={selectedFilesCount + selectedFoldersCount !== 1} title={t('files.moveSingleOnly')}><FolderInput aria-hidden="true" />{t('files.ui.actions.move')}</Button>}
                    <Button variant={showShareSettings ? 'secondary' : 'outline'} size="sm" onClick={handleShareClick} disabled={!canShare} title={shareUnavailableReason} aria-expanded={showShareSettings}>
                        <Share2 aria-hidden="true" />{t('files.ui.share.action')}
                    </Button>
                    {canDelete && <Button variant="destructive-outline" size="sm" onClick={onDelete} disabled={selectedFilesCount + selectedFoldersCount === 0}><Trash2 aria-hidden="true" />{t('common.actions.delete')}</Button>}
                    <Button variant="ghost" size="sm" onClick={() => { setShowShareSettings(false); onCancel(); }}><X aria-hidden="true" />{t('common.actions.cancel')}</Button>
                </div>
            </div>

            {showShareSettings && canShare && (
                <div className="tv-bulk-share-panel">
                    {!generatedLink ? (
                        <div className="tv-bulk-share-fields">
                            {shareCapabilities?.shareExpiration && <div className="tv-bulk-date-field">
                                <Button type="button" variant="outline" className="tv-bulk-date-trigger" onClick={() => setShowDatePicker(!showDatePicker)} aria-expanded={showDatePicker}>
                                    <Calendar aria-hidden="true" /><span>{expiration || t('files.ui.share.expirationPlaceholder')}</span>
                                </Button>
                                {showDatePicker && <div className="tv-bulk-date-popover"><DatePicker selectedDate={selectedExpDate} onChange={handleDateSelect} onClose={() => setShowDatePicker(false)} /></div>}
                            </div>}
                            {shareCapabilities?.sharePassword && <label className="tv-bulk-password-field">
                                <Lock aria-hidden="true" />
                                <input type="text" value={password} onChange={event => setPassword(event.target.value)} placeholder={t('files.ui.share.passwordPlaceholder')} aria-label={t('files.ui.share.passwordPlaceholder')} />
                            </label>}
                            <Button size="sm" onClick={() => void handleCopyLink()} disabled={isCopying}>
                                {isCopying ? <><IndeterminateSpinner label={t('files.ui.share.generatingLabel')} size="sm" tone="current" />{t('files.ui.share.generating')}</> : <><Copy aria-hidden="true" />{t('files.ui.share.generate')}</>}
                            </Button>
                        </div>
                    ) : (
                        <div className="tv-bulk-link-result">
                            <div className="tv-bulk-link-field"><Share2 aria-hidden="true" /><input type="text" value={generatedLink} readOnly aria-label={t('files.ui.share.ready')} onFocus={event => event.target.select()} /></div>
                            <Button size="sm" onClick={() => void handleCopyLink()}>{copySuccess ? <><Check aria-hidden="true" />{t('files.ui.share.copied')}</> : <><Copy aria-hidden="true" />{t('files.ui.share.copy')}</>}</Button>
                            <p className="tv-bulk-success" role="status">{t('files.ui.share.ready')}</p>
                        </div>
                    )}
                    {errorMsg && <p className="tv-file-error" role="alert">{errorMsg}</p>}
                    {!generatedLink && <p className="tv-bulk-hint">{t('files.ui.share.providerHint')}</p>}
                </div>
            )}
        </section>
    );
};
