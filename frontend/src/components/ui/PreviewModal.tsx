import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X, FileText, Download, Video, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, Maximize2, RotateCcw, Copy, Check } from "lucide-react";
import type { FileData } from "./FileCard";
import { Button } from "./Button";
import { useEffect, useRef, useState } from "react";
import { fileApi } from "../../services/api";
import { API_BASE } from "../../services/config";
import { MobileMenu } from "./MobileMenu";

interface PreviewModalProps {
    file: FileData | null;
    onClose: () => void;
    onToggleFavorite?: (fileId: string) => void;
    files?: FileData[];
    onNavigate?: (file: FileData) => void;
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
    const [isBuffering, setIsBuffering] = useState(false);

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
            {(isLoading || isBuffering) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10 bg-black/20 rounded-lg">
                    <div className="animate-spin rounded-full h-10 w-10 border-4 border-white/20 border-t-white" />
                    <span className="text-xs text-white/70">{isLoading ? '正在加载视频信息…' : '正在缓冲…'}</span>
                </div>
            )}
            <video
                src={file.previewUrl}
                controls
                preload="metadata"
                poster={file.thumbnailUrl}
                playsInline
                className="max-w-[94vw] max-h-[82vh] w-auto h-auto shadow-2xl rounded-lg bg-black"
                onLoadedMetadata={() => setIsLoading(false)}
                onCanPlay={() => { setIsLoading(false); setIsBuffering(false); }}
                onWaiting={() => setIsBuffering(true)}
                onPlaying={() => setIsBuffering(false)}
                onError={() => { setIsLoading(false); setIsBuffering(false); setHasError(true); }}
            >
                您的浏览器不支持视频播放
            </video>
        </div>
    );
};

export const PreviewModal = ({ file, onClose, onToggleFavorite, files = [], onNavigate }: PreviewModalProps) => {
    const [scale, setScale] = useState(1);
    const [imageLoaded, setImageLoaded] = useState(false);
    const [imageError, setImageError] = useState(false);
    const [idCopied, setIdCopied] = useState(false);
    const touchStartXRef = useRef<number | null>(null);
    const openedAtRef = useRef<number>(0);
    const [mobileMenu, setMobileMenu] = useState<{
        isOpen: boolean;
        x: number;
        y: number;
    }>({
        isOpen: false,
        x: 0,
        y: 0
    });

    const imageFiles = files.filter(item => item.type === 'image');
    const currentImageIndex = file?.type === 'image' ? imageFiles.findIndex(item => item.id === file.id) : -1;
    const canGoPrevious = currentImageIndex > 0;
    const canGoNext = currentImageIndex >= 0 && currentImageIndex < imageFiles.length - 1;
    const showImageNavigation = file?.type === 'image' && imageFiles.length > 1;

    const navigateImageBy = (delta: -1 | 1) => {
        if (currentImageIndex < 0) return;
        const nextFile = imageFiles[currentImageIndex + delta];
        if (nextFile) onNavigate?.(nextFile);
    };

    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
            if (file?.type === 'image' && e.key === "ArrowLeft") navigateImageBy(-1);
            if (file?.type === 'image' && e.key === "ArrowRight") navigateImageBy(1);
        };
        window.addEventListener("keydown", handleEsc);

        if (file) {
            openedAtRef.current = Date.now();
            document.body.style.overflow = 'hidden';
            setScale(1);
            setImageLoaded(false);
            setImageError(false);
            setIdCopied(false);
        }

        return () => {
            window.removeEventListener("keydown", handleEsc);
            document.body.style.overflow = '';
        };
    }, [onClose, file, currentImageIndex]);

    const handleDownload = async (e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (!file) return;
        try {
            await fileApi.downloadFile(file.id, file.name);
        } catch (error) {
            console.error("下载失败", error);
        }
    };

    const handleMobileMenuClose = () => {
        setMobileMenu(prev => ({ ...prev, isOpen: false }));
    };

    const handleZoomIn = (e: React.MouseEvent) => {
        e.stopPropagation();
        setScale(prev => Math.min(prev + 0.25, 3));
    };

    const handleZoomOut = (e: React.MouseEvent) => {
        e.stopPropagation();
        setScale(prev => Math.max(prev - 0.25, 0.5));
    };

    const handleResetZoom = (e?: React.MouseEvent) => {
        e?.stopPropagation();
        setScale(1);
    };

    const handleOpenOriginal = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!file) return;
        window.open(`${API_BASE}/api/files/${file.id}/original`, '_blank', 'noopener,noreferrer');
    };

    const handleCopyId = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!file) return;
        await navigator.clipboard.writeText(file.id);
        setIdCopied(true);
        window.setTimeout(() => setIdCopied(false), 1500);
    };

    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartXRef.current = e.touches[0]?.clientX ?? null;
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        const startX = touchStartXRef.current;
        touchStartXRef.current = null;
        if (startX === null || scale > 1 || file?.type !== 'image') return;
        const endX = e.changedTouches[0]?.clientX ?? startX;
        const delta = endX - startX;
        if (Math.abs(delta) < 60) return;
        if (delta > 0) navigateImageBy(-1);
        else navigateImageBy(1);
    };

    const handleBackdropClose = (e: React.MouseEvent) => {
        e.stopPropagation();
        // Ignore the opening tap/click that may bubble into the newly mounted modal
        // or be replayed by mobile browsers as a synthetic click.
        if (Date.now() - openedAtRef.current < 350) return;
        if (e.target !== e.currentTarget) return;
        onClose();
    };

    const PreviewContent = () => {
        if (!file) return null;

        if (file.type === "image") {
            return (
                <div
                    className="relative flex items-center justify-center"
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                        e.stopPropagation();
                        setScale(prev => prev === 1 ? 2 : 1);
                    }}
                >
                    {!imageLoaded && !imageError && (
                        <div className="absolute inset-0 flex items-center justify-center z-10">
                            <div className="animate-spin rounded-full h-10 w-10 border-4 border-white/20 border-t-white" />
                        </div>
                    )}
                    {file.thumbnailUrl && (
                        <img
                            src={file.thumbnailUrl}
                            alt=""
                            aria-hidden="true"
                            className={`absolute max-w-[90vw] max-h-[80vh] object-contain rounded-lg blur-md opacity-40 transition-opacity ${imageLoaded ? 'opacity-0' : 'opacity-40'}`}
                        />
                    )}
                    {imageError ? (
                        <div className="flex flex-col items-center gap-3 text-white/80 p-8">
                            <FileText className="h-16 w-16 opacity-60" />
                            <p>图片加载失败</p>
                            <Button variant="secondary" onClick={handleOpenOriginal}>查看原图</Button>
                        </div>
                    ) : (
                        <motion.img
                            src={file.previewUrl}
                            alt={file.name}
                            animate={{ scale }}
                            transition={{ duration: 0.2 }}
                            drag={scale > 1}
                            dragConstraints={{ left: -500, right: 500, top: -500, bottom: 500 }}
                            dragElastic={0.08}
                            onLoad={() => setImageLoaded(true)}
                            onError={() => setImageError(true)}
                            className={`max-w-[94vw] max-h-[82vh] object-contain shadow-2xl rounded-lg cursor-grab active:cursor-grabbing transition-opacity ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
                        />
                    )}
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
                    onClick={handleBackdropClose}
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
                                <div className="mt-1 flex max-w-[58vw] items-center gap-1 text-[10px] text-white/60">
                                    <span className="font-mono break-all" title={file.id}>ID: {file.id}</span>
                                    <button
                                        type="button"
                                        className="shrink-0 rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
                                        onClick={handleCopyId}
                                        title={idCopied ? '已复制文件 ID' : '复制文件 ID'}
                                        aria-label={idCopied ? '文件 ID 已复制' : '复制文件 ID'}
                                    >
                                        {idCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                    </button>
                                </div>
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
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="text-white/80 hover:text-white hover:bg-white/10 rounded-full h-9 w-9"
                                        onClick={handleResetZoom}
                                        title="重置缩放"
                                    >
                                        <RotateCcw className="h-4 w-4" />
                                    </Button>
                                    <div className="w-px h-5 bg-white/20 mx-1" />
                                </>
                            )}
                            {(file.type === 'image' || file.type === 'video') && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="text-white/80 hover:text-white hover:bg-white/10 rounded-full h-9 w-9"
                                    onClick={handleOpenOriginal}
                                    title="查看原始文件"
                                >
                                    <Maximize2 className="h-4 w-4" />
                                </Button>
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
                    <div 
                        className="flex-1 flex items-center justify-center overflow-hidden relative"
                        onClick={(e) => e.stopPropagation()}
                        onTouchStart={handleTouchStart}
                        onTouchEnd={handleTouchEnd}
                    >
                        {showImageNavigation && canGoPrevious && (
                            <button
                                type="button"
                                className="absolute left-2 md:left-4 top-1/2 -translate-y-1/2 z-20 flex h-12 w-12 md:h-14 md:w-14 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/90 shadow-lg backdrop-blur-md transition hover:bg-white/15 active:scale-95"
                                onClick={(e) => { e.stopPropagation(); navigateImageBy(-1); }}
                                aria-label="上一张图片"
                                title="上一张图片"
                            >
                                <ChevronLeft className="h-8 w-8" />
                            </button>
                        )}
                        {showImageNavigation && canGoNext && (
                            <button
                                type="button"
                                className="absolute right-2 md:right-4 top-1/2 -translate-y-1/2 z-20 flex h-12 w-12 md:h-14 md:w-14 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/90 shadow-lg backdrop-blur-md transition hover:bg-white/15 active:scale-95"
                                onClick={(e) => { e.stopPropagation(); navigateImageBy(1); }}
                                aria-label="下一张图片"
                                title="下一张图片"
                            >
                                <ChevronRight className="h-8 w-8" />
                            </button>
                        )}
                        {showImageNavigation && (
                            <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-black/45 px-3 py-1.5 text-xs text-white/80 shadow-lg backdrop-blur-md">
                                {currentImageIndex + 1} / {imageFiles.length} · 左右滑动切换图片
                            </div>
                        )}
                        <PreviewContent />
                    </div>

                    {/* 移动端菜单 */}
                    <MobileMenu
                        isOpen={mobileMenu.isOpen}
                        x={mobileMenu.x}
                        y={mobileMenu.y}
                        isFavorite={file?.is_favorite || false}
                        onDelete={() => {
                            // 这里可以添加删除功能
                        }}
                        onToggleFavorite={() => {
                            onToggleFavorite?.(file?.id || '');
                        }}
                        onDownload={handleDownload}
                        onClose={handleMobileMenuClose}
                    />
                </motion.div>
            )}
        </AnimatePresence>
    );

    // 渲染到 document.body
    return createPortal(modalContent, document.body);
};
