import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X, FileText, Download, Video, Music, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, Maximize2, RotateCcw, Copy, Check, Info, RefreshCw } from "lucide-react";
import type { FileData } from "./FileCard";
import { Button } from "./Button";
import { useEffect, useRef, useState } from "react";
import { fileApi } from "../../services/api";
import { API_BASE } from "../../services/config";
import { MobileMenu } from "./MobileMenu";
import { IndeterminateSpinner } from "./IndeterminateSpinner";

interface PreviewModalProps {
    file: FileData | null;
    onClose: () => void;
    onToggleFavorite?: (fileId: string) => void;
    files?: FileData[];
    onNavigate?: (file: FileData) => void;
}

const resolveMediaErrorMessage = async (fileId: string, fallback: string): Promise<string> => {
    try {
        const status = await fileApi.getMediaStatus(fileId);
        if (status.code === 'MEDIA_SOURCE_MISSING') return '云盘中的源文件已删除或已移入回收站';
        if (status.code === 'MEDIA_QUOTA_EXCEEDED') return '云盘下载额度已用完，请稍后重试';
        if (status.code === 'MEDIA_RATE_LIMITED') return '云盘请求过于频繁，请稍后重试';
        if (status.error) return status.error;
        return fallback;
    } catch {
        return fallback;
    }
};

// 视频播放器组件
const VideoPlayer = ({ file }: { file: FileData }) => {
    const [hasError, setHasError] = useState(false);
    const [errorMessage, setErrorMessage] = useState('云端媒体暂时无法读取，请稍后重试');
    const [isLoading, setIsLoading] = useState(true);
    const [isBuffering, setIsBuffering] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        setHasError(false);
        setErrorMessage('云端媒体暂时无法读取，请稍后重试');
        setIsLoading(true);
        setIsBuffering(false);
    }, [file.previewUrl]);

    const handleDownload = async () => {
        try {
            await fileApi.downloadFile(file.id, file.name);
        } catch (error) {
            console.error("下载视频失败", error);
        }
    };

    const handleReload = () => {
        setHasError(false);
        setIsLoading(true);
        setIsBuffering(false);
        setReloadKey(key => key + 1);
        window.setTimeout(() => videoRef.current?.load(), 0);
    };

    if (hasError) {
        return (
            <div className="flex flex-col items-center gap-4 p-8 text-center text-white">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10">
                    <Video className="h-8 w-8 text-white/80" />
                </div>
                <div className="space-y-1">
                    <p className="text-base font-medium text-white">视频加载失败</p>
                    <p className="mx-auto max-w-xs text-xs text-white/60">{errorMessage}</p>
                </div>
                <div className="flex gap-2">
                    <Button onClick={handleReload} size="sm" variant="secondary" className="gap-2">
                        <RefreshCw className="h-4 w-4" />
                        重新加载
                    </Button>
                    <Button onClick={handleDownload} size="sm" variant="secondary" className="gap-2">
                        <Download className="h-4 w-4" />
                        下载视频
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="relative flex items-center justify-center">
            {(isLoading || isBuffering) && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-lg bg-black/35 pointer-events-none">
                    <IndeterminateSpinner label={isLoading ? "正在加载预览" : "视频正在缓冲"} size="lg" tone="inverse" />
                    <span className="text-xs text-white/70">{isLoading ? '正在加载视频信息…' : '正在缓冲…'}</span>
                </div>
            )}
            <video
                key={`${file.previewUrl}-${reloadKey}`}
                ref={videoRef}
                src={file.previewUrl}
                controls
                preload="metadata"
                poster={file.thumbnailUrl}
                playsInline
                className="max-h-[82vh] max-w-[94vw] bg-black h-auto w-auto rounded-lg shadow-2xl"
                onLoadedMetadata={() => setIsLoading(false)}
                onCanPlay={() => { setIsLoading(false); setIsBuffering(false); }}
                onWaiting={() => setIsBuffering(true)}
                onPlaying={() => setIsBuffering(false)}
                onError={() => {
                    setIsLoading(false);
                    setIsBuffering(false);
                    setHasError(true);
                    void resolveMediaErrorMessage(file.id, '云端媒体暂时无法读取，请稍后重试').then(setErrorMessage);
                }}
            >
                您的浏览器不支持视频播放
            </video>
        </div>
    );
};

const AudioPlayer = ({ file }: { file: FileData }) => {
    const [hasError, setHasError] = useState(false);
    const [errorMessage, setErrorMessage] = useState('云端媒体暂时无法读取，请稍后重试');
    const [isLoading, setIsLoading] = useState(true);
    const [reloadKey, setReloadKey] = useState(0);
    const audioRef = useRef<HTMLAudioElement>(null);

    useEffect(() => {
        setHasError(false);
        setErrorMessage('云端媒体暂时无法读取，请稍后重试');
        setIsLoading(true);
    }, [file.previewUrl]);

    const handleReload = () => {
        setHasError(false);
        setIsLoading(true);
        setReloadKey(key => key + 1);
        window.setTimeout(() => audioRef.current?.load(), 0);
    };

    return (
        <div className="flex w-full max-w-md flex-col items-center justify-center gap-6 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex h-28 w-28 items-center justify-center rounded-full bg-white/10 shadow-2xl backdrop-blur-md">
                <Music className="h-14 w-14 text-white" />
            </div>
            <div className="max-w-full space-y-1 text-center">
                <h3 className="truncate text-lg font-medium text-white">{file.name}</h3>
                <p className="text-sm text-white/60">{file.size}</p>
            </div>
            {hasError ? (
                <div className="flex flex-col items-center gap-3 text-center text-white/80">
                    <p className="font-medium text-white">音频加载失败</p>
                    <p className="text-xs text-white/60">{errorMessage}</p>
                    <Button onClick={handleReload} size="sm" variant="secondary" className="gap-2">
                        <RefreshCw className="h-4 w-4" />
                        重新加载
                    </Button>
                </div>
            ) : (
                <div className="relative w-full">
                    {isLoading && (
                        <div className="mb-3 flex justify-center">
                            <IndeterminateSpinner label="正在加载音频" size="md" tone="inverse" />
                        </div>
                    )}
                    <audio
                        key={`${file.previewUrl}-${reloadKey}`}
                        ref={audioRef}
                        src={file.previewUrl}
                        controls
                        preload="metadata"
                        playsInline
                        className="w-full shadow-lg"
                        onLoadedMetadata={() => setIsLoading(false)}
                        onCanPlay={() => setIsLoading(false)}
                        onError={() => {
                            setIsLoading(false);
                            setHasError(true);
                            void resolveMediaErrorMessage(file.id, '云端媒体暂时无法读取，请稍后重试').then(setErrorMessage);
                        }}
                    >
                        您的浏览器不支持音频播放
                    </audio>
                </div>
            )}
        </div>
    );
};

export const PreviewModal = ({ file, onClose, onToggleFavorite, files = [], onNavigate }: PreviewModalProps) => {
    const [scale, setScale] = useState(1);
    const [imageLoaded, setImageLoaded] = useState(false);
    const [imageError, setImageError] = useState(false);
    const [imageErrorMessage, setImageErrorMessage] = useState('云端媒体暂时无法读取，请稍后重试');
    const [imageReloadKey, setImageReloadKey] = useState(0);
    const [detailsOpen, setDetailsOpen] = useState(false);
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
            setImageErrorMessage('云端媒体暂时无法读取，请稍后重试');
            setDetailsOpen(false);
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
                            <IndeterminateSpinner label="正在加载预览" size="lg" tone="inverse" />
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
                        <div className="flex flex-col items-center gap-3 p-8 text-white/80">
                            <FileText className="h-16 w-16 opacity-60" />
                            <p>图片加载失败</p>
                            <p className="max-w-xs text-center text-xs text-white/60">{imageErrorMessage}</p>
                            <div className="flex gap-2">
                                <Button
                                    variant="secondary"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setImageError(false);
                                        setImageLoaded(false);
                                        setImageReloadKey(key => key + 1);
                                    }}
                                    className="gap-2"
                                >
                                    <RefreshCw className="h-4 w-4" />
                                    重新加载
                                </Button>
                                <Button variant="secondary" onClick={handleOpenOriginal}>查看原图</Button>
                            </div>
                        </div>
                    ) : (
                        <motion.img
                            key={`${file.previewUrl}-${imageReloadKey}`}
                            src={file.previewUrl}
                            alt={file.name}
                            animate={{ scale }}
                            transition={{ duration: 0.2 }}
                            drag={scale > 1}
                            dragConstraints={{ left: -500, right: 500, top: -500, bottom: 500 }}
                            dragElastic={0.08}
                            onLoad={() => setImageLoaded(true)}
                            onError={() => {
                                setImageError(true);
                                void resolveMediaErrorMessage(file.id, '云端媒体暂时无法读取，请稍后重试').then(setImageErrorMessage);
                            }}
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
            return <AudioPlayer file={file} />;
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
                        <div className="min-w-0 flex-1 text-white">
                            <h3 className="max-w-[42vw] truncate text-sm font-medium sm:max-w-[50vw]">{file.name}</h3>
                        </div>

                        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
                                onClick={(e) => { e.stopPropagation(); setDetailsOpen(true); }}
                                title="查看文件详情"
                                aria-label="查看文件详情"
                            >
                                <Info className="h-4 w-4" />
                            </Button>
                            {file.type === 'image' && (
                                <div className="hidden items-center sm:flex">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="text-white/80 hover:text-white hover:bg-white/10 rounded-full h-9 w-9"
                                        onClick={handleZoomOut}
                                        title="缩小"
                                        aria-label="缩小图片"
                                    >
                                        <ZoomOut className="h-5 w-5" />
                                    </Button>
                                    <span className="text-white/60 text-xs w-10 text-center">{Math.round(scale * 100)}%</span>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="text-white/80 hover:text-white hover:bg-white/10 rounded-full h-9 w-9"
                                        onClick={handleZoomIn}
                                        title="放大"
                                        aria-label="放大图片"
                                    >
                                        <ZoomIn className="h-5 w-5" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="text-white/80 hover:text-white hover:bg-white/10 rounded-full h-9 w-9"
                                        onClick={handleResetZoom}
                                        title="重置缩放"
                                        aria-label="重置图片缩放"
                                    >
                                        <RotateCcw className="h-4 w-4" />
                                    </Button>
                                    <div className="mx-1 h-5 w-px bg-white/20" />
                                </div>
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

                    <AnimatePresence>
                        {detailsOpen && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="absolute inset-0 z-40 flex items-start justify-center bg-black/60 px-4 pt-20 backdrop-blur-sm sm:items-center sm:pt-4"
                                onClick={(e) => { e.stopPropagation(); setDetailsOpen(false); }}
                            >
                                <motion.div
                                    initial={{ opacity: 0, y: -12, scale: 0.98 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    exit={{ opacity: 0, y: -8, scale: 0.98 }}
                                    className="w-full max-w-md rounded-lg border border-white/15 bg-zinc-950 p-4 text-white shadow-2xl"
                                    role="dialog"
                                    aria-modal="true"
                                    aria-labelledby="preview-file-details-title"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <div className="mb-4 flex items-center justify-between">
                                        <h2 id="preview-file-details-title" className="text-base font-medium">文件详情</h2>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 rounded-full text-white/70 hover:bg-white/10 hover:text-white"
                                            onClick={() => setDetailsOpen(false)}
                                            aria-label="关闭文件详情"
                                        >
                                            <X className="h-4 w-4" />
                                        </Button>
                                    </div>
                                    <dl className="space-y-3 text-sm">
                                        <div>
                                            <dt className="mb-1 text-xs text-white/50">文件名</dt>
                                            <dd className="break-words text-white/90">{file.name}</dd>
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div>
                                                <dt className="mb-1 text-xs text-white/50">大小</dt>
                                                <dd className="text-white/90">{file.size}</dd>
                                            </div>
                                            <div>
                                                <dt className="mb-1 text-xs text-white/50">时间</dt>
                                                <dd className="text-white/90">{file.date}</dd>
                                            </div>
                                        </div>
                                        <div>
                                            <dt className="mb-1 text-xs text-white/50">文件 ID</dt>
                                            <dd className="flex items-start gap-2 rounded-md bg-white/5 p-2">
                                                <span className="min-w-0 flex-1 break-all font-mono text-xs text-white/80">ID: {file.id}</span>
                                                <button
                                                    type="button"
                                                    className="shrink-0 rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
                                                    onClick={handleCopyId}
                                                    title={idCopied ? '已复制文件 ID' : '复制文件 ID'}
                                                    aria-label={idCopied ? '文件 ID 已复制' : '复制文件 ID'}
                                                >
                                                    {idCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                                                </button>
                                            </dd>
                                        </div>
                                    </dl>
                                </motion.div>
                            </motion.div>
                        )}
                    </AnimatePresence>

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
