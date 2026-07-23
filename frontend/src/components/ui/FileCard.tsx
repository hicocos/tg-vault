import { motion } from "framer-motion";
import { Download, Eye, FileText, Image as ImageIcon, Music, Video, Cloud, HardDrive, Database, Package, Network, Star, MoreVertical } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { fileApi, type FileData } from "../../services/api";
import { ContextMenu, createFileMenuItems } from "./ContextMenu";
import { useLongPress } from "../../hooks/useLongPress";

// Re-export FileData type for convenience
export type { FileData } from "../../services/api";

const FileIcon = ({ type }: { type: FileData["type"] }) => {
    switch (type) {
        case "image": return <ImageIcon className="h-10 w-10 text-blue-500" />;
        case "video": return <Video className="h-10 w-10 text-purple-500" />;
        case "audio": return <Music className="h-10 w-10 text-pink-500" />;
        case "document": return <FileText className="h-10 w-10 text-orange-500" />;
        default: return <FileText className="h-10 w-10 text-gray-400" />;
    }
};

export const FileCard = ({
    file,
    onPreview,
    onDelete,
    onRename,
    onToggleFavorite,
    onMove,
    isSelectionMode = false,
    isSelected = false,
    onSelect
}: {
    file: FileData;
    onPreview?: () => void;
    onDelete?: () => void;
    onRename?: () => void;
    onToggleFavorite?: () => void;
    onMove?: () => void;
    isSelectionMode?: boolean;
    isSelected?: boolean;
    onSelect?: (id: string) => void;
}) => {
    const { t } = useTranslation();

    // Context menu state
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    const [downloadError, setDownloadError] = useState<string | null>(null);

    const handleDownload = async (e?: React.MouseEvent) => {
        e?.stopPropagation();
        try {
            setDownloadError(null);
            await fileApi.downloadFile(file.id, file.name);
        } catch (error: any) {
            console.error("下载失败", error);
            setDownloadError(error?.message || "下载失败");
        }
    };

    const handleContextMenu = (e: any) => {
        if (isSelectionMode) return;
        
        // 如果是触摸事件，防止触发默认上下文菜单并处理系统震动反馈（可选）
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

    // 使用真实的缩略图或预览 URL（已包含签名）
    // 对于 GIF 动图，强制使用预览 URL 以便能够自动播放
    const isGif = file.name.toLowerCase().endsWith('.gif');
    const thumbnailSrc = isGif ? file.previewUrl : (file.thumbnailUrl || (file.type === 'image' ? file.previewUrl : undefined));

    // 存储图标组件
    const getSourceInfo = (source?: string) => {
        switch (source) {
            case 'onedrive':
                return { Icon: Cloud, label: 'OneDrive' };
            case 'aliyun_oss':
                return { Icon: Database, label: 'Aliyun OSS' };
            case 's3':
                return { Icon: Package, label: 'S3' };
            case 'webdav':
                return { Icon: Network, label: 'WebDAV' };
            case 'google_drive':
                return { Icon: Database, label: 'Google Drive' };
            default:
                return { Icon: HardDrive, label: 'Local' };
        }
    };

    const { Icon: SourceIcon, label: sourceLabel } = getSourceInfo(file.source);

    const handleCardClick = () => {
        if (isSelectionMode) {
            onSelect?.(file.id);
        } else {
            onPreview?.();
        }
    };

    return (
        <>
            <motion.div
                layout
                whileHover={{ y: isSelectionMode ? 0 : -4, transition: { duration: 0.2 } }}
                className={`group relative flex flex-col rounded-2xl border ${isSelected ? 'border-primary ring-2 ring-primary/20 bg-primary/5' : 'border-border/50 bg-card'} overflow-hidden shadow-sm transition-all touch-manipulation select-none ${!isSelectionMode ? 'hover:shadow-lg hover:border-border cursor-pointer active:scale-[0.99]' : 'cursor-pointer active:scale-[0.99]'}`}
                {...(!isSelectionMode ? longPressHandlers : { onClick: handleCardClick })}
                onContextMenu={handleContextMenu}
            >
                {/* 图片区域 - 使用 4:3 比例 */}
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-gradient-to-br from-muted/30 to-muted/60 flex items-center justify-center">
                    {thumbnailSrc ? (
                        <img
                            src={thumbnailSrc}
                            alt={file.name}
                            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                            loading="lazy"
                        />
                    ) : (
                        <div className="flex flex-col items-center gap-2">
                            <FileIcon type={file.type} />
                            <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
                                {file.type === 'video' ? 'VIDEO' : file.type === 'audio' ? 'AUDIO' : file.type === 'document' ? 'DOC' : 'FILE'}
                            </span>
                        </div>
                    )}

                    {/* Selection Checkbox */}
                    {isSelectionMode && (
                        <div
                            className="absolute bottom-2 right-2 z-20 flex h-11 w-11 items-center justify-center"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div
                                role="checkbox"
                                aria-checked={isSelected}
                                aria-label={`选择 ${file.name}`}
                                className={`h-7 w-7 rounded-full border-2 flex items-center justify-center transition-all cursor-pointer shadow-sm ${isSelected ? 'bg-primary border-primary' : 'bg-black/35 border-white/70 backdrop-blur-sm'}`}
                                onClick={() => onSelect?.(file.id)}
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

                    {/* Storage Source Indicator */}
                    {!isSelectionMode && (
                        <>
                            {/* Favorite Indicator */}
                            {file.is_favorite && (
                                <div className="absolute top-2 left-2 bg-yellow-400/90 backdrop-blur-md p-1.5 rounded-full border border-yellow-300/50 shadow-sm z-10">
                                    <Star className="h-3 w-3 text-yellow-700 fill-current" />
                                </div>
                            )}
                            <div className="absolute top-2 right-2 bg-black/40 backdrop-blur-md px-2 py-1 rounded-full flex items-center gap-1.5 text-[10px] font-medium text-white/90 border border-white/10 shadow-sm z-10">
                                <SourceIcon className="h-3 w-3" />
                                <span>{sourceLabel}</span>
                            </div>
                        </>
                    )}

                    {/* Hover Overlay Actions */}
                    {!isSelectionMode && (
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/30 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 hidden md:flex items-end justify-center pb-4 gap-3">
                            <Button
                                size="icon"
                                variant="secondary"
                                className="h-11 w-11 rounded-full bg-white/95 hover:bg-white text-gray-700 shadow-lg transition-all hover:scale-105"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onPreview?.();
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                                onMouseUp={(e) => e.stopPropagation()}
                                onTouchStart={(e) => e.stopPropagation()}
                                onTouchEnd={(e) => e.stopPropagation()}
                                title="预览"
                            >
                                <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                                size="icon"
                                variant="secondary"
                                className="h-11 w-11 rounded-full bg-white/95 hover:bg-white text-gray-700 shadow-lg transition-all hover:scale-105"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleDownload();
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                                onMouseUp={(e) => e.stopPropagation()}
                                onTouchStart={(e) => e.stopPropagation()}
                                onTouchEnd={(e) => e.stopPropagation()}
                                title="下载"
                            >
                                <Download className="h-4 w-4" />
                            </Button>
                        </div>
                    )}
                </div>

                {/* 文件信息 */}
                <div className={`p-3.5 flex items-start justify-between gap-2 ${isSelected ? 'bg-primary/5' : ''}`}>
                    <div className="flex-1 min-w-0">
                        <h3 className="truncate text-sm font-medium leading-tight text-foreground mb-1" title={file.name}>
                            {file.name}
                        </h3>
                        <p className="text-xs text-muted-foreground">{file.size} • {file.date}</p>
                    </div>
                    {!isSelectionMode && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11 rounded-full md:opacity-0 group-hover:opacity-100 transition-opacity -mr-1.5 touch-manipulation"
                            onClick={(e) => {
                                e.stopPropagation();
                                const rect = e.currentTarget.getBoundingClientRect();
                                setContextMenu({ x: rect.left, y: rect.bottom + 5 });
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            onMouseUp={(e) => e.stopPropagation()}
                            onTouchStart={(e) => e.stopPropagation()}
                            onTouchEnd={(e) => e.stopPropagation()}
                                                    aria-label={`更多操作：${file.name}`}
                        >
                            <MoreVertical className="h-5 w-5" />
                        </Button>
                    )}
                </div>
                {downloadError && (
                    <p role="alert" className="border-t border-red-200 bg-red-50 px-3.5 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                        {downloadError}
                    </p>
                )}
            </motion.div>

            {/* Context Menu */}
            <ContextMenu
                x={contextMenu?.x ?? 0}
                y={contextMenu?.y ?? 0}
                isOpen={!!contextMenu}
                onClose={() => setContextMenu(null)}
                items={createFileMenuItems(
                    t,
                    onRename,
                    () => handleDownload(),
                    onToggleFavorite,
                    !!file.is_favorite,
                    onDelete,
                    onMove
                )}
            />
        </>
    );
};
