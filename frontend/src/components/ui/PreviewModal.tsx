import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X, FileText, Download, Video, ZoomIn, ZoomOut } from "lucide-react";
import type { FileData } from "./FileCard";
import { Button } from "./Button";
import { useEffect, useState } from "react";
import { fileApi } from "../../services/api";

interface PreviewModalProps {
    file: FileData | null;
    onClose: () => void;
}

// 浏览器原生支持的视频格式
const SUPPORTED_VIDEO_MIMES = [
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime',
];

// 视频播放器组件
const VideoPlayer = ({ file }: { file: FileData }) => {
    const [hasError, setHasError] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    const isSupported = SUPPORTED_VIDEO_MIMES.some(mime =>
        file.mime_type?.toLowerCase().startsWith(mime.split('/')[0]) &&
        file.mime_type?.toLowerCase().includes(mime.split('/')[1])
    ) || file.mime_type?.startsWith('video/mp4');

    const handleDownload = async () => {
        try {
            await fileApi.downloadFile(file.id, file.name);
        } catch (error) {
            console.error("下载视频失败", error);
        }
    };

    if (hasError || !isSupported) {
        return (
            <div className="flex flex-col items-center gap-4 text-center p-8 text-white">
                <div className="h-16 w-16 rounded-full bg-white/10 flex items-center justify-center">
                    <Video className="h-8 w-8 text-white/80" />
                </div>
                <div className="space-y-1">
                    <p className="text-base font-medium text-white">
                        {hasError ? "视频加载失败" : "不支持在线预览"}
                    </p>
                    <p className="text-xs text-white/60 max-w-xs mx-auto">
                        {hasError ? "请下载后观看" : `格式 ${file.mime_type || '未知'} 不支持在线播放`}
                    </p>
                </div>
                <Button onClick={handleDownload} size="sm" variant="secondary" className="gap-2">
                    <Download className="h-4 w-4" />
                    下载视频
                </Button>
            </div>
        );
    }

    return (
        <div className="relative flex items-center justify-center">
            {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center z-10">
                    <div className="animate-spin rounded-full h-10 w-10 border-4 border-white/20 border-t-white" />
                </div>
            )}
            <video
                src={file.previewUrl}
                controls
                autoPlay
                playsInline
                className="max-w-[90vw] max-h-[80vh] w-auto h-auto shadow-2xl rounded-lg"
                onLoadedData={() => setIsLoading(false)}
                onError={() => { setIsLoading(false); setHasError(true); }}
            >
                您的浏览器不支持视频播放
            </video>
        </div>
    );
};

export const PreviewModal = ({ file, onClose }: PreviewModalProps) => {
    const [scale, setScale] = useState(1);

    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", handleEsc);

        if (file) {
            document.body.style.overflow = 'hidden';
            setScale(1);
        }

        return () => {
            window.removeEventListener("keydown", handleEsc);
            document.body.style.overflow = '';
        };
    }, [onClose, file]);

    const handleDownload = async (e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (!file) return;
        try {
            await fileApi.downloadFile(file.id, file.name);
        } catch (error) {
            console.error("下载失败", error);
        }
    };

    const handleZoomIn = (e: React.MouseEvent) => {
        e.stopPropagation();
        setScale(prev => Math.min(prev + 0.25, 3));
    };

    const handleZoomOut = (e: React.MouseEvent) => {
        e.stopPropagation();
        setScale(prev => Math.max(prev - 0.25, 0.5));
    };

    const PreviewContent = () => {
        if (!file) return null;

        if (file.type === "image") {
            return (
                <div
                    className="flex items-center justify-center"
                    onClick={(e) => e.stopPropagation()}
                >
                    <motion.img
                        src={file.previewUrl}
                        alt={file.name}
                        animate={{ scale }}
                        transition={{ duration: 0.2 }}
                        drag={scale > 1}
                        dragConstraints={{ left: -300, right: 300, top: -300, bottom: 300 }}
                        dragElastic={0.1}
                        className="max-w-[90vw] max-h-[80vh] object-contain shadow-2xl rounded-lg cursor-grab active:cursor-grabbing"
                    />
                </div>
            );
        }
        if (file.type === "video") {
            return (
                <div onClick={(e) => e.stopPropagation()}>
                    <VideoPlayer file={file} />
                </div>
            );
        }
        if (file.type === "audio") {
            return (
                <div className="flex flex-col items-center justify-center gap-8 p-8 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
                    <div className="h-32 w-32 rounded-full bg-white/10 flex items-center justify-center shadow-2xl backdrop-blur-md">
                        <FileText className="h-16 w-16 text-white" />
                    </div>
                    <div className="text-center space-y-2">
                        <h3 className="text-xl font-medium text-white">{file.name}</h3>
                        <p className="text-white/60">{file.size}</p>
                    </div>
                    <audio
                        src={file.previewUrl}
                        controls
                        autoPlay
                        className="w-full shadow-lg"
                    >
                        您的浏览器不支持音频播放
                    </audio>
                </div>
            );
        }
        return (
            <div className="flex flex-col items-center justify-center gap-6 text-white/80 p-12 max-w-md text-center" onClick={(e) => e.stopPropagation()}>
                <FileText className="h-24 w-24 opacity-50" />
                <div className="space-y-2">
                    <p className="text-lg font-medium text-white">暂不支持预览此类型文件</p>
                    <p className="text-sm text-white/60">{file.name}</p>
                </div>
                <Button variant="secondary" size="lg" onClick={handleDownload} className="mt-4 gap-2">
                    <Download className="h-5 w-5" />
                    下载查看
                </Button>
            </div>
        );
    };

    // 使用 Portal 渲染到 body，确保全屏覆盖不受父元素影响
    const modalContent = (
        <AnimatePresence>
            {file && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="fixed top-0 left-0 right-0 bottom-0 bg-black flex flex-col"
                    style={{ zIndex: 9999 }}
                    onClick={onClose}
                >
                    {/* 顶部工具栏 */}
                    <div
                        className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent shrink-0"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div className="text-white min-w-0">
                                <h3 className="font-medium text-sm truncate max-w-[50vw]">{file.name}</h3>
                                <p className="text-xs text-white/60">{file.size} • {file.date}</p>
                            </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                            {file.type === 'image' && (
                                <>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="text-white/80 hover:text-white hover:bg-white/10 rounded-full h-9 w-9"
                                        onClick={handleZoomOut}
                                    >
                                        <ZoomOut className="h-5 w-5" />
                                    </Button>
                                    <span className="text-white/60 text-xs w-10 text-center">{Math.round(scale * 100)}%</span>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="text-white/80 hover:text-white hover:bg-white/10 rounded-full h-9 w-9"
                                        onClick={handleZoomIn}
                                    >
                                        <ZoomIn className="h-5 w-5" />
                                    </Button>
                                    <div className="w-px h-5 bg-white/20 mx-1" />
                                </>
                            )}
                            <Button
                                variant="ghost"
                                size="icon"
                                className="text-white/80 hover:text-white hover:bg-white/10 rounded-full h-9 w-9"
                                onClick={handleDownload}
                            >
                                <Download className="h-5 w-5" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="text-white/80 hover:text-white hover:bg-white/10 rounded-full h-9 w-9"
                                onClick={onClose}
                            >
                                <X className="h-6 w-6" />
                            </Button>
                        </div>
                    </div>

                    {/* 内容区域 - 占满剩余空间并居中显示 */}
                    <div className="flex-1 flex items-center justify-center overflow-hidden">
                        <PreviewContent />
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );

    // 渲染到 document.body
    return createPortal(modalContent, document.body);
};
