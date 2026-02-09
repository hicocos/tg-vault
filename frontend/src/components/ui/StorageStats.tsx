import { HardDrive, FileStack } from "lucide-react";
import type { StorageStats as StorageStatsType } from "../../services/api";

interface StorageStatsProps {
    stats: StorageStatsType;
    compact?: boolean;
}

export const StorageStats = ({ stats, compact = false }: StorageStatsProps) => {
    if (compact) {
        return (
            <div className="space-y-3">
                {/* Server Storage */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                            <HardDrive className="h-3.5 w-3.5" />
                            服务器
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

                {/* FoomClous Usage */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                            <FileStack className="h-3.5 w-3.5" />
                            FoomClous
                        </span>
                        <span className="font-medium">{stats.foomclous.fileCount} 个文件</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                            className="h-full bg-blue-500 rounded-full transition-all duration-500"
                            style={{ width: `${Math.min(stats.foomclous.usedPercent, 100)}%` }}
                        />
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                        已用 {stats.foomclous.used}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
            <h4 className="font-semibold text-sm flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-primary" />
                存储空间
            </h4>

            {/* Server Storage */}
            <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">服务器容量</span>
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

            {/* FoomClous Usage */}
            <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">FoomClous 使用</span>
                    <span className="font-medium">{stats.foomclous.used}</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                        className="h-full bg-blue-500 rounded-full transition-all duration-500"
                        style={{ width: `${Math.min(stats.foomclous.usedPercent, 100)}%` }}
                    />
                </div>
                <p className="text-xs text-muted-foreground">
                    共 {stats.foomclous.fileCount} 个文件
                </p>
            </div>
        </div>
    );
};
