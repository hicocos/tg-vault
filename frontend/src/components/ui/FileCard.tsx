import { motion } from "framer-motion";
import { Download, Eye, FileText, Image as ImageIcon, Music, Video, Trash2, Cloud, HardDrive } from "lucide-react";
import { Button } from "./Button";
import { fileApi, type FileData } from "../../services/api";

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

export const FileCard = ({ file, onPreview, onDelete }: { file: FileData; onPreview?: () => void; onDelete?: () => void }) => {
    const handleDownload = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await fileApi.downloadFile(file.id, file.name);
        } catch (error) {
            console.error("下载失败", error);
            // 这里可以添加 toast 提示
        }
    };

    // 使用真实的缩略图或预览 URL（已包含签名）
    const thumbnailSrc = file.thumbnailUrl || (file.type === 'image' ? file.previewUrl : undefined);

    // 存储图标组件
    const SourceIcon = file.source === 'onedrive' ? Cloud : HardDrive;
    const sourceLabel = file.source === 'onedrive' ? 'OneDrive' : 'Local';

    return (
        <motion.div
            layout
            whileHover={{ y: -4, transition: { duration: 0.2 } }}
            className="group relative flex flex-col rounded-2xl border border-border/50 bg-card overflow-hidden shadow-sm transition-all hover:shadow-lg hover:border-border cursor-pointer"
            onClick={onPreview}
        >
            {/* 图片区域 - 使用 4:3 比例 */}
            <div className="relative aspect-[4/3] w-full overflow-hidden bg-gradient-to-br from-muted/30 to-muted/60 flex items-center justify-center">
                {thumbnailSrc ? (
                    <img
                        src={thumbnailSrc}
                        alt={file.name}
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
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

                {/* Storage Source Indicator */}
                <div className="absolute top-2 right-2 bg-black/40 backdrop-blur-md px-2 py-1 rounded-full flex items-center gap-1.5 text-[10px] font-medium text-white/90 border border-white/10 shadow-sm z-10">
                    <SourceIcon className="h-3 w-3" />
                    <span>{sourceLabel}</span>
                </div>

                {/* Hover Overlay Actions */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/30 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 flex items-end justify-center pb-4 gap-3">
                    <Button
                        size="icon"
                        variant="secondary"
                        className="h-9 w-9 rounded-full bg-white/95 hover:bg-white text-gray-700 shadow-lg transition-all hover:scale-110"
                        onClick={(e) => {
                            e.stopPropagation();
                            onPreview?.();
                        }}
                        title="预览"
                    >
                        <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                        size="icon"
                        variant="secondary"
                        className="h-9 w-9 rounded-full bg-white/95 hover:bg-white text-gray-700 shadow-lg transition-all hover:scale-110"
                        onClick={handleDownload}
                        title="下载"
                    >
                        <Download className="h-4 w-4" />
                    </Button>
                    {onDelete && (
                        <Button
                            size="icon"
                            variant="secondary"
                            className="h-9 w-9 rounded-full bg-white/95 hover:bg-red-50 text-red-500 hover:text-red-600 shadow-lg transition-all hover:scale-110"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete();
                            }}
                            title="删除"
                        >
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    )}
                </div>
            </div>

            {/* 文件信息 */}
            <div className="p-3.5">
                <h3 className="truncate text-sm font-medium leading-tight text-foreground mb-1" title={file.name}>
                    {file.name}
                </h3>
                <p className="text-xs text-muted-foreground">{file.size} • {file.date}</p>
            </div>
        </motion.div>
    );
};
