import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import type { StorageStats } from "../../services/api";

interface StorageWidgetProps {
    stats?: StorageStats | null;
    // Legacy props for backwards compatibility
    used?: number;
    total?: number;
}

export const StorageWidget = ({ stats, used, total }: StorageWidgetProps) => {
    const { t } = useTranslation();

    // Use new stats if available, otherwise fall back to legacy props
    if (stats) {
        return (
            <div className="rounded-xl bg-muted/40 p-4 border border-border/50 space-y-3">
                {/* Server Storage */}
                <div>
                    <div className="flex items-center justify-between mb-1.5">
                        <h4 className="text-xs font-medium text-muted-foreground">服务器</h4>
                        <span className="text-xs text-muted-foreground">{stats.server.usedPercent}%</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                        <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${stats.server.usedPercent}%` }}
                            transition={{ duration: 1, ease: "easeOut" }}
                            className={`h-full rounded-full ${stats.server.usedPercent > 90 ? 'bg-red-500' :
                                    stats.server.usedPercent > 70 ? 'bg-yellow-500' : 'bg-primary'
                                }`}
                        />
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                        {stats.server.used} / {stats.server.total}
                    </p>
                </div>

                {/* FoomClous Usage */}
                <div>
                    <div className="flex items-center justify-between mb-1.5">
                        <h4 className="text-xs font-medium text-muted-foreground">FoomClous</h4>
                        <span className="text-xs text-muted-foreground">{stats.foomclous.fileCount} 文件</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                        <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.min(stats.foomclous.usedPercent, 100)}%` }}
                            transition={{ duration: 1, ease: "easeOut" }}
                            className="h-full bg-blue-500 rounded-full"
                        />
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                        已用 {stats.foomclous.used}
                    </p>
                </div>
            </div>
        );
    }

    // Legacy mode
    const percentage = used && total ? Math.min((used / total) * 100, 100) : 0;

    return (
        <div className="rounded-xl bg-muted/40 p-4 border border-border/50">
            <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium">{t("sidebar.storage.uc")}</h4>
                <span className="text-xs text-muted-foreground">{Math.round(percentage)}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
                <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${percentage}%` }}
                    transition={{ duration: 1, ease: "easeOut" }}
                    className="h-full bg-primary rounded-full"
                />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
                {t("sidebar.storage.used", { used, total })}
            </p>
        </div>
    );
};
