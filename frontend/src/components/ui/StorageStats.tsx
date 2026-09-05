import { HardDrive, FileStack } from "lucide-react";
import type { StorageStats as StorageStatsType } from "../../services/api";
import { useTranslation } from "react-i18next";

interface StorageStatsProps {
    stats: StorageStatsType;
    compact?: boolean;
}

export const StorageStats = ({ stats, compact = false }: StorageStatsProps) => {
    const { t } = useTranslation();
    if (compact) {
        return (
            <div className="space-y-3">
                {/* Server Storage */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                            <HardDrive className="h-3.5 w-3.5" />
                            {t('files.ui.storage.server')}
                        </span>
                        <span className="font-medium">{stats.server.usedPercent}%</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                            className="h-full bg-primary rounded-full transition-all duration-500"
                            style={{ width: `${stats.server.usedPercent}%` }}
                        />
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                        {stats.server.used} / {stats.server.total}
                    </p>
                </div>

                {/* TG Vault Usage */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                            <FileStack className="h-3.5 w-3.5" />
                            TG Vault
                        </span>
                        <span className="font-medium">{t('files.ui.storage.fileCount', { count: stats.tgvault.fileCount })}</span>
                    </div>
                {/* Indexed usage deliberately has no percentage unless a remote quota exists. */}
                    <p className="text-[10px] text-muted-foreground">
                        {t('files.ui.storage.used', { value: stats.tgvault.used })}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
            <h4 className="font-semibold text-sm flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-primary" />
                {t('files.ui.storage.title')}
            </h4>

            {/* Server Storage */}
            <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('files.ui.storage.serverCapacity')}</span>
                    <span className="font-medium">{stats.server.used} / {stats.server.total}</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                        className={`h-full rounded-full transition-all duration-500 ${stats.server.usedPercent > 90 ? 'bg-red-500' :
                                stats.server.usedPercent > 70 ? 'bg-yellow-500' : 'bg-primary'
                            }`}
                        style={{ width: `${stats.server.usedPercent}%` }}
                    />
                </div>
            </div>

            {/* TG Vault Usage */}
            <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('files.ui.storage.vaultUsage')}</span>
                    <span className="font-medium">{stats.tgvault.used}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                    {t('files.ui.storage.fileCount', { count: stats.tgvault.fileCount })}
                </p>
            </div>
        </div>
    );
};
