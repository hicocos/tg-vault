import { motion } from "framer-motion";
import { Folder, Image as ImageIcon, Video, Music, FileText, Star, MoreVertical } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { type FileData } from "../../services/api";
import { ContextMenu, createFolderMenuItems } from "./ContextMenu";
import { useLongPress } from "../../hooks/useLongPress";

export interface FolderData {
    name: string;
    files: FileData[];
    fileCount: number;
    coverFile?: FileData; // 用于显示缩略图的文件（第一个有缩略图的文件）
    latestDate?: string;
}

const getFileTypeIcon = (type: FileData["type"]) => {
    switch (type) {
        case "image": return <ImageIcon className="h-3.5 w-3.5 text-blue-400" />;
        case "video": return <Video className="h-3.5 w-3.5 text-purple-400" />;
        case "audio": return <Music className="h-3.5 w-3.5 text-pink-400" />;
        case "document": return <FileText className="h-3.5 w-3.5 text-orange-400" />;
        default: return <FileText className="h-3.5 w-3.5 text-gray-400" />;
    }
};

export const FolderCard = ({
    folder,
    onClick,
    onRename,
    onToggleFavorite,
    onDelete,
    onMove,
    isSelectionMode = false,
    isSelected = false,
    onSelect
}: {
    folder: FolderData;
    onClick: () => void;
    onRename?: () => void;
    onToggleFavorite?: () => void;
    onDelete?: () => void;
    onMove?: () => void;
    isSelectionMode?: boolean;
    isSelected?: boolean;
    onSelect?: (name: string) => void;
}) => {
    const { t } = useTranslation();

    // Context menu state
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

    // 获取封面缩略图
    const coverFile = folder.coverFile;
    const thumbnailSrc = coverFile?.thumbnailUrl || (coverFile?.type === 'image' ? coverFile?.previewUrl : undefined);

    // 统计各类型文件数量（排除占位文件）
    const typeCounts = folder.files.reduce((acc, file) => {
        if (file.name !== '.folder') {
            acc[file.type] = (acc[file.type] || 0) + 1;
        }
        return acc;
    }, {} as Record<string, number>);

    const isFavorite = folder.files.length > 0 && folder.files.every(f => !!f.is_favorite);

    const handleCardClick = () => {
        if (isSelectionMode) {
            onSelect?.(folder.name);
        } else {
            onClick();
        }
    };

    const handleContextMenu = (e: any) => {
        if (isSelectionMode) return;
        
        if (e.preventDefault) {
            e.preventDefault();
        }
        e.stopPropagation?.();
        
        const clientX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
        const clientY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
        
        setContextMenu({ x: clientX, y: clientY });
    };

    const longPressHandlers = useLongPress({
        onLongPress: (e) => handleContextMenu(e),
        onClick: () => handleCardClick(),
        threshold: 500
    });

    return (
        <>
            <motion.div
                layout
                whileHover={{ y: isSelectionMode ? 0 : -4, transition: { duration: 0.2 } }}
                className={`group relative flex flex-col rounded-2xl border ${isSelected ? 'border-primary ring-2 ring-primary/20 bg-primary/5' : 'border-border/50 bg-card'} overflow-hidden shadow-sm transition-all ${!isSelectionMode ? 'hover:shadow-lg hover:border-primary/30 cursor-pointer' : 'cursor-default'}`}
                {...(!isSelectionMode ? longPressHandlers : { onClick: handleCardClick })}
                onContextMenu={handleContextMenu}
            >
                {/* 封面区域 - 使用 4:3 比例 */}
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-gradient-to-br from-primary/5 to-primary/15 flex items-center justify-center">
                    {thumbnailSrc ? (
                        <>
                            <img
                                src={thumbnailSrc}
                                alt={folder.name}
                                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110 opacity-90"
                                loading="lazy"
                            />
                            {/* 渐变遮罩，使底部文字更清晰 */}
                            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-60" />
                        </>
                    ) : (
                        <div className="flex flex-col items-center gap-2">
                            <Folder className="h-12 w-12 text-primary/40 group-hover:text-primary/60 transition-colors" />
                        </div>
                    )}

                    {!isSelectionMode && isFavorite && (
                        <div className="absolute top-2 right-2 bg-yellow-400/90 backdrop-blur-md p-1.5 rounded-full border border-yellow-300/50 shadow-sm z-10">
                            <Star className="h-3 w-3 text-yellow-700 fill-current" />
                        </div>
                    )}

                    {/* Selection Checkbox */}
                    {isSelectionMode && (
                        <div
                            className="absolute bottom-2.5 right-2.5 z-20"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div
                                className={`h-6 w-6 rounded-full border-2 flex items-center justify-center transition-all cursor-pointer ${isSelected ? 'bg-primary border-primary' : 'bg-black/20 border-white/50 backdrop-blur-sm'}`}
                                onClick={() => onSelect?.(folder.name)}
                            >
                                {isSelected && (
                                    <motion.div
                                        initial={{ scale: 0 }}
                                        animate={{ scale: 1 }}
                                        className="h-2.5 w-2.5 bg-white rounded-full"
                                    />
                                )}
                            </div>
                        </div>
                    )}

                    {/* 左上角：文件夹图标徽章 - 仅在有文件时显示 */}
                    {folder.fileCount > 0 && (
                        <div className="absolute top-2.5 left-2.5 bg-black/60 backdrop-blur-md rounded-full px-2.5 py-1 flex items-center gap-1.5 shadow-sm border border-white/10 transition-transform group-hover:scale-105">
                            <Folder className="h-3.5 w-3.5 text-white/90" />
                            <span className="text-xs font-medium text-white/90 tabular-nums">{folder.fileCount}</span>
                        </div>
                    )}

                    {/* 右下角：文件类型指示器 */}
                    {!isSelectionMode && (
                        <div className="absolute bottom-2.5 right-2.5 flex gap-1.5">
                            {Object.entries(typeCounts).map(([type, count]) => (
                                <div
                                    key={type}
                                    className="bg-black/60 backdrop-blur-md rounded-full px-2.5 py-1 flex items-center gap-1.5 shadow-sm border border-white/10 transition-transform group-hover:scale-105"
                                    title={`${count} ${type}`}
                                >
                                    {getFileTypeIcon(type as FileData["type"])}
                                    <span className="text-xs font-medium text-white/90 tabular-nums">{count}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* 文件夹信息 */}
                <div className={`p-3.5 flex items-start justify-between gap-2 ${isSelected ? 'bg-primary/5' : ''}`}>
                    <div className="flex-1 min-w-0">
                        <h3 className="truncate text-sm font-semibold leading-tight text-foreground mb-1" title={folder.name}>
                            {folder.name}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                            {folder.fileCount} 个文件
                        </p>
                    </div>
                    {!isSelectionMode && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full md:opacity-0 group-hover:opacity-100 transition-opacity -mr-1.5"
                            onClick={(e) => {
                                e.stopPropagation();
                                const rect = e.currentTarget.getBoundingClientRect();
                                setContextMenu({ x: rect.left, y: rect.bottom + 5 });
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            onMouseUp={(e) => e.stopPropagation()}
                            onTouchStart={(e) => e.stopPropagation()}
                            onTouchEnd={(e) => e.stopPropagation()}
                        >
                            <MoreVertical className="h-4 w-4" />
                        </Button>
                    )}
                </div>
            </motion.div>

            {/* Context Menu */}
            <ContextMenu
                x={contextMenu?.x ?? 0}
                y={contextMenu?.y ?? 0}
                isOpen={!!contextMenu}
                onClose={() => setContextMenu(null)}
                items={createFolderMenuItems(
                    t,
                    onRename,
                    onToggleFavorite,
                    isFavorite,
                    onDelete,
                    onMove
                )}
            />
        </>
    );
};
