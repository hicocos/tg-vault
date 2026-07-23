import { motion } from "framer-motion";
import { FolderOpen, SearchX, WifiOff, AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import type { FileViewStateKind } from "../../services/fileViewState";

interface EmptyStateProps {
    kind?: FileViewStateKind;
    onRetry?: () => void;
    onClearSearch?: () => void;
    onClearFilter?: () => void;
}

export const EmptyState = ({ kind = 'empty-root', onRetry, onClearSearch, onClearFilter }: EmptyStateProps) => {
    const { t } = useTranslation();
    const key = kind === 'empty-root' ? 'root'
        : kind === 'empty-folder' ? 'folder'
        : kind === 'empty-search' ? 'search'
        : kind === 'empty-filter' ? 'filter'
        : kind;
    const Icon = kind === 'empty-search' ? SearchX
        : kind === 'offline' ? WifiOff
        : kind === 'error' || kind === 'stale' ? AlertTriangle
        : FolderOpen;
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-20 text-center"
            role={kind === 'error' || kind === 'offline' ? 'alert' : 'status'}
        >
            <div className="bg-muted/30 p-6 rounded-full mb-4">
                <Icon className="h-12 w-12 text-muted-foreground/60" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">{t(`empty.${key}.title`)}</h3>
            <p className="text-muted-foreground mt-1 max-w-sm">{t(`empty.${key}.description`)}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
                {(kind === 'offline' || kind === 'error' || kind === 'stale') && onRetry && (
                    <Button variant="outline" onClick={onRetry}><RefreshCw className="h-4 w-4" />{t('empty.retry')}</Button>
                )}
                {kind === 'empty-search' && onClearSearch && <Button variant="outline" onClick={onClearSearch}>{t('empty.clearSearch')}</Button>}
                {kind === 'empty-filter' && onClearFilter && <Button variant="outline" onClick={onClearFilter}>{t('empty.clearFilter')}</Button>}
            </div>
        </motion.div>
    );
};
