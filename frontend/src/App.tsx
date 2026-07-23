import { Fragment, useState, useMemo, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { Button } from "./components/ui/Button";
import { FileCard } from "./components/ui/FileCard";
import { FolderCard, type FolderData } from "./components/ui/FolderCard";
import { UploadZone } from "./components/ui/UploadZone";
import { Search, RefreshCw, ArrowLeft, ChevronDown, ChevronRight, CheckSquare, Cloud, HardDrive, Database, Package, Network, FolderPlus, Upload } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { BulkActionToolbar } from "./components/ui/BulkActionToolbar";
import { useTranslation } from "react-i18next";
import { EmptyState } from "./components/ui/EmptyState";
import { LoginPage } from "./components/pages/LoginPage";
import { ViewToggle } from "./components/ui/ViewToggle";
import { FileMenu } from "./components/ui/FileMenu";
import { DeleteAlert } from "./components/ui/DeleteAlert";
import { FolderPromptModal } from "./components/ui/FolderPromptModal";
import { RenameModal } from "./components/ui/RenameModal";
import { MoveModal } from "./components/ui/MoveModal";
import { Notification, type NotificationType } from "./components/ui/Notification";
import { fileApi, type BatchDeletePreview, type BatchDeleteResult, type ChunkUploadSession, type FileData, type FolderAggregation, type FileQueryOptions, type StorageConfig, type StorageStats as StorageStatsType, type UploadCapabilities, type UploadTargetSnapshot } from "./services/api";
import { authService } from "./services/auth";
import type { QueueItem } from "./components/ui/UploadQueueModal";
import { LatestRequest } from "./services/latestRequest";
import { BoundedUploadQueue } from "./services/boundedUploadQueue";
import { createUploadTelemetry, updateUploadTelemetry } from "./services/uploadTelemetry";
import { describeFileViewState } from "./services/fileViewState";
import { buildFolderBreadcrumbs, parentFolder } from "./services/folderNavigation";
import { attachUploadSession, createUploadQueueInput, type UploadQueueInput } from "./services/uploadQueueInput";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";

const SettingsPage = lazy(() => import("./components/pages/SettingsPage").then(module => ({ default: module.SettingsPage })));
const TasksPage = lazy(() => import("./components/pages/TasksPage").then(module => ({ default: module.TasksPage })));
const PreviewModal = lazy(() => import("./components/ui/PreviewModal").then(module => ({ default: module.PreviewModal })));
const UploadQueueModal = lazy(() => import("./components/ui/UploadQueueModal").then(module => ({ default: module.UploadQueueModal })));
const CreateFolderModal = lazy(() => import("./components/ui/CreateFolderModal").then(module => ({ default: module.CreateFolderModal })));

const LazyFallback = () => (
  <div className="flex min-h-32 items-center justify-center text-muted-foreground">
    <RefreshCw className="h-5 w-5 animate-spin" />
  </div>
);

function App() {
  // 认证状态
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);

  const [files, setFiles] = useState<FileData[]>([]);
  const [folderAggregations, setFolderAggregations] = useState<FolderAggregation[]>([]);
  const [loading, setLoading] = useState(true);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [fileCursor, setFileCursor] = useState<string | null>(null);
  const [hasMoreFiles, setHasMoreFiles] = useState(false);
  const [loadingMoreFiles, setLoadingMoreFiles] = useState(false);
  const latestFileRequestRef = useRef(new LatestRequest());

  // 改用队列管理上传状态
  const [uploadQueue, setUploadQueue] = useState<QueueItem[]>([]);
  const [recoveredUploads, setRecoveredUploads] = useState<ChunkUploadSession[]>([]);
  const [resumingSessionIds, setResumingSessionIds] = useState<string[]>([]);
  const [cancellingRecoveredUpload, setCancellingRecoveredUpload] = useState<ChunkUploadSession | null>(null);
  const uploadManagerRef = useRef(new BoundedUploadQueue<UploadQueueInput<QueueItem, ChunkUploadSession>, void>(3, async (input, signal) => {
    const { item, folder, target, resumeSession } = input;
    setUploadQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'uploading' } : q));
    const upload = resumeSession
      ? fileApi.resumeChunkedUpload.bind(fileApi, item.file, resumeSession)
      : (onProgress: Parameters<typeof fileApi.uploadFile>[2], uploadSignal: AbortSignal) => fileApi.uploadFile(
          item.file,
          folder,
          onProgress,
          uploadSignal,
          target,
          session => attachUploadSession(input, session),
        );
    await upload(progress => {
      setUploadQueue(prev => prev.map(q => {
        if (q.id !== item.id) return q;
        const telemetry = updateUploadTelemetry(q.telemetry || createUploadTelemetry(progress.total), progress.loaded);
        return {
          ...q,
          status: progress.percent === 100 ? 'processing' : 'uploading',
          progress: progress.percent,
          loadedBytes: progress.loaded,
          totalBytes: progress.total,
          bytesPerSecond: telemetry.bytesPerSecond,
          etaSeconds: telemetry.etaSeconds,
          telemetry,
        };
      }));
    }, signal);
  }));
  const [isQueueModalOpen, setIsQueueModalOpen] = useState(false);
  const [isUploadQueuePaused, setIsUploadQueuePaused] = useState(false);
  const [uploadCapabilities, setUploadCapabilities] = useState<UploadCapabilities | null>(null);

  const [storageStats, setStorageStats] = useState<StorageStatsType | null>(null);
  const [storageConfig, setStorageConfig] = useState<StorageConfig | null>(null);

  // 通知状态
  const [notification, setNotification] = useState<{
    show: boolean;
    message: string;
    type: NotificationType;
  }>({
    show: false,
    message: "",
    type: "info"
  });

  const { t } = useTranslation();
  const [currentCategory, setCurrentCategory] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedFile, setSelectedFile] = useState<FileData | null>(null);
  const [deletingFile, setDeletingFile] = useState<FileData | null>(null);
  const [pendingBatchDelete, setPendingBatchDelete] = useState<{ fileIds: string[]; folderNames: string[] } | null>(null);
  const [batchDeletePreview, setBatchDeletePreview] = useState<BatchDeletePreview | null>(null);
  const [batchDeleteResult, setBatchDeleteResult] = useState<BatchDeleteResult | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null); // 当前选中的文件夹
  const [isNavigationTapShieldActive, setIsNavigationTapShieldActive] = useState(false);
  const navigationTapShieldTimerRef = useRef<number | null>(null);

  // 重命名状态
  const [renamingFile, setRenamingFile] = useState<FileData | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);

  // 移动状态
  const [movingFile, setMovingFile] = useState<FileData | null>(null);
  const [movingFolder, setMovingFolder] = useState<string | null>(null);
  const [isFoldersExpanded, setIsFoldersExpanded] = useState(false); // 文件夹区域折叠状态，默认折叠

  const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  // 排序状态
  const [sortConfig, setSortConfig] = useState<{ key: 'name' | 'date'; direction: 'asc' | 'desc' }>({
    key: 'date',
    direction: 'desc'
  });

  // 多选状态
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [selectedFolderNames, setSelectedFolderNames] = useState<string[]>([]);

  // 响应式列数监听
  const [columns, setColumns] = useState(2);

  const loadIncompleteUploads = useCallback(async (openWhenFound = false) => {
    try {
      const sessions = await fileApi.getIncompleteChunkUploads();
      setRecoveredUploads(sessions);
      if (openWhenFound && sessions.length > 0) setIsQueueModalOpen(true);
      return sessions;
    } catch (error: any) {
      if (error?.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('加载未完成上传失败:', error);
      }
      return [];
    }
  }, []);

  useEffect(() => {
    const updateColumns = () => {
      const width = window.innerWidth;
      // 对应 grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5
      if (width >= 1280) setColumns(5); // xl
      else if (width >= 1024) setColumns(4); // lg
      else if (width >= 768) setColumns(3); // md
      else setColumns(2); // default/sm
    };

    updateColumns();
    window.addEventListener('resize', updateColumns);
    return () => window.removeEventListener('resize', updateColumns);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setRecoveredUploads([]);
      setUploadCapabilities(null);
      return;
    }
    void loadIncompleteUploads(true);
    void fileApi.getUploadCapabilities()
      .then(setUploadCapabilities)
      .catch(error => console.error('加载上传能力失败:', error));
  }, [isAuthenticated, loadIncompleteUploads]);

  // 检查认证状态
  useEffect(() => {
    const checkAuth = async () => {
      try {
        // 检查认证/首次初始化状态
        const authStatus = await authService.getAuthStatus();
        setNeedsPassword(authStatus.passwordRequired);
        setSetupRequired(authStatus.setupRequired);

        if (authStatus.setupRequired) {
          setIsAuthenticated(false);
        } else if (!authStatus.passwordRequired) {
          // 不需要密码，直接进入（仅兼容历史/开发模式）
          setIsAuthenticated(true);
        } else if (authService.isAuthenticated()) {
          // 已有 token，验证是否有效
          const valid = await authService.verify();
          setIsAuthenticated(valid);
        }
      } catch (error) {
        console.error('检查认证状态失败:', error);
      } finally {
        setAuthChecking(false);
      }
    };

    checkAuth();
  }, []);

  const buildFileQueryOptions = useCallback((signal?: AbortSignal): FileQueryOptions => {
    let type: FileQueryOptions['type'];
    if (currentCategory === 'media') type = 'media';
    else if (['image', 'video', 'audio', 'document'].includes(currentCategory)) type = currentCategory as FileQueryOptions['type'];

    const folder = currentCategory === 'ytdlp' ? 'ytdlp' : (currentFolder ?? null);
    return {
      q: searchQuery,
      type,
      folder,
      favorite: currentCategory === 'favorites' ? true : undefined,
      sort: sortConfig.key,
      direction: sortConfig.direction,
      signal,
    };
  }, [currentCategory, currentFolder, searchQuery, sortConfig]);

  // 加载文件列表：新 generation 中止旧请求，且只有最新 generation 可提交。
  const loadFiles = useCallback(async () => {
    if (!isAuthenticated) return;
    const request = latestFileRequestRef.current.begin();
    const hadData = files.length > 0 || folderAggregations.length > 0;
    try {
      setLoading(true);
      setQueryError(null);
      const options = buildFileQueryOptions(request.signal);
      const includeFolders = currentCategory !== 'ytdlp';
      const [page, globalFolders] = await Promise.all([
        fileApi.getFilesPage(options),
        includeFolders
          ? fileApi.getFolderAggregations(options)
          : Promise.resolve([]),
      ]);
      if (!request.isCurrent()) return;
      setFiles(page.files);
      setFolderAggregations(globalFolders);
      setFileCursor(page.nextCursor);
      setHasMoreFiles(page.hasMore);
      setIsStale(false);
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      if (!request.isCurrent()) return;
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('加载文件失败:', error);
        setQueryError(error.message || '加载文件失败');
        setIsStale(hadData);
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [isAuthenticated, buildFileQueryOptions, currentFolder, currentCategory]);

  const loadMoreFiles = useCallback(async () => {
    if (!isAuthenticated || !hasMoreFiles || !fileCursor || loadingMoreFiles) return;
    const request = latestFileRequestRef.current.begin();
    try {
      setLoadingMoreFiles(true);
      const page = await fileApi.getFilesPage({ ...buildFileQueryOptions(request.signal), cursor: fileCursor });
      if (!request.isCurrent()) return;
      setFiles(prev => {
        const seen = new Set(prev.map(file => file.id));
        return [...prev, ...page.files.filter(file => !seen.has(file.id))];
      });
      setFileCursor(page.nextCursor);
      setHasMoreFiles(page.hasMore);
      setQueryError(null);
      setIsStale(false);
    } catch (error: any) {
      if (error?.name === 'AbortError' || !request.isCurrent()) return;
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('加载更多文件失败:', error);
        setQueryError(error.message || '加载更多文件失败');
        setIsStale(true);
      }
    } finally {
      if (request.isCurrent()) setLoadingMoreFiles(false);
    }
  }, [isAuthenticated, hasMoreFiles, fileCursor, loadingMoreFiles, buildFileQueryOptions]);

  // 加载存储统计
  const loadStorageStats = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const stats = await fileApi.getStorageStats();
      setStorageStats(stats);
    } catch (error: any) {
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('加载存储统计失败:', error);
      }
    }
  }, [isAuthenticated]);

  // 加载存储配置 (获取当前提供商)
  const loadStorageConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const config = await fileApi.getStorageConfig();
      setStorageConfig(config);
    } catch (error) {
      console.error('加载存储配置失败:', error);
    }
  }, [isAuthenticated]);

  // 认证成功后加载数据
  useEffect(() => {
    if (isAuthenticated) {
      loadFiles();
      loadStorageStats();
      loadStorageConfig();
    }
  }, [isAuthenticated, loadFiles, loadStorageStats, loadStorageConfig]);

  // 监听分类变化
  useEffect(() => {
    if (isAuthenticated) {
      loadFiles();
    }
  }, [currentCategory, isAuthenticated, loadFiles]);

  useEffect(() => {
    if (currentCategory === 'ytdlp') {
      setCurrentFolder(null);
    }
  }, [currentCategory]);

  useEffect(() => {
    return () => {
      if (navigationTapShieldTimerRef.current) {
        window.clearTimeout(navigationTapShieldTimerRef.current);
      }
    };
  }, []);

  const enterFolder = useCallback((folderName: string) => {
    setCurrentFolder(folderName);
    setIsNavigationTapShieldActive(true);

    if (navigationTapShieldTimerRef.current) {
      window.clearTimeout(navigationTapShieldTimerRef.current);
    }

    navigationTapShieldTimerRef.current = window.setTimeout(() => {
      setIsNavigationTapShieldActive(false);
      navigationTapShieldTimerRef.current = null;
    }, 450);
  }, []);

  // 登录处理
  const handleLogin = async (password: string) => {
    const result = await authService.login(password);
    if (result.success && !result.requiresTOTP) {
      setIsAuthenticated(true);
    }
    return result;
  };

  const handleInitialSetup = async (webPassword: string, telegramPin: string) => {
    const result = await authService.setup(webPassword, telegramPin);
    if (result.success) {
      setSetupRequired(false);
      setNeedsPassword(true);
      setIsAuthenticated(true);
    }
    return result;
  };

  const handleLogout = useCallback(async () => {
    uploadManagerRef.current.reset();
    await authService.logout();
    latestFileRequestRef.current.cancel();
    setIsAuthenticated(false);
    setFiles([]);
    setFolderAggregations([]);
    setUploadQueue([]);
    setRecoveredUploads([]);
    setResumingSessionIds([]);
    setIsUploadQueuePaused(false);
  }, []);

  // 派生上传状态
  const isUploading = useMemo(() => {
    return uploadQueue.some(item => item.status === 'pending' || item.status === 'uploading');
  }, [uploadQueue]);

  // 计算上传总进度 (用于 UploadZone 显示)
  const totalUploadProgress = useMemo(() => {
    // 只计算当前正在处理或已完成的项目
    const activeItems = uploadQueue.filter(i => i.status !== 'error');
    if (activeItems.length === 0) return 0;
    const total = activeItems.reduce((sum, item) => sum + item.progress, 0);
    return Math.round(total / activeItems.length);
  }, [uploadQueue]);

  // 上传文件处理
  const handleDrop = async (newFiles: File[]) => {
    if (newFiles.length === 0) return;

    if (newFiles.length > 1) {
      setPendingFiles(newFiles);
      setIsFolderModalOpen(true);
    } else {
      startUpload(newFiles, currentFolder || undefined);
    }
  };

  const handleToggleFolderFavorite = async (folderName: string) => {
    try {
      const result = await fileApi.toggleFolderFavorite(folderName);
      if (result.success) {
        setFiles(prev => prev.map(file =>
          file.folder && (file.folder === folderName || file.folder.startsWith(`${folderName}/`))
            ? { ...file, is_favorite: result.isFavorite }
            : file
        ));
        setFolderAggregations(prev => prev.map(folder =>
          folder.name === folderName || folder.name.startsWith(`${folderName}/`)
            ? { ...folder, isFavorite: result.isFavorite }
            : folder
        ));
        setNotification({
          show: true,
          message: result.isFavorite ? '已添加到收藏' : '已取消收藏',
          type: 'success'
        });
      }
    } catch (error: any) {
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('切换文件夹收藏状态失败:', error);
        setNotification({
          show: true,
          message: '操作失败',
          type: 'error'
        });
      }
    }
  };

  const startUpload = async (newFiles: File[], folder?: string) => {
    const targetSnapshot: UploadTargetSnapshot = {
      provider: activeStorageDisplay?.provider || storageConfig?.provider || 'local',
      accountId: storageConfig?.activeAccountId || null,
      accountName: activeStorageDisplay?.account || storageConfig?.activeAccountName || null,
      folder: folder || null,
    };
    // 1. 创建队列项
    const newItems: QueueItem[] = newFiles.map(file => ({
      id: `${file.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file,
      status: 'pending',
      progress: 0,
      totalBytes: file.size,
      loadedBytes: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      telemetry: createUploadTelemetry(file.size),
      targetLabel: `${activeStorageDisplay?.provider || storageConfig?.provider || '当前存储'} / ${activeStorageDisplay?.account || '当前账户'} / ${folder || '根目录'}`,
    }));

    // 2. 添加到队列
    setUploadQueue(prev => [...prev, ...newItems]);

    // 单文件也立即展示目标和进度，避免上传状态藏在页面局部。
    setIsQueueModalOpen(true);

    try {
      // 有界队列限制同时上传数量，避免大量文件把浏览器连接和服务器临时空间耗尽。
      const uploadPromises = newItems.map(async (item) => {
        try {
          await uploadManagerRef.current.enqueue(item.id, createUploadQueueInput(item, folder, targetSnapshot));
          setUploadQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'completed', progress: 100 } : q));
        } catch (err: any) {
          if (err?.name === 'AbortError') {
            setUploadQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'cancelled', error: '已取消' } : q));
            return;
          }
          console.error(`File ${item.file.name} upload failed:`, err);
          if (err.message === 'UNAUTHORIZED') {
            authService.clearToken();
            setIsAuthenticated(false);
          }
          setUploadQueue(prev => prev.map(q => q.id === item.id ? {
            ...q,
            status: 'error',
            error: err.message || '上传失败'
          } : q));
        }
      });

      await Promise.all(uploadPromises);

      // 5. 刷新列表
      await Promise.all([loadFiles(), loadStorageStats(), loadIncompleteUploads(false)]);

    } catch (error: any) {
      console.error('批量上传过程出错:', error);
    }
  };

  const handleResumeUpload = async (session: ChunkUploadSession, file: File) => {
    if (file.name !== session.filename || file.size !== session.totalSize) {
      setNotification({ show: true, message: '所选文件的名称或大小与原上传任务不一致', type: 'error' });
      return;
    }
    const item: QueueItem = {
      id: `resume-${session.uploadId}-${Date.now()}`,
      file,
      status: 'pending',
      progress: session.progress,
      loadedBytes: session.receivedBytes,
      totalBytes: session.totalSize,
      bytesPerSecond: 0,
      etaSeconds: null,
      telemetry: { ...createUploadTelemetry(session.totalSize), loadedBytes: session.receivedBytes },
      resumeSessionId: session.uploadId,
      targetLabel: `${session.targetAccountName || session.targetProvider} / ${session.folder || '根目录'}`,
    };
    setUploadQueue(prev => [...prev, item]);
    setResumingSessionIds(prev => [...prev, session.uploadId]);
    setIsQueueModalOpen(true);
    try {
      const input = createUploadQueueInput<QueueItem, ChunkUploadSession>(item, session.folder, {
        provider: session.targetProvider,
        accountId: session.targetAccountId,
        accountName: session.targetAccountName,
      });
      attachUploadSession(input, session);
      await uploadManagerRef.current.enqueue(item.id, input);
      setUploadQueue(prev => prev.map(entry => entry.id === item.id ? { ...entry, status: 'completed', progress: 100 } : entry));
      setRecoveredUploads(prev => prev.filter(entry => entry.uploadId !== session.uploadId));
      await Promise.all([loadFiles(), loadStorageStats()]);
    } catch (error: any) {
      const cancelled = error?.name === 'AbortError';
      setUploadQueue(prev => prev.map(entry => entry.id === item.id
        ? { ...entry, status: cancelled ? 'cancelled' : 'error', error: cancelled ? '已取消' : (error?.message || '续传失败') }
        : entry));
      await loadIncompleteUploads(false);
    } finally {
      setResumingSessionIds(prev => prev.filter(id => id !== session.uploadId));
    }
  };

  const handleCancelRecoveredUpload = async (session: ChunkUploadSession) => {
    setCancellingRecoveredUpload(session);
  };

  const confirmCancelRecoveredUpload = async () => {
    const session = cancellingRecoveredUpload;
    if (!session) return;
    setCancellingRecoveredUpload(null);
    try {
      const cancellation = await fileApi.cancelChunkUpload(session.uploadId);
      if (cancellation === 'busy') {
        setNotification({ show: true, message: '服务器正在完成该上传，暂时不能取消；请稍后刷新确认结果', type: 'info' });
        await loadIncompleteUploads(false);
        return;
      }
      setRecoveredUploads(prev => prev.filter(entry => entry.uploadId !== session.uploadId));
      setNotification({
        show: true,
        message: cancellation === 'cancelled' ? '上传会话已取消' : '上传会话已结束',
        type: 'success',
      });
    } catch (error: any) {
      setNotification({ show: true, message: error?.message || '取消上传会话失败', type: 'error' });
      await loadIncompleteUploads(false);
    }
  };

  // 最小化上传抽屉并清理此刻已结算的项目；活跃任务继续在后台运行。
  const handleCloseQueue = () => {
    setIsQueueModalOpen(false);
    const settledIds = new Set(uploadQueue
      .filter(item => ['completed', 'error', 'cancelled'].includes(item.status))
      .map(item => item.id));
    // 只清理关闭时已结算的条目，避免延迟回调误删随后加入的新上传。
    setTimeout(() => {
      setUploadQueue(prev => prev.filter(item => !settledIds.has(item.id)));
    }, 300);
  };

  const handleCancelUpload = (id: string) => {
    uploadManagerRef.current.cancel(id);
  };

  const handleToggleUploadQueuePause = () => {
    if (uploadManagerRef.current.isPaused()) {
      uploadManagerRef.current.resume();
      setIsUploadQueuePaused(false);
    } else {
      uploadManagerRef.current.pause();
      setIsUploadQueuePaused(true);
    }
  };

  const handleRetryUpload = async (id: string) => {
    setUploadQueue(prev => prev.map(item => item.id === id
      ? { ...item, status: 'pending', progress: 0, error: undefined }
      : item));
    try {
      await uploadManagerRef.current.retry(id);
      setUploadQueue(prev => prev.map(item => item.id === id
        ? { ...item, status: 'completed', progress: 100, error: undefined }
        : item));
      await Promise.all([loadFiles(), loadStorageStats()]);
    } catch (error: any) {
      const cancelled = error?.name === 'AbortError';
      setUploadQueue(prev => prev.map(item => item.id === id
        ? { ...item, status: cancelled ? 'cancelled' : 'error', error: cancelled ? '已取消' : (error?.message || '上传失败') }
        : item));
    }
  };

  const verifyDelete = (file: FileData) => {
    setDeletingFile(file);
  };

  const handleConfirmDelete = async () => {
    if (!deletingFile) return;
    try {
      await fileApi.deleteFile(deletingFile.id);
      setFiles((prev) => prev.filter((f) => f.id !== deletingFile.id));
      setDeletingFile(null);
      setNotification({ show: true, message: '文件已删除', type: 'success' });
      await loadStorageStats();
    } catch (error: any) {
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('删除失败:', error);
        setNotification({ show: true, message: error.message || '删除失败', type: 'error' });
        throw error;
      }
    }
  };

  const performBatchDelete = async () => {
    if (!batchDeletePreview) return;
    try {
      setLoading(true);
      const result = await fileApi.batchDelete(batchDeletePreview.confirmationToken);
      setBatchDeleteResult(result);

      // A 207 means the server already deleted some items. Always refresh server truth.
      await Promise.all([loadFiles(), loadStorageStats()]);
      if (result.status === 'partial') {
        const failedIds = new Set(result.failedFiles.map(file => file.id));
        setSelectedFileIds(prev => prev.filter(id => failedIds.has(id)));
        const failedFolderNames = new Set(
          files.filter(file => failedIds.has(file.id) && file.folder).map(file => file.folder!),
        );
        setSelectedFolderNames(prev => prev.filter(name => failedFolderNames.has(name)));
        setNotification({ show: true, message: result.message, type: 'error' });
        return;
      }

      setSelectedFileIds([]);
      setSelectedFolderNames([]);
      setIsSelectionMode(false);
      setPendingBatchDelete(null);
      setBatchDeletePreview(null);
      setNotification({ show: true, message: result.message || '删除完成', type: 'success' });
    } catch (error: any) {
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('批量删除失败:', error);
        setNotification({ show: true, message: error.message || '批量删除失败', type: 'error' });
        throw error;
      }
    } finally {
      setLoading(false);
    }
  };

  const handleBatchDelete = async (fileIds = selectedFileIds, folderNames = selectedFolderNames) => {
    if (fileIds.length === 0 && folderNames.length === 0) return;
    try {
      const preview = await fileApi.previewBatchDelete(fileIds, folderNames);
      setBatchDeletePreview(preview);
      setBatchDeleteResult(null);
      setPendingBatchDelete({ fileIds, folderNames });
    } catch (error: any) {
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        setNotification({ show: true, message: error.message || '获取删除影响范围失败', type: 'error' });
      }
    }
  };

  // 切换收藏状态
  const handleToggleFavorite = async (fileId: string) => {
    try {
      const result = await fileApi.toggleFavorite(fileId);
      if (result.success) {
        // 更新本地文件列表中的收藏状态
        setFiles(prev => prev.map(file => 
          file.id === fileId 
            ? { ...file, is_favorite: result.isFavorite }
            : file
        ));
        
        // 显示通知
        setNotification({
          show: true,
          message: result.isFavorite ? '已添加到收藏' : '已取消收藏',
          type: 'success'
        });
      }
    } catch (error: any) {
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('切换收藏状态失败:', error);
        setNotification({
          show: true,
          message: '操作失败',
          type: 'error'
        });
      }
    }
  };

  const handleShare = async (password: string, expiration: string) => {
    if (selectedFileIds.length !== 1 || selectedFolderNames.length > 0) {
      throw new Error("只能分享单个文件");
    }

    const fileId = selectedFileIds[0];
    try {
      const result = await fileApi.createShareLink(fileId, password, expiration);
      return result.link;
    } catch (error: any) {
      console.error("Share failed:", error);
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      }
      throw error;
    }
  };

  const toggleFileSelection = (id: string) => {
    setSelectedFileIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const toggleFolderSelection = (name: string) => {
    setSelectedFolderNames(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    );
  };

  // 重命名文件
  const handleFileRename = async (newName: string) => {
    if (!renamingFile) return;
    try {
      await fileApi.renameFile(renamingFile.id, newName);
      setFiles(prev => prev.map(f => f.id === renamingFile.id ? { ...f, name: newName } : f));
      setRenamingFile(null);
    } catch (error: any) {
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('重命名失败:', error);
        alert(error.message || '重命名失败');
      }
    }
  };

  // 重命名文件夹
  const handleFolderRename = async (newName: string) => {
    if (!renamingFolder) return;
    try {
      const result = await fileApi.renameFolder(renamingFolder, newName);
      const renamedPath = result.name;
      if (currentFolder && (currentFolder === renamingFolder || currentFolder.startsWith(`${renamingFolder}/`))) {
        setCurrentFolder(`${renamedPath}${currentFolder.slice(renamingFolder.length)}`);
      }
      setRenamingFolder(null);
      await loadFiles();
    } catch (error: any) {
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('重命名文件夹失败:', error);
        alert(error.message || '重命名文件夹失败');
      }
    }
  };

  // 创建空文件夹
  const handleCreateFolder = async (folderName: string) => {
    try {
      const finalPath = currentFolder ? `${currentFolder}/${folderName}` : folderName;
      await fileApi.createFolder(finalPath);
      setNotification({
        show: true,
        message: '文件夹创建成功',
        type: 'success'
      });
      // 刷新列表
      await loadFiles();
    } catch (error: any) {
      console.error('创建文件夹失败:', error);
      setNotification({
        show: true,
        message: error.message || '创建文件夹失败',
        type: 'error'
      });
    }
  };

  const filteredFiles = useMemo(() => {
    return files.filter(file => {
      const matchesCategory =
        file.name === '.folder' || // 占位文件始终允许通过，以便计算文件夹列表
        currentCategory === "favorites" ||
        currentCategory === "all" ||
        (currentCategory === "ytdlp" && file.folder === "ytdlp") ||
        (currentCategory === "media" && ["image", "video", "audio"].includes(file.type)) ||
        (currentCategory === "image" && file.type === "image") ||
        (currentCategory === "video" && file.type === "video") ||
        (currentCategory === "audio" && file.type === "audio") ||
        (currentCategory === "document" && !["image", "video", "audio"].includes(file.type));

      const matchesSearch = file.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (file.folder && file.folder.toLowerCase().includes(searchQuery.toLowerCase()));

      return matchesCategory && matchesSearch;
    });
  }, [files, currentCategory, searchQuery]);

  // 将数据库中的完整 folder 路径聚合成当前位置的直接子目录。
  const folders = useMemo(() => {
    if (currentCategory === 'ytdlp') {
      return [];
    }
    const prefix = currentFolder ? `${currentFolder}/` : '';
    const grouped = new Map<string, FolderData>();

    for (const aggregation of folderAggregations) {
      if (currentFolder && aggregation.name === currentFolder) continue;
      if (prefix && !aggregation.name.startsWith(prefix)) continue;
      const relative = prefix ? aggregation.name.slice(prefix.length) : aggregation.name;
      const childSegment = relative.split('/')[0];
      if (!childSegment) continue;
      const childPath = prefix ? `${currentFolder}/${childSegment}` : childSegment;
      const existing = grouped.get(childPath);
      const candidateFiles = aggregation.coverFile ? [aggregation.coverFile] : [];
      if (!existing) {
        grouped.set(childPath, {
          name: childPath,
          displayName: childSegment,
          files: candidateFiles,
          fileCount: aggregation.fileCount,
          coverFile: aggregation.coverFile || undefined,
          latestDate: aggregation.latestDate,
          isFavorite: aggregation.isFavorite,
        });
        continue;
      }
      existing.fileCount += aggregation.fileCount;
      existing.files.push(...candidateFiles);
      existing.isFavorite = !!existing.isFavorite && aggregation.isFavorite;
      if (!existing.latestDate || new Date(aggregation.latestDate) > new Date(existing.latestDate)) {
        existing.latestDate = aggregation.latestDate;
        existing.coverFile = aggregation.coverFile || existing.coverFile;
      }
    }

    const result = Array.from(grouped.values());

    // 排序逻辑
    return result.sort((a, b) => {
      let comparison = 0;
      if (sortConfig.key === 'name') {
        comparison = (a.displayName || a.name).localeCompare(b.displayName || b.name, 'zh-CN');
      } else {
        // 文件夹日期排序使用其中最新文件的日期
        const dateA = a.latestDate ? new Date(a.latestDate).getTime() : 0;
        const dateB = b.latestDate ? new Date(b.latestDate).getTime() : 0;
        comparison = dateA - dateB;
      }
      return sortConfig.direction === 'asc' ? comparison : -comparison;
    });
  }, [currentCategory, currentFolder, folderAggregations, sortConfig]);

  const visibleFolders = useMemo(() => {
    if (isFoldersExpanded) return folders;
    return folders.slice(0, columns);
  }, [folders, isFoldersExpanded, columns]);

  // 如果文件夹总数不超过一行，则不需要显示展开/折叠按钮
  const showFolderToggle = folders.length > columns;

  // 文件查询已经按当前位置精确过滤，排除目录占位索引即可展示。
  const looseFiles = useMemo(() => {
    const files = filteredFiles.filter(file => file.name !== '.folder');

    // 排序逻辑
    return files.sort((a, b) => {
      let comparison = 0;
      if (sortConfig.key === 'name') {
        comparison = a.name.localeCompare(b.name, 'zh-CN');
      } else {
        const dateA = new Date(a.created_at).getTime();
        const dateB = new Date(b.created_at).getTime();
        comparison = dateA - dateB;
      }
      return sortConfig.direction === 'asc' ? comparison : -comparison;
    });
  }, [filteredFiles, sortConfig, currentCategory]);

  // 当前显示的文件（在文件夹内时显示该文件夹的文件）
  const displayFiles = useMemo(() => {
    if (currentFolder) {
      return filteredFiles.filter(file => file.folder === currentFolder && file.name !== '.folder');
    }
    return looseFiles;
  }, [currentFolder, filteredFiles, looseFiles]);

  const mediaPreviewFiles = useMemo(() => {
    const base = currentFolder ? displayFiles : [...folders.flatMap(folder => folder.files.filter(file => file.name !== '.folder')), ...looseFiles];
    const seen = new Set<string>();
    return base.filter(file => {
      if (seen.has(file.id)) return false;
      seen.add(file.id);
      return file.type === 'image' || file.type === 'video';
    });
  }, [currentFolder, displayFiles, folders, looseFiles]);

  const allFolderNames = useMemo(() => {
    const names = new Set<string>();
    folderAggregations.forEach(folder => {
      const segments = folder.name.split('/');
      for (let index = 1; index <= segments.length; index++) {
        names.add(segments.slice(0, index).join('/'));
      }
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [folderAggregations]);

  const activeStorageDisplay = useMemo(() => {
    if (!storageConfig) return null;
    const providerLabels: Record<string, string> = {
      local: '本地存储',
      onedrive: 'OneDrive',
      google_drive: 'Google Drive',
      aliyun_oss: '阿里云 OSS',
      s3: 'S3',
      webdav: 'WebDAV',
    };
    const account = storageConfig.accounts.find(item => item.id === storageConfig.activeAccountId);
    return {
      provider: providerLabels[storageConfig.provider] || storageConfig.provider,
      account: account?.name || (storageConfig.provider === 'local' ? '服务器本地目录' : '未命名账户'),
    };
  }, [storageConfig]);

  const fileViewState = useMemo(() => describeFileViewState({
    folder: currentFolder,
    query: searchQuery,
    category: currentCategory,
    error: queryError,
    stale: isStale,
  }), [currentFolder, searchQuery, currentCategory, queryError, isStale]);

  const handleMoveFile = async (destinationFolder: string | null) => {
    if (!movingFile) return;
    try {
      const result = await fileApi.moveFile(movingFile.id, destinationFolder);
      if (result.success) {
        setFiles(prev => prev.map(f => f.id === movingFile.id ? { ...f, folder: destinationFolder || undefined } : f));
        setNotification({
          show: true,
          message: t("app.moveSuccess") || "移动成功",
          type: "success"
        });
      }
    } catch (error: any) {
      console.error("Move file failed:", error);
      setNotification({
        show: true,
        message: error.message || t("app.moveFailed") || "移动失败",
        type: "error"
      });
    } finally {
      setMovingFile(null);
    }
  };

  const handleMoveFolder = async (destinationFolder: string | null) => {
    if (!movingFolder) return;
    try {
      const result = await fileApi.moveFolder(movingFolder, destinationFolder);
      if (result.success) {
        const finalPath = result.folder;
        if (currentFolder && finalPath && (currentFolder === movingFolder || currentFolder.startsWith(`${movingFolder}/`))) {
          setCurrentFolder(`${finalPath}${currentFolder.slice(movingFolder.length)}`);
        }
        setNotification({
          show: true,
          message: t("app.moveSuccess") || "移动成功",
          type: "success"
        });
        await loadFiles();
      }
    } catch (error: any) {
      console.error("Move folder failed:", error);
      setNotification({
        show: true,
        message: error.message || t("app.moveFailed") || "移动文件夹失败",
        type: "error"
      });
    } finally {
      setMovingFolder(null);
    }
  };

  const previewFolderMove = useCallback((destinationFolder: string | null, signal: AbortSignal) => {
    if (!movingFolder) return Promise.reject(new Error('没有待移动的文件夹'));
    return fileApi.previewMoveFolder(movingFolder, destinationFolder, signal);
  }, [movingFolder]);

  // 正在检查认证状态
  if (authChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // 需要密码但未认证，显示登录页
  if (needsPassword && !isAuthenticated) {
    return <LoginPage onLogin={handleLogin} setupRequired={setupRequired} onSetup={handleInitialSetup} />;
  }

  return (
    <>
      <AppLayout onCategoryChange={setCurrentCategory} storageStats={storageStats} onLogout={handleLogout}>
        <div className="flex flex-col gap-8 max-w-7xl mx-auto min-h-full">

          {/* Main Content Area */}
          {currentCategory === "settings" ? (
            <Suspense fallback={<LazyFallback />}>
              <SettingsPage storageStats={storageStats} onSignedOut={() => setIsAuthenticated(false)} />
            </Suspense>
          ) : currentCategory === "tasks" ? (
            <Suspense fallback={<LazyFallback />}>
              <TasksPage onUnauthorized={() => setIsAuthenticated(false)} onOpenUploads={() => setIsQueueModalOpen(true)} />
            </Suspense>
          ) : (
            <>
              {/* Header Actions */}
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h2 className="text-3xl font-bold tracking-tight text-foreground">{t("app.title")}</h2>
                  <p className="text-muted-foreground mt-1">{t("app.subtitle")}</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="relative hidden md:block group">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
                    <input
                      className="h-10 w-64 rounded-full border border-border bg-background pl-9 pr-4 text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all shadow-sm focus:shadow-md"
                      placeholder={t("app.searchPlaceholder")}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 rounded-full md:hidden"
                    onClick={() => setIsMobileSearchOpen(open => !open)}
                    aria-label={t("app.mobileSearch")}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 rounded-full"
                    onClick={() => { loadFiles(); loadStorageStats(); }}
                    disabled={loading}
                    aria-label={t("app.refresh")}
                    title={t("app.refresh")}
                  >
                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  </Button>

                  {/* 多选切换按钮 */}
                  <Button
                    variant={isSelectionMode ? "secondary" : "ghost"}
                    size="sm"
                    className="h-11 px-4 text-sm flex items-center gap-2 touch-manipulation"
                    onClick={() => {
                      setIsSelectionMode(!isSelectionMode);
                      setSelectedFileIds([]);
                      setSelectedFolderNames([]);
                    }}
                  >
                    <CheckSquare className="h-4 w-4" />
                    <span>{isSelectionMode ? "退出选择" : "选择"}</span>
                  </Button>

                  {/* 排序按钮 */}
                  <div className="bg-muted/50 rounded-lg p-1 flex items-center gap-1">
                    <Button
                      variant={sortConfig.key === 'name' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-10 px-3 text-xs touch-manipulation"
                      onClick={() => setSortConfig(current => ({
                        key: 'name',
                        direction: current.key === 'name' && current.direction === 'asc' ? 'desc' : 'asc'
                      }))}
                    >
                      名称 {sortConfig.key === 'name' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </Button>
                    <Button
                      variant={sortConfig.key === 'date' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-10 px-3 text-xs touch-manipulation"
                      onClick={() => setSortConfig(current => ({
                        key: 'date',
                        direction: current.key === 'date' && current.direction === 'asc' ? 'desc' : 'asc'
                      }))}
                    >
                      日期 {sortConfig.key === 'date' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </Button>
                  </div>

                  <div className="bg-muted/50 rounded-lg">
                    <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
                  </div>
                </div>
              </div>
              {isMobileSearchOpen && (
                <div className="relative md:hidden">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    autoFocus
                    className="h-11 w-full rounded-xl border border-border bg-background pl-9 pr-10 text-sm outline-none focus:ring-2 focus:ring-primary/20"
                    placeholder={t("app.searchPlaceholder")}
                    value={searchQuery}
                    onChange={event => setSearchQuery(event.target.value)}
                  />
                  {searchQuery && <button className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground" onClick={() => setSearchQuery('')}>{t('app.cancel')}</button>}
                </div>
              )}

              {/* Upload Zone */}
              {activeStorageDisplay && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border bg-muted/25 px-4 py-3 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <Cloud className="h-4 w-4 shrink-0 text-primary" />
                    <span className="text-muted-foreground">当前存储范围与新任务默认目标</span>
                    <strong className="truncate">{activeStorageDisplay.provider} / {activeStorageDisplay.account}</strong>
                  </div>
                  <span className="text-xs text-muted-foreground">上传位置：{currentFolder || '根目录'}</span>
                </div>
              )}
              <UploadZone
                onDrop={handleDrop}
                uploading={isUploading}
                uploadProgress={totalUploadProgress}
                capabilities={uploadCapabilities}
              />
              {(uploadQueue.length > 0 || recoveredUploads.length > 0) && !isQueueModalOpen && (
                <div className="sticky bottom-4 z-40 flex justify-end pointer-events-none">
                  <Button className="pointer-events-auto gap-2 shadow-lg" onClick={() => setIsQueueModalOpen(true)}>
                    <Upload className="h-4 w-4" />
                    打开上传队列（{uploadQueue.filter(item => ['pending', 'uploading', 'processing'].includes(item.status)).length + recoveredUploads.length}）
                  </Button>
                </div>
              )}

              <div className="sticky top-0 z-30 -mx-4 px-4 pt-2">
                <BulkActionToolbar
                  isVisible={isSelectionMode}
                  selectedFilesCount={selectedFileIds.length}
                  selectedFoldersCount={selectedFolderNames.length}
                  onCancel={() => {
                    setIsSelectionMode(false);
                    setSelectedFileIds([]);
                    setSelectedFolderNames([]);
                  }}
                  onDelete={handleBatchDelete}
                  onShare={handleShare}
                  shareCapabilities={storageConfig?.capabilities}
                />
              </div>

              {/* Files View */}
              <div className="flex-1 flex flex-col mt-8">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold flex min-w-0 flex-wrap items-center gap-2">
                    {currentFolder ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11 rounded-full touch-manipulation"
                          onClick={() => setCurrentFolder(parentFolder(currentFolder))}
                          aria-label="返回上级目录"
                        >
                          <ArrowLeft className="h-4 w-4" />
                        </Button>
                        <button className="text-sm text-muted-foreground hover:text-foreground" onClick={() => setCurrentFolder(null)}>根目录</button>
                        {buildFolderBreadcrumbs(currentFolder).map(({ label: segment, path }) => {
                          return (
                            <Fragment key={path}>
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                              <button className="max-w-40 truncate text-sm hover:text-primary" onClick={() => setCurrentFolder(path)}>{segment}</button>
                            </Fragment>
                          );
                        })}
                        <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                          {folders.length} 个子目录，{displayFiles.length} 个文件
                        </span>
                        <Button variant="ghost" size="sm" className="h-10 px-3 text-xs" onClick={() => setIsCreateFolderModalOpen(true)}>
                          <FolderPlus className="h-3.5 w-3.5" />
                          新建子目录
                        </Button>
                      </>
                    ) : (
                      <div className="flex items-center gap-3">
                        {t("app.recent")}
                        <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                          {folders.length > 0 ? `${folders.length} 个文件夹, ` : ''}{looseFiles.length} 个文件
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-10 px-3 text-xs font-medium text-muted-foreground hover:text-primary transition-colors flex items-center gap-1.5 touch-manipulation"
                          onClick={() => setIsCreateFolderModalOpen(true)}
                        >
                          <FolderPlus className="h-3.5 w-3.5" />
                          创建文件夹
                        </Button>
                      </div>
                    )}
                  </h3>

                </div>

                {queryError && isStale && (
                  <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
                    <div className="flex items-center justify-between gap-4">
                      <span>{t('empty.stale.title')}：{queryError}</span>
                      <Button variant="outline" size="sm" onClick={() => void loadFiles()}>{t('empty.retry')}</Button>
                    </div>
                  </div>
                )}
                {loading && files.length === 0 && folderAggregations.length === 0 ? (
                  <div className="flex items-center justify-center py-20">
                    <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : queryError && !isStale ? (
                  <EmptyState kind={fileViewState.kind} onRetry={() => void loadFiles()} />
                ) : displayFiles.length === 0 && folders.length === 0 ? (
                  <EmptyState
                    kind={fileViewState.kind}
                    onRetry={() => void loadFiles()}
                    onClearSearch={() => setSearchQuery('')}
                    onClearFilter={() => setCurrentCategory('all')}
                  />
                ) : currentFolder ? (
                  /* 文件夹内容视图 */
                  <div className="space-y-8">
                    {folders.length > 0 && (
                      <div className={viewMode === "grid" ? "grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5" : "flex flex-col gap-2"}>
                        {visibleFolders.map(folder => (
                          <FolderCard
                            key={folder.name}
                            folder={folder}
                            onClick={() => enterFolder(folder.name)}
                            onRename={() => setRenamingFolder(folder.name)}
                            onToggleFavorite={() => handleToggleFolderFavorite(folder.name)}
                            onMove={() => setMovingFolder(folder.name)}
                            onDelete={() => handleBatchDelete([], [folder.name])}
                            isSelectionMode={isSelectionMode}
                            isSelected={selectedFolderNames.includes(folder.name)}
                            onSelect={toggleFolderSelection}
                          />
                        ))}
                      </div>
                    )}
                    {displayFiles.length > 0 && (
                      <div className={viewMode === "grid" ? "grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5" : "flex flex-col gap-2"}>
                        <AnimatePresence mode="wait">
                          {displayFiles.map((file) => (
                            <motion.div key={file.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                              {viewMode === "grid" ? (
                                <FileCard
                                  file={file}
                                  onPreview={() => setSelectedFile(file)}
                                  onDelete={() => verifyDelete(file)}
                                  onRename={() => setRenamingFile(file)}
                                  onToggleFavorite={() => handleToggleFavorite(file.id)}
                                  onMove={() => setMovingFile(file)}
                                  isSelectionMode={isSelectionMode}
                                  isSelected={selectedFileIds.includes(file.id)}
                                  onSelect={toggleFileSelection}
                                />
                              ) : (
                                <div
                                  className={`flex min-h-[64px] items-center gap-4 p-3 rounded-xl border ${selectedFileIds.includes(file.id) ? 'border-primary bg-primary/5' : 'border-border bg-card'} shadow-sm cursor-pointer group hover:bg-muted/50 transition-colors touch-manipulation`}
                                  onClick={() => isSelectionMode ? toggleFileSelection(file.id) : setSelectedFile(file)}
                                >
                                  <div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground uppercase">{file.type.slice(0, 3)}</div>
                                  <div className="flex-1 min-w-0"><h4 className="font-medium truncate">{file.name}</h4><p className="text-xs text-muted-foreground">{file.date}</p></div>
                                  <div className="text-sm font-medium tabular-nums text-muted-foreground">{file.size}</div>
                                  <FileMenu onDelete={() => verifyDelete(file)} onToggleFavorite={() => handleToggleFavorite(file.id)} isFavorite={!!file.is_favorite} />
                                </div>
                              )}
                            </motion.div>
                          ))}
                        </AnimatePresence>
                      </div>
                    )}
                  </div>
                ) : (
                  /* 主视图：文件夹 + 散文件 */
                  <div className="space-y-8">
                    {/* 文件夹区域 */}
                    {folders.length > 0 && (
                      <div className="space-y-4">
                        <div
                          className={`flex items-center gap-2 p-2 rounded-lg -ml-2 transition-colors w-full ${showFolderToggle ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                          onClick={() => showFolderToggle && setIsFoldersExpanded(!isFoldersExpanded)}
                        >
                          {showFolderToggle && (
                            <div className="p-1 rounded-md hover:bg-muted transition-colors">
                              {isFoldersExpanded ? (
                                <ChevronDown className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              )}
                            </div>
                          )}
                          <h4 className={`text-sm font-medium text-muted-foreground flex items-center gap-2 select-none ${!showFolderToggle ? 'pl-2' : ''}`}>
                            📁 文件夹
                            <span className="text-xs bg-muted px-2 py-0.5 rounded-full">
                              {folders.length}
                            </span>
                          </h4>
                        </div>

                        <div className={viewMode === "grid" ? "grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5 pb-4" : "flex flex-col gap-2 pb-4"}>
                          <AnimatePresence mode="popLayout">
                            {visibleFolders.map((folder) => (
                              <motion.div
                                key={folder.name}
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.9 }}
                                transition={{ duration: 0.2 }}
                                layout
                              >
                                <FolderCard
                                  folder={folder}
                                  onClick={() => enterFolder(folder.name)}
                                  onRename={() => setRenamingFolder(folder.name)}
                                  onToggleFavorite={() => handleToggleFolderFavorite(folder.name)}
                                  onMove={() => setMovingFolder(folder.name)}
                                  onDelete={() => handleBatchDelete([], [folder.name])}
                                  isSelectionMode={isSelectionMode}
                                  isSelected={selectedFolderNames.includes(folder.name)}
                                  onSelect={toggleFolderSelection}
                                />
                              </motion.div>
                            ))}
                          </AnimatePresence>
                        </div>
                      </div>
                    )}

                    {/* 散文件区域 */}
                    {looseFiles.length > 0 && (
                      <div>
                        {folders.length > 0 && (
                          <h4 className="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
                            📄 文件
                          </h4>
                        )}
                        <div className={viewMode === "grid" ? "grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5" : "flex flex-col gap-2"}>
                          <AnimatePresence mode="wait">
                            {looseFiles.map((file) => (
                              <motion.div
                                key={file.id}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.15 }}
                              >
                                {viewMode === "grid" ? (
                                  <FileCard
                                    file={file}
                                    onPreview={() => setSelectedFile(file)}
                                    onDelete={() => verifyDelete(file)}
                                    onRename={() => setRenamingFile(file)}
                                    onToggleFavorite={() => handleToggleFavorite(file.id)}
                                    onMove={() => setMovingFile(file)}
                                    isSelectionMode={isSelectionMode}
                                    isSelected={selectedFileIds.includes(file.id)}
                                    onSelect={toggleFileSelection}
                                  />
                                ) : (
                                  <div
                                    className={`flex min-h-[64px] items-center gap-4 p-3 rounded-xl border ${selectedFileIds.includes(file.id) ? 'border-primary bg-primary/5' : 'border-border bg-card'} shadow-sm cursor-pointer group hover:bg-muted/50 transition-colors touch-manipulation`}
                                    onClick={() => isSelectionMode ? toggleFileSelection(file.id) : setSelectedFile(file)}
                                  >
                                    {isSelectionMode && (
                                      <div className={`h-5 w-5 rounded-full border-2 flex items-center justify-center ${selectedFileIds.includes(file.id) ? 'bg-primary border-primary' : 'border-muted-foreground/30'}`}>
                                        {selectedFileIds.includes(file.id) && <div className="h-2 w-2 bg-white rounded-full" />}
                                      </div>
                                    )}
                                    <div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground uppercase tracking-wider group-hover:bg-background transition-colors">
                                      {file.type.slice(0, 3)}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <h4 className="font-medium truncate group-hover:text-primary transition-colors">{file.name}</h4>
                                      <div className="flex items-center gap-2">
                                        <p className="text-xs text-muted-foreground">{file.date}</p>
                                        <span className="text-[10px] text-muted-foreground/60">•</span>
                                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
                                          {file.source === 'onedrive' ? <Cloud className="h-2.5 w-2.5" /> : (file.source === 'google_drive' ? <Database className="h-2.5 w-2.5" /> : (file.source === 'aliyun_oss' ? <Database className="h-2.5 w-2.5" /> : (file.source === 's3' ? <Package className="h-2.5 w-2.5" /> : (file.source === 'webdav' ? <Network className="h-2.5 w-2.5" /> : <HardDrive className="h-2.5 w-2.5" />))))}
                                          <span>{file.source === 'onedrive' ? 'OneDrive' : (file.source === 'google_drive' ? 'Google Drive' : (file.source === 'aliyun_oss' ? 'Aliyun OSS' : (file.source === 's3' ? 'S3' : (file.source === 'webdav' ? 'WebDAV' : 'Local'))))}</span>
                                        </div>
                                      </div>
                                    </div>
                                    <div className="text-sm font-medium tabular-nums text-muted-foreground px-4">{file.size}</div>
                                    <div>
                                      <FileMenu onDelete={() => verifyDelete(file)} onToggleFavorite={() => handleToggleFavorite(file.id)} isFavorite={!!file.is_favorite} />
                                    </div>
                                  </div>
                                )}
                              </motion.div>
                            ))}
                          </AnimatePresence>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {hasMoreFiles && !loading && (
                  <div className="flex justify-center pt-8">
                    <Button
                      variant="outline"
                      onClick={loadMoreFiles}
                      disabled={loadingMoreFiles}
                      className="gap-2"
                    >
                      <RefreshCw className={`h-4 w-4 ${loadingMoreFiles ? 'animate-spin' : ''}`} />
                      {loadingMoreFiles ? '加载中…' : '加载更多'}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {isNavigationTapShieldActive && (
          <div
            className="fixed inset-0 z-[55] cursor-wait bg-transparent"
            aria-hidden="true"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onMouseUp={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onTouchStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        )}

        <Suspense fallback={null}>
          {selectedFile && (
            <PreviewModal
              file={selectedFile}
              onClose={() => setSelectedFile(null)}
              onToggleFavorite={handleToggleFavorite}
              files={mediaPreviewFiles}
              onNavigate={setSelectedFile}
            />
          )}
        </Suspense>

        {/* 这里的 isOpen 逻辑是：如果有正在上传的，或者用户没点关闭（且有内容），就显示？ */}
        {/* 现在的逻辑是：多文件触发 setIsQueueModalOpen(true)，关闭则 false。 */}
        <Suspense fallback={null}>
          {isQueueModalOpen && (
            <UploadQueueModal
              isOpen={isQueueModalOpen}
              onClose={handleCloseQueue}
              onCancel={handleCancelUpload}
              onRetry={handleRetryUpload}
              isPaused={isUploadQueuePaused}
              onTogglePause={handleToggleUploadQueuePause}
              items={uploadQueue}
              recoveredSessions={recoveredUploads.filter(session => !resumingSessionIds.includes(session.uploadId))}
              resumingSessionIds={resumingSessionIds}
              onResumeSession={handleResumeUpload}
              onCancelSession={handleCancelRecoveredUpload}
            />
          )}
        </Suspense>

        <DeleteAlert
          isOpen={!!deletingFile}
          onClose={() => setDeletingFile(null)}
          onConfirm={handleConfirmDelete}
          fileName={deletingFile?.name}
        />

        <DeleteAlert
          isOpen={!!pendingBatchDelete}
          onClose={() => { setPendingBatchDelete(null); setBatchDeletePreview(null); setBatchDeleteResult(null); }}
          onConfirm={performBatchDelete}
          itemCount={batchDeletePreview?.fileCount || 0}
          dataFileCount={batchDeletePreview?.dataFileCount || 0}
          placeholderCount={batchDeletePreview?.placeholderCount || 0}
          folderCount={batchDeletePreview?.folderCount || 0}
          totalSizeBytes={batchDeletePreview?.totalSizeBytes || 0}
          result={batchDeleteResult}
        />

        <ConfirmDialog
          isOpen={!!cancellingRecoveredUpload}
          title="取消可续传上传？"
          description={`将取消“${cancellingRecoveredUpload?.filename || ''}”的上传会话，并删除服务器已接收的分块。此操作无法撤销。`}
          confirmLabel="取消上传"
          onClose={() => setCancellingRecoveredUpload(null)}
          onConfirm={confirmCancelRecoveredUpload}
        />

        <RenameModal
          isOpen={!!renamingFile}
          onClose={() => setRenamingFile(null)}
          onConfirm={handleFileRename}
          currentName={renamingFile?.name || ''}
          type="file"
        />

        <RenameModal
          isOpen={!!renamingFolder}
          onClose={() => setRenamingFolder(null)}
          onConfirm={handleFolderRename}
          currentName={renamingFolder?.split('/').pop() || ''}
          type="folder"
        />

        <FolderPromptModal
          isOpen={isFolderModalOpen}
          onClose={() => setIsFolderModalOpen(false)}
          onConfirm={(folderName) => startUpload(pendingFiles, currentFolder ? `${currentFolder}/${folderName}` : folderName)}
          onCancel={() => startUpload(pendingFiles, currentFolder || undefined)}
          onRoot={() => startUpload(pendingFiles)}
          currentFolder={currentFolder}
        />

        <Suspense fallback={null}>
          {isCreateFolderModalOpen && (
            <CreateFolderModal
              isOpen={isCreateFolderModalOpen}
              onClose={() => setIsCreateFolderModalOpen(false)}
              onConfirm={handleCreateFolder}
              currentFolder={currentFolder}
            />
          )}
        </Suspense>

        <MoveModal
          isOpen={!!movingFile || !!movingFolder}
          onClose={() => {
            setMovingFile(null);
            setMovingFolder(null);
          }}
          onConfirm={(dest) => {
            if (movingFile) handleMoveFile(dest);
            if (movingFolder) handleMoveFolder(dest);
          }}
          currentFolder={movingFolder
            ? (movingFolder.includes('/') ? movingFolder.split('/').slice(0, -1).join('/') : null)
            : (movingFile?.folder || null)}
          folders={allFolderNames}
          title={movingFile ? t("file.move") : t("folder.move")}
          sourceFolder={movingFolder || undefined}
          isFolder={!!movingFolder}
          onPreview={movingFolder ? previewFolderMove : undefined}
        />
      </AppLayout>

      <Notification
        show={notification.show}
        message={notification.message}
        type={notification.type}
        onClose={() => setNotification(prev => ({ ...prev, show: false }))}
      />
    </>
  );
}

export default App;
