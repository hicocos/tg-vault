import { motion } from "framer-motion";
import { Folder, Image as ImageIcon, Video, Music, FileText } from "lucide-react";
import { type FileData } from "../../services/api";

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

export const FolderCard = ({ folder, onClick }: { folder: FolderData; onClick: () => void }) => {
    // 获取封面缩略图
    const coverFile = folder.coverFile;
    const thumbnailSrc = coverFile?.thumbnailUrl || (coverFile?.type === 'image' ? coverFile?.previewUrl : undefined);

    // 统计各类型文件数量
    const typeCounts = folder.files.reduce((acc, file) => {
        acc[file.type] = (acc[file.type] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    return (
        <motion.div
            layout
            whileHover={{ y: -4, transition: { duration: 0.2 } }}
            className="group relative flex flex-col rounded-2xl border border-border/50 bg-card overflow-hidden shadow-sm transition-all hover:shadow-lg hover:border-primary/30 cursor-pointer"
            onClick={onClick}
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

                {/* 左上角：文件夹图标徽章 */}
                <div className="absolute top-2.5 left-2.5 bg-black/60 backdrop-blur-md rounded-full px-2.5 py-1 flex items-center gap-1.5 shadow-sm border border-white/10 transition-transform group-hover:scale-105">
                    <Folder className="h-3.5 w-3.5 text-white/90" />
                    <span className="text-xs font-medium text-white/90 tabular-nums">{folder.fileCount}</span>
                </div>

                {/* 右下角：文件类型指示器 */}
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
            </div>

            {/* 文件夹信息 */}
            <div className="p-3.5">
                <h3 className="truncate text-sm font-semibold leading-tight text-foreground mb-1" title={folder.name}>
                    {folder.name}
                </h3>
                <p className="text-xs text-muted-foreground">
                    {folder.fileCount} 个文件
                </p>
            </div>
        </motion.div>
    );
};
