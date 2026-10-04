import { useState, useCallback, useRef } from "react";
import { UploadCloud, File as FileIcon } from "./icons";
import { cn } from "../../lib/utils";
import { useTranslation } from "react-i18next";
import type { UploadCapabilities } from "../../services/api";
import { IndeterminateSpinner } from "./IndeterminateSpinner";

interface UploadZoneProps {
    onDrop?: (files: File[]) => void;
    uploading?: boolean;
    uploadProgress?: number;
    capabilities?: UploadCapabilities | null;
    destinationLabel?: string;
    disabled?: boolean;
}

export const UploadZone = ({ onDrop, uploading = false, uploadProgress = 0, destinationLabel, disabled = false }: UploadZoneProps) => {
    const [isDragActive, setIsDragActive] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepth = useRef(0);
    const { t } = useTranslation();
    const chooseLabel = t('uiAudit.choose');
    const progress = Math.max(0, Math.min(100, uploadProgress));

    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragDepth.current += 1;
        if (!disabled) setIsDragActive(true);
    }, [disabled]);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setIsDragActive(false);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragDepth.current = 0;
        setIsDragActive(false);
        if (disabled) return;
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) onDrop?.(Array.from(e.dataTransfer.files));
    }, [disabled, onDrop]);

    const handleClick = () => {
        if (!disabled) fileInputRef.current?.click();
    };
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
        }
    };
    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!disabled && e.target.files && e.target.files.length > 0) {
            onDrop?.(Array.from(e.target.files));
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
            onKeyDown={handleKeyDown}
            role="button"
            tabIndex={disabled ? -1 : 0}
            className={cn('op-drop-zone', isDragActive && 'is-dragging', disabled && 'is-disabled')}
            aria-label={chooseLabel}
            aria-disabled={disabled}
        >
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} onClick={event => event.stopPropagation()} disabled={disabled} />
            <div className="op-upload-symbol">
                {uploading ? <IndeterminateSpinner label={t('files.ui.uploadZone.processing')} size="md" /> : <UploadCloud className="h-6 w-6" />}
            </div>
            <div className="op-drop-copy">
                {uploading && <h3 role="status">{t('upload.uploading', { percent: progress })}</h3>}
                <p>{uploading ? t('upload.keepUsing') : t('uiAudit.uploadHint')}</p>
            </div>
            <span className="op-drop-choose"><FileIcon className="h-4 w-4" />{isDragActive ? t('files.ui.uploadZone.release') : chooseLabel}</span>
            <p className="op-drop-support">{t('upload.anyFile')}<span className="op-drop-desktop-hint"> · {t('uiAudit.uploadDrag')}</span></p>
            {destinationLabel && <small className="op-drop-target">{t('files.ui.uploadZone.destination', { destination: destinationLabel })}</small>}
            {uploading && (
                <div className="op-drop-progress op-progress" role="progressbar" aria-label={t('files.ui.uploadZone.processing')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                    <span style={{ width: `${progress}%` }} />
                </div>
            )}
        </div>
    );
};
