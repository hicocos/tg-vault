import { AboutPage } from './components/pages/AboutPage';
import { tr } from './i18n/runtime';
import { useState, useMemo, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { BotOfflineNotice } from "./components/layout/BotOfflineNotice";
import { Button } from "./components/ui/Button";
import { FilesPage } from "./components/pages/FilesPage";
import { type FolderData } from "./components/ui/FolderCard";
import { Upload } from "./components/ui/icons";
import { BulkActionToolbar } from "./components/ui/BulkActionToolbar";
import { useTranslation } from "react-i18next";
import { LoginPage } from "./components/pages/LoginPage";
import { FileTypeFilter, type FileTypeCategory } from "./components/ui/FileTypeFilter";
import { DeleteAlert } from "./components/ui/DeleteAlert";
import { RenameModal } from "./components/ui/RenameModal";
import { MoveModal } from "./components/ui/MoveModal";
import { Notification, type NotificationType } from "./components/ui/Notification";
import { fileApi, type BatchDeletePreview, type BatchDeleteResult, type ChunkUploadSession, type FileData, type FolderAggregation, type FileQueryOptions, type StorageConfig, type StorageStats as StorageStatsType, type UploadCapabilities } from "./services/api";
import { authService } from "./services/auth";
import { isUnauthorizedError } from "./services/apiActionError";
import type { QueueItem } from "./components/ui/UploadQueueModal";
import { LatestRequest } from "./services/latestRequest";
import { FileQueryController } from "./services/fileQueryController";
import { createBrowserFileQueryCache, type FileQuerySnapshot } from "./services/fileQueryCache";
import { BoundedUploadQueue } from "./services/boundedUploadQueue";
import { createUploadTelemetry, updateUploadTelemetry } from "./services/uploadTelemetry";
import { describeFileViewState } from "./services/fileViewState";
import { attachUploadSession, createUploadQueueInput, type UploadQueueInput } from "./services/uploadQueueInput";
import { createUploadTargetSnapshot } from "./services/uploadTargetSnapshot";
import { StorageStatisticsSynchronization } from "./services/storageStatisticsSynchronization";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { appRouteHref, parseAppRoute, routeForCategory, routeForSettings, type AppRoute } from "./services/appRoute";
import type { SettingsSectionId } from "./components/pages/settingsSections";
import { IndeterminateSpinner } from "./components/ui/IndeterminateSpinner";
import { UploadCenter } from "./components/pages/UploadCenter";
import { errorMessage, isErrorNamed } from "./services/unknownError";
import { useAuthSession } from "./hooks/useAuthSession";

const FILE_RENDER_WINDOW_SIZE = 200;

const SettingsPage = lazy(() => import("./components/pages/SettingsPage").then(module => ({ default: module.SettingsPage })));
const TasksPage = lazy(() => import("./components/pages/TasksPage").then(module => ({ default: module.TasksPage })));
const SubscriptionCenter = lazy(() => import("./components/pages/SubscriptionCenter").then(module => ({ default: module.SubscriptionCenter })));
const PreviewModal = lazy(() => import("./components/ui/PreviewModal").then(module => ({ default: module.PreviewModal })));
const UploadQueueModal = lazy(() => import("./components/ui/UploadQueueModal").then(module => ({ default: module.UploadQueueModal })));
const CreateFolderModal = lazy(() => import("./components/ui/CreateFolderModal").then(module => ({ default: module.CreateFolderModal })));

const LazyFallback = () => (
  <div className="flex min-h-32 items-center justify-center text-muted-foreground">
    <IndeterminateSpinner label={tr('files.loadingPage')} size="md" />
  </div>
);

function App() {
  const initialRoute = useMemo(() => parseAppRoute(window.location), []);
  const initialFileSnapshot = useMemo(() => {
    if (initialRoute.kind !== 'files') return null;
    return createBrowserFileQueryCache().get(JSON.stringify({
      currentCategory: initialRoute.category,
      currentFolder: initialRoute.folder,
      debouncedSearchQuery: initialRoute.query,
      sortConfig: { key: 'date', direction: 'desc' },
    }));
  }, [initialRoute]);

  const [files, setFiles] = useState<FileData[]>(() => initialFileSnapshot?.files ?? []);
  const [folderAggregations, setFolderAggregations] = useState<FolderAggregation[]>(() => initialFileSnapshot?.folders ?? []);
  const filesRef = useRef<FileData[]>(files);
  const folderAggregationsRef = useRef<FolderAggregation[]>(folderAggregations);
  const [loading, setLoading] = useState(() => initialFileSnapshot === null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [fileCursor, setFileCursor] = useState<string | null>(() => initialFileSnapshot?.nextCursor ?? null);
  const [hasMoreFiles, setHasMoreFiles] = useState(() => initialFileSnapshot?.hasMore ?? false);
  const [loadingMoreFiles, setLoadingMoreFiles] = useState(false);
  const latestFileRequestRef = useRef(new LatestRequest());
  const fileQueryControllerRef = useRef(new FileQueryController({ debounceMs: 0 }));
  const fileQueryCacheRef = useRef(createBrowserFileQueryCache());

  const applyFileQuerySnapshot = useCallback((snapshot: FileQuerySnapshot) => {
    filesRef.current = snapshot.files;
    folderAggregationsRef.current = snapshot.folders;
    setFiles(snapshot.files);
    setFolderAggregations(snapshot.folders);
    setFileCursor(snapshot.nextCursor);
    setHasMoreFiles(snapshot.hasMore);
  }, []);

  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => { folderAggregationsRef.current = folderAggregations; }, [folderAggregations]);

  const invalidateFileQueryCache = useCallback(() => {
    fileQueryCacheRef.current.invalidate();
  }, []);


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

  const resetAuthenticatedState = useCallback(() => {
    uploadManagerRef.current.reset();
    latestFileRequestRef.current.cancel();
    invalidateFileQueryCache();
    setFiles([]);
    setFolderAggregations([]);
    setUploadQueue([]);
    setRecoveredUploads([]);
    setResumingSessionIds([]);
    setIsUploadQueuePaused(false);
  }, [invalidateFileQueryCache]);
  const {
    isAuthenticated,
    needsPassword,
    setupRequired,
    telegramPinRequired,
    authChecking,
    login: handleLogin,
    setup: handleInitialSetup,
    signOut,
    markUnauthenticated,
  } = useAuthSession(resetAuthenticatedState);

  const [storageStats, setStorageStats] = useState<StorageStatsType | null>(null);
  const [storageConfig, setStorageConfig] = useState<StorageConfig | null>(null);
  const storageStatisticsSynchronizationRef = useRef(new StorageStatisticsSynchronization());

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
  const [currentCategory, setCurrentCategory] = useState(() => initialRoute.kind === 'files' ? initialRoute.category : initialRoute.kind);
  const [taskAccountId, setTaskAccountId] = useState<string | null>(() => initialRoute.kind === 'tasks' ? initialRoute.accountId : null);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [fileRenderWindow, setFileRenderWindow] = useState(0);
  const [selectedFile, setSelectedFile] = useState<FileData | null>(null);
  const [deletingFile, setDeletingFile] = useState<FileData | null>(null);
  const [pendingBatchDelete, setPendingBatchDelete] = useState<{ fileIds: string[]; folderNames: string[] } | null>(null);
  const [batchDeletePreview, setBatchDeletePreview] = useState<BatchDeletePreview | null>(null);
  const [batchDeleteResult, setBatchDeleteResult] = useState<BatchDeleteResult | null>(null);
  const [searchQuery, setSearchQuery] = useState(() => initialRoute.kind === 'files' ? initialRoute.query : '');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(searchQuery);
  const [currentFolder, setCurrentFolder] = useState<string | null>(() => initialRoute.kind === 'files' ? initialRoute.folder : null); // selected folder
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>(() => initialRoute.kind === 'settings' ? initialRoute.section : 'general');
  const [isNavigationTapShieldActive, setIsNavigationTapShieldActive] = useState(false);
  const navigationTapShieldTimerRef = useRef<number | null>(null);

  // 重命名状态
  const [renamingFile, setRenamingFile] = useState<FileData | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);

  // 移动状态
  const [movingFile, setMovingFile] = useState<FileData | null>(null);
  const [movingFolder, setMovingFolder] = useState<string | null>(null);
  const [isFoldersExpanded, setIsFoldersExpanded] = useState(false); // folder section starts collapsed

  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false);

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
  const [columns, setColumns] = useState(() => window.innerWidth <= 480 ? 1 : window.innerWidth <= 1200 ? 2 : window.innerWidth < 1600 ? 3 : 4);

  const clearFileInteractionState = useCallback(() => {
    setIsSelectionMode(false);
    setSelectedFileIds([]);
    setSelectedFolderNames([]);
    setSelectedFile(null);
    setDeletingFile(null);
    setPendingBatchDelete(null);
    setBatchDeletePreview(null);
    setBatchDeleteResult(null);
    setRenamingFile(null);
    setRenamingFolder(null);
    setMovingFile(null);
    setMovingFolder(null);
  }, []);

  const applyRoute = useCallback((route: AppRoute) => {
    clearFileInteractionState();
    if (route.kind === 'files') {
      setCurrentCategory(route.category);
      setCurrentFolder(route.folder);
      setSearchQuery(route.query);
      setTaskAccountId(null);
      return;
    }
    setCurrentCategory(route.kind);
    setCurrentFolder(null);
    setSearchQuery('');
    setTaskAccountId(route.kind === 'tasks' ? route.accountId : null);
    if (route.kind === 'settings') setSettingsSection(route.section);
  }, [clearFileInteractionState]);

  const navigateRoute = useCallback((route: AppRoute, replace = false) => {
    const href = appRouteHref(route);
    if (replace) window.history.replaceState({}, '', href);
    else window.history.pushState({}, '', href);
    applyRoute(route);
  }, [applyRoute]);

  useEffect(() => {
    if (initialRoute.needsReplace) navigateRoute(initialRoute, true);
    const handlePopState = () => applyRoute(parseAppRoute(window.location));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [applyRoute, initialRoute, navigateRoute]);

  const handleCategoryChange = useCallback((category: string) => {
    navigateRoute(routeForCategory(category));
  }, [navigateRoute]);

  const handleFileTypeChange = useCallback((category: FileTypeCategory) => {
    navigateRoute(routeForCategory(category, { folder: currentFolder, query: searchQuery }));
  }, [currentFolder, navigateRoute, searchQuery]);

  const navigateFolder = useCallback((folder: string | null) => {
    navigateRoute(routeForCategory(currentCategory, { folder, query: searchQuery }));
  }, [currentCategory, navigateRoute, searchQuery]);

  const syncCurrentFolderRoute = useCallback((folder: string | null) => {
    setCurrentFolder(folder);
    window.history.replaceState({}, '', appRouteHref(routeForCategory(currentCategory, { folder, query: searchQuery })));
  }, [currentCategory, searchQuery]);

  const updateSearchQuery = useCallback((query: string) => {
    clearFileInteractionState();
    setSearchQuery(query);
    if (!['upload', 'tasks', 'subscriptions', 'settings'].includes(currentCategory)) {
      window.history.replaceState({}, '', appRouteHref(routeForCategory(currentCategory, { folder: currentFolder, query })));
    }
  }, [clearFileInteractionState, currentCategory, currentFolder]);

  const handleSettingsSectionChange = useCallback((section: SettingsSectionId) => {
    navigateRoute(routeForSettings(section));
  }, [navigateRoute]);

  const loadIncompleteUploads = useCallback(async (openWhenFound = false) => {
    try {
      const sessions = await fileApi.getIncompleteChunkUploads();
      setRecoveredUploads(sessions);
      if (openWhenFound && sessions.length > 0) setIsQueueModalOpen(true);
      return sessions;
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        console.error('加载未完成上传失败:', error);
      }
      return [];
    }
  }, []);

  useEffect(() => {
    const updateColumns = () => {
      const width = window.innerWidth;
      // Match files.css exactly, including the inclusive mobile breakpoints.
      if (width <= 480) setColumns(1);
      else if (width <= 1200) setColumns(2);
      else if (width < 1600) setColumns(3);
      else setColumns(4);
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

  const buildFileQueryOptions = useCallback((signal?: AbortSignal): FileQueryOptions => {
    let type: FileQueryOptions['type'];
    if (currentCategory === 'media') type = 'media';
    else if (['image', 'video', 'audio', 'document'].includes(currentCategory)) type = currentCategory as FileQueryOptions['type'];

    const folder = currentFolder ?? null;
    return {
      q: debouncedSearchQuery,
      type,
      folder,
      favorite: currentCategory === 'favorites' ? true : undefined,
      sort: sortConfig.key,
      direction: sortConfig.direction,
      signal,
    };
  }, [currentCategory, currentFolder, debouncedSearchQuery, sortConfig]);

  // 加载文件列表：新 generation 中止旧请求，且只有最新 generation 可提交。
  const loadFiles = useCallback(async () => {
    if (!isAuthenticated) return;
    const request = latestFileRequestRef.current.begin();
    const hadData = filesRef.current.length > 0 || folderAggregationsRef.current.length > 0;
    try {
      setLoading(true);
      setQueryError(null);
      const options = buildFileQueryOptions(request.signal);
      const includeFolders = true;
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
    } catch (error: unknown) {
      if (isErrorNamed(error, 'AbortError')) return;
      if (!request.isCurrent()) return;
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        console.error('加载文件失败:', error);
        setQueryError(errorMessage(error, t('appCopy.loadFilesFailed')));
        setIsStale(hadData);
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [isAuthenticated, buildFileQueryOptions, currentFolder, currentCategory]);

  const refreshFilesAfterMutation = useCallback(async () => {
    invalidateFileQueryCache();
    await loadFiles();
  }, [invalidateFileQueryCache, loadFiles]);

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
    } catch (error: unknown) {
      if (isErrorNamed(error, 'AbortError') || !request.isCurrent()) return;
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        console.error('加载更多文件失败:', error);
        setQueryError(errorMessage(error) || t('appCopy.loadMoreFailed'));
        setIsStale(true);
      }
    } finally {
      setLoadingMoreFiles(false);
    }
  }, [isAuthenticated, hasMoreFiles, fileCursor, loadingMoreFiles, buildFileQueryOptions]);

  // 加载存储统计
  const loadStorageStats = useCallback(async (expectedAccountId?: string | null) => {
    if (!isAuthenticated) return;
    const request = storageStatisticsSynchronizationRef.current.begin(expectedAccountId);
    try {
      const stats = await fileApi.getStorageStats();
      const accepted = request.accept(stats);
      if (accepted) setStorageStats(stats);
      else if (expectedAccountId !== undefined) throw new Error(t('appCopy.storageAccountMismatch'));
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        console.error('加载存储统计失败:', error);
        if (expectedAccountId !== undefined) throw error;
      }
    }
  }, [isAuthenticated]);

  const handleStorageConfigChanged = useCallback((config: StorageConfig) => {
    const targetChanged = storageConfig !== null
      && (storageConfig.provider !== config.provider || storageConfig.activeAccountId !== config.activeAccountId);
    setStorageConfig(config);
    if (targetChanged) setStorageStats(null);
  }, [storageConfig]);

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

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery), 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  // 认证和查询条件由单一 effect 驱动；先恢复短期缓存，再在后台校验服务器最新数据。
  useEffect(() => {
    if (!isAuthenticated) return;
    const controller = fileQueryControllerRef.current;
    const queryKey = JSON.stringify({ currentCategory, currentFolder, debouncedSearchQuery, sortConfig });
    const cached = fileQueryCacheRef.current.get(queryKey);
    if (cached) {
      applyFileQuerySnapshot(cached);
      setQueryError(null);
      setIsStale(false);
    }
    controller.schedule(queryKey, async signal => {
      const request = latestFileRequestRef.current.begin();
      signal.addEventListener('abort', () => latestFileRequestRef.current.cancel(), { once: true });
      const hadData = cached !== null || files.length > 0 || folderAggregations.length > 0;
      try {
        setLoading(!cached);
        setQueryError(null);
        const options = buildFileQueryOptions(request.signal);
        const includeFolders = true;
        const [page, globalFolders] = await Promise.all([
          fileApi.getFilesPage(options),
          includeFolders ? fileApi.getFolderAggregations(options) : Promise.resolve([]),
        ]);
        if (!request.isCurrent()) throw new DOMException('superseded', 'AbortError');
        const snapshot: FileQuerySnapshot = {
          files: page.files,
          folders: globalFolders,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
        applyFileQuerySnapshot(snapshot);
        fileQueryCacheRef.current.set(queryKey, snapshot);
        setIsStale(false);
        return snapshot;
      } catch (error: unknown) {
        if (!isErrorNamed(error, 'AbortError') && request.isCurrent()) {
          if (isUnauthorizedError(error)) {
            authService.invalidateSession(error.status);
          } else {
            setQueryError(errorMessage(error, t('appCopy.loadFilesFailed')));
            setIsStale(hadData);
          }
        }
        throw error;
      } finally {
        if (request.isCurrent()) setLoading(false);
      }
    }).catch(() => undefined);
    return () => controller.cancel();
  }, [isAuthenticated, currentCategory, currentFolder, debouncedSearchQuery, sortConfig, buildFileQueryOptions, applyFileQuerySnapshot, invalidateFileQueryCache]);

  useEffect(() => {
    if (isAuthenticated) {
      loadStorageStats();
      loadStorageConfig();
    }
  }, [isAuthenticated, loadStorageStats, loadStorageConfig]);

  useEffect(() => {
    return () => {
      if (navigationTapShieldTimerRef.current) {
        window.clearTimeout(navigationTapShieldTimerRef.current);
      }
    };
  }, []);

  const enterFolder = useCallback((folderName: string) => {
    navigateFolder(folderName);
    setIsNavigationTapShieldActive(true);

    if (navigationTapShieldTimerRef.current) {
      window.clearTimeout(navigationTapShieldTimerRef.current);
    }

    navigationTapShieldTimerRef.current = window.setTimeout(() => {
      setIsNavigationTapShieldActive(false);
      navigationTapShieldTimerRef.current = null;
    }, 450);
  }, [navigateFolder]);

  const handleLogout = useCallback(async () => {
    uploadManagerRef.current.reset();
    await signOut();
    latestFileRequestRef.current.cancel();
    invalidateFileQueryCache();
    setFiles([]);
    setFolderAggregations([]);
    setUploadQueue([]);
    setRecoveredUploads([]);
    setResumingSessionIds([]);
    setIsUploadQueuePaused(false);
  }, [invalidateFileQueryCache, signOut]);

  // 派生上传状态
  const isUploading = useMemo(() => {
    return uploadQueue.some(item => item.status === 'pending' || item.status === 'uploading');
  }, [uploadQueue]);

  // 计算上传总进度（上传中心与队列摘要共用）
  const totalUploadProgress = useMemo(() => {
    // 只计算当前正在处理或已完成的项目
    const activeItems = uploadQueue.filter(i => i.status !== 'error');
    if (activeItems.length === 0) return 0;
    const total = activeItems.reduce((sum, item) => sum + item.progress, 0);
    return Math.round(total / activeItems.length);
  }, [uploadQueue]);

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
        invalidateFileQueryCache();
        setNotification({
          show: true,
          message: t(result.isFavorite ? 'files.favoriteAdded' : 'files.favoriteRemoved'),
          type: 'success'
        });
      }
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        console.error('切换文件夹收藏状态失败:', error);
        setNotification({
          show: true,
          message: t('errors.fallback'),
          type: 'error'
        });
      }
    }
  };

  const startUpload = async (newFiles: File[], folder?: string) => {
    if (!storageConfig) {
      setNotification({ show: true, message: t('appCopy.uploadTargetUnavailable'), type: 'error' });
      return;
    }
    const targetSnapshot = createUploadTargetSnapshot(storageConfig, activeStorageDisplay?.provider || null, folder);
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
      targetLabel: targetSnapshot.label,
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
        } catch (err: unknown) {
          if (isErrorNamed(err, 'AbortError')) {
            setUploadQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'cancelled', error: t('files.uploadCancelled') } : q));
            return;
          }
          console.error(`File ${item.file.name} upload failed:`, err);
          if (isUnauthorizedError(err)) {
            authService.invalidateSession(err.status);
          }
          setUploadQueue(prev => prev.map(q => q.id === item.id ? {
            ...q,
            status: 'error',
            error: errorMessage(err, t('files.uploadFailed'))
          } : q));
        }
      });

      await Promise.all(uploadPromises);

      // 5. 文件数据已变化，清掉各分类/目录快照后刷新当前视图。
      invalidateFileQueryCache();
      await Promise.all([loadFiles(), loadStorageStats(), loadIncompleteUploads(false)]);

    } catch (error: unknown) {
      console.error('批量上传过程出错:', error);
    }
  };

  const handleUploadCenterFiles = useCallback((newFiles: File[], folder?: string) => {
    if (newFiles.length === 0) return;
    void startUpload(newFiles, folder);
  }, [startUpload]);

  const handleResumeUpload = async (session: ChunkUploadSession, file: File) => {
    if (file.name !== session.filename || file.size !== session.totalSize) {
      setNotification({ show: true, message: t('appCopy.resumeMismatch'), type: 'error' });
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
      targetLabel: `${session.targetAccountName || session.targetProvider} / ${session.folder || t('files.root')}`,
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
      invalidateFileQueryCache();
      await Promise.all([loadFiles(), loadStorageStats()]);
    } catch (error: unknown) {
      const cancelled = isErrorNamed(error, 'AbortError');
      setUploadQueue(prev => prev.map(entry => entry.id === item.id
        ? { ...entry, status: cancelled ? 'cancelled' : 'error', error: cancelled ? t('files.uploadCancelled') : errorMessage(error, t('appCopy.resumeFailed')) }
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
        setNotification({ show: true, message: t('appCopy.uploadCompleting'), type: 'info' });
        await loadIncompleteUploads(false);
        return;
      }
      setRecoveredUploads(prev => prev.filter(entry => entry.uploadId !== session.uploadId));
      setNotification({
        show: true,
        message: cancellation === 'cancelled' ? t('appCopy.uploadSessionCancelled') : t('appCopy.uploadSessionEnded'),
        type: 'success',
      });
    } catch (error: unknown) {
      setNotification({ show: true, message: errorMessage(error, t('appCopy.cancelUploadFailed')), type: 'error' });
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
      invalidateFileQueryCache();
      await Promise.all([loadFiles(), loadStorageStats()]);
    } catch (error: unknown) {
      const cancelled = isErrorNamed(error, 'AbortError');
      setUploadQueue(prev => prev.map(item => item.id === id
        ? { ...item, status: cancelled ? 'cancelled' : 'error', error: cancelled ? t('files.uploadCancelled') : (errorMessage(error, t('files.uploadFailed'))) }
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
      invalidateFileQueryCache();
      setDeletingFile(null);
      setNotification({ show: true, message: t('files.deleted'), type: 'success' });
      await loadStorageStats();
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        console.error('删除失败:', error);
        setNotification({ show: true, message: errorMessage(error) || t('files.deleteFailed'), type: 'error' });
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
      invalidateFileQueryCache();
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
      setNotification({ show: true, message: result.message || t('appCopy.deleteComplete'), type: 'success' });
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        console.error('批量删除失败:', error);
        setNotification({ show: true, message: errorMessage(error) || t('appCopy.bulkDeleteFailed'), type: 'error' });
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
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        setNotification({ show: true, message: errorMessage(error) || t('appCopy.deletePreviewFailed'), type: 'error' });
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
        invalidateFileQueryCache();
        
        // 显示通知
        setNotification({
          show: true,
          message: t(result.isFavorite ? 'files.favoriteAdded' : 'files.favoriteRemoved'),
          type: 'success'
        });
      }
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        console.error('切换收藏状态失败:', error);
        setNotification({
          show: true,
          message: t('errors.fallback'),
          type: 'error'
        });
      }
    }
  };

  const handleShare = async (password: string, expiration: string) => {
    if (selectedFileIds.length !== 1 || selectedFolderNames.length > 0) {
      throw new Error(t('files.shareSingleOnly'));
    }

    const fileId = selectedFileIds[0];
    try {
      const result = await fileApi.createShareLink(fileId, password, expiration);
      return result.link;
    } catch (error: unknown) {
      console.error("Share failed:", error);
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
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
      invalidateFileQueryCache();
      setRenamingFile(null);
      await refreshFilesAfterMutation();
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        console.error('重命名失败:', error);
        setNotification({
          show: true,
          message: errorMessage(error) || t('files.renameFailed'),
          type: 'error'
        });
      }
      throw error;
    }
  };

  // 重命名文件夹
  const handleFolderRename = async (newName: string) => {
    if (!renamingFolder) return;
    try {
      const result = await fileApi.renameFolder(renamingFolder, newName);
      const renamedPath = result.name;
      if (currentFolder && (currentFolder === renamingFolder || currentFolder.startsWith(`${renamingFolder}/`))) {
        syncCurrentFolderRoute(`${renamedPath}${currentFolder.slice(renamingFolder.length)}`);
      }
      setRenamingFolder(null);
      await refreshFilesAfterMutation();
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        authService.invalidateSession(error.status);
      } else {
        console.error('重命名文件夹失败:', error);
        setNotification({
          show: true,
          message: errorMessage(error) || t('appCopy.renameFolderFailed'),
          type: 'error'
        });
      }
      throw error;
    }
  };

  // 创建空文件夹
  const handleCreateFolder = async (folderName: string) => {
    try {
      const finalPath = currentFolder ? `${currentFolder}/${folderName}` : folderName;
      await fileApi.createFolder(finalPath);
      setNotification({
        show: true,
        message: t('files.folderCreated'),
        type: 'success'
      });
      // 刷新列表
      await refreshFilesAfterMutation();
    } catch (error: unknown) {
      console.error('创建文件夹失败:', error);
      setNotification({
        show: true,
        message: errorMessage(error, t('files.createFolderFailed')),
        type: 'error'
      });
      throw error;
    }
  };

  const filteredFiles = useMemo(() => {
    return files.filter(file => {
      const matchesCategory =
        file.name === '.folder' || // 占位文件始终允许通过，以便计算文件夹列表
        (currentCategory === "favorites" && file.is_favorite === true) ||
        currentCategory === "all" ||
        (currentCategory === "media" && ["image", "video", "audio"].includes(file.type)) ||
        (currentCategory === "image" && file.type === "image") ||
        (currentCategory === "video" && file.type === "video") ||
        (currentCategory === "audio" && file.type === "audio") ||
        (currentCategory === "document" && !["image", "video", "audio"].includes(file.type));

      const matchesSearch = file.name.toLowerCase().includes(debouncedSearchQuery.toLowerCase()) ||
        (file.folder && file.folder.toLowerCase().includes(debouncedSearchQuery.toLowerCase()));

      return matchesCategory && matchesSearch;
    });
  }, [files, currentCategory, debouncedSearchQuery]);

  // 将数据库中的完整 folder 路径聚合成当前位置的直接子目录。
  const folders = useMemo(() => {
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

  const folderColumns = viewMode === 'list' ? 1 : columns;
  const visibleFolders = useMemo(() => {
    if (isFoldersExpanded) return folders;
    return folders.slice(0, folderColumns);
  }, [folders, isFoldersExpanded, folderColumns]);

  const showFolderToggle = folders.length > folderColumns;

  // The API already returns a globally sorted cursor page. Preserve that order.
  const looseFiles = useMemo(() => {
    return filteredFiles.filter(file => file.name !== '.folder');
  }, [filteredFiles]);

  // Nested folders preserve the same authoritative server order.
  const displayFiles = useMemo(() => {
    if (currentFolder) {
      return filteredFiles.filter(file => file.folder === currentFolder && file.name !== '.folder');
    }
    return looseFiles;
  }, [currentFolder, filteredFiles, looseFiles]);

  useEffect(() => setFileRenderWindow(0), [currentCategory, currentFolder, debouncedSearchQuery, sortConfig]);
  const displayedFileSource = currentFolder ? displayFiles : looseFiles;
  const renderedFiles = useMemo(() => {
    const start = fileRenderWindow * FILE_RENDER_WINDOW_SIZE;
    return displayedFileSource.slice(start, start + FILE_RENDER_WINDOW_SIZE);
  }, [displayedFileSource, fileRenderWindow]);
  const fileRenderWindowCount = Math.max(1, Math.ceil(displayedFileSource.length / FILE_RENDER_WINDOW_SIZE));

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

  const providerLabels = useMemo<Record<string, string>>(() => ({
    local: t('appCopy.localStorage'),
    onedrive: 'OneDrive',
    google_drive: 'Google Drive',
    aliyun_oss: 'Alibaba Cloud OSS',
    s3: 'S3',
    webdav: 'WebDAV',
    openlist: 'OpenList',
  }), [t]);

  const activeStorageDisplay = useMemo(() => {
    if (!storageConfig) return null;
    const account = storageConfig.accounts.find(item => item.id === storageConfig.activeAccountId);
    return {
      provider: providerLabels[storageConfig.provider] || storageConfig.provider,
      account: account?.name || (storageConfig.provider === 'local' ? t('appCopy.localDirectory') : t('appCopy.unnamedAccount')),
    };
  }, [storageConfig, t, providerLabels]);

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
        await refreshFilesAfterMutation();
        setNotification({
          show: true,
          message: t("app.moveSuccess"),
          type: "success"
        });
      }
    } catch (error: unknown) {
      console.error("Move file failed:", error);
      setNotification({
        show: true,
        message: errorMessage(error) || t("app.moveFailed"),
        type: "error"
      });
      throw error;
    }
  };

  const handleMoveFolder = async (destinationFolder: string | null) => {
    if (!movingFolder) return;
    try {
      const result = await fileApi.moveFolder(movingFolder, destinationFolder);
      if (result.success) {
        const finalPath = result.folder;
        if (currentFolder && finalPath && (currentFolder === movingFolder || currentFolder.startsWith(`${movingFolder}/`))) {
          syncCurrentFolderRoute(`${finalPath}${currentFolder.slice(movingFolder.length)}`);
        }
        setNotification({
          show: true,
          message: t("app.moveSuccess"),
          type: "success"
        });
        await refreshFilesAfterMutation();
      }
    } catch (error: unknown) {
      console.error("Move folder failed:", error);
      setNotification({
        show: true,
        message: errorMessage(error) || t("app.moveFailed"),
        type: "error"
      });
      throw error;
    }
  };

  const previewFolderMove = useCallback((destinationFolder: string | null, signal: AbortSignal) => {
    if (!movingFolder) return Promise.reject(new Error(t('appCopy.folderMoveMissing')));
    return fileApi.previewMoveFolder(movingFolder, destinationFolder, signal);
  }, [movingFolder, t]);

  // 正在检查认证状态
  if (authChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <IndeterminateSpinner label={t('auth.signingIn')} size="lg" />
      </div>
    );
  }

  // 需要密码但未认证，显示登录页
  if (needsPassword && !isAuthenticated) {
    return <LoginPage onLogin={handleLogin} setupRequired={setupRequired} telegramPinRequired={telegramPinRequired} onSetup={handleInitialSetup} />;
  }

  return (
    <>
      <AppLayout activeCategory={currentCategory} onCategoryChange={handleCategoryChange} storageStats={storageStats} onLogout={handleLogout}>
        <div className="flex min-w-0 flex-col min-h-full">
          <BotOfflineNotice settingsPolling={currentCategory === 'settings' && settingsSection === 'telegram'}
            onOpenSettings={() => navigateRoute(routeForSettings('telegram'))} />

          {/* Main Content Area */}
          {currentCategory === "about" ? <AboutPage /> : currentCategory === "settings" ? (
            <Suspense fallback={<LazyFallback />}>
              <SettingsPage
                storageStats={storageStats}
                onSignedOut={markUnauthenticated}
                onOpenTasksForAccount={(accountId) => navigateRoute({ kind: 'tasks', accountId, needsReplace: false })}
                onStorageConfigChanged={handleStorageConfigChanged}
                onStorageStatsRefresh={loadStorageStats}
                activeSection={settingsSection}
                onSectionChange={handleSettingsSectionChange}
              />
            </Suspense>
          ) : currentCategory === "subscriptions" ? (
            <Suspense fallback={<LazyFallback />}>
              <SubscriptionCenter onUnauthorized={markUnauthenticated} />
            </Suspense>
          ) : currentCategory === "tasks" ? (
            <Suspense fallback={<LazyFallback />}>
              <TasksPage onUnauthorized={markUnauthenticated} onOpenUploads={() => setIsQueueModalOpen(true)} onShowAllTasks={() => navigateRoute(routeForCategory('tasks'))} initialAccountId={taskAccountId} />
            </Suspense>
          ) : currentCategory === "upload" ? (
            <UploadCenter
              onUpload={handleUploadCenterFiles}
              uploading={isUploading}
              uploadProgress={totalUploadProgress}
              capabilities={uploadCapabilities}
              storageTarget={activeStorageDisplay}
              ready={!!storageConfig}
              folders={allFolderNames}
              queue={uploadQueue}
              recoveredUploadCount={recoveredUploads.length}
              onOpenQueue={() => setIsQueueModalOpen(true)}
            />
          ) : (
            <FilesPage
              currentCategory={currentCategory}
              currentFolder={currentFolder}
              searchQuery={searchQuery}
              onSearchChange={updateSearchQuery}
              filterControl={<FileTypeFilter value={currentCategory} onChange={handleFileTypeChange} />}
              onClearFilter={() => navigateRoute(routeForCategory('all', { folder: currentFolder, query: '' }))}
              sortConfig={sortConfig}
              onSort={key => setSortConfig(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }))}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onUpload={() => handleCategoryChange('upload')}
              onRefresh={() => { void loadFiles(); void loadStorageStats(); }}
              onCreateFolder={() => setIsCreateFolderModalOpen(true)}
              onNavigateFolder={navigateFolder}
              folders={folders}
              visibleFolders={visibleFolders}
              isFoldersExpanded={isFoldersExpanded}
              showFolderToggle={showFolderToggle}
              onToggleFolders={() => setIsFoldersExpanded(expanded => !expanded)}
              renderedFiles={renderedFiles}
              displayedFileCount={displayedFileSource.length}
              loading={loading}
              initialEmpty={files.length === 0 && folderAggregations.length === 0}
              queryError={queryError}
              isStale={isStale}
              emptyKind={fileViewState.kind}
              onOpenFolder={enterFolder}
              onRenameFolder={setRenamingFolder}
              onFavoriteFolder={name => void handleToggleFolderFavorite(name)}
              onMoveFolder={setMovingFolder}
              onDeleteFolder={storageConfig?.capabilities.userDelete !== false ? name => void handleBatchDelete([], [name]) : undefined}
              onPreviewFile={setSelectedFile}
              onRenameFile={setRenamingFile}
              onFavoriteFile={id => void handleToggleFavorite(id)}
              onMoveFile={setMovingFile}
              onDeleteFile={storageConfig?.capabilities.userDelete !== false ? verifyDelete : undefined}
              selection={{
                active: isSelectionMode,
                fileIds: selectedFileIds,
                folderNames: selectedFolderNames,
                onToggle: () => {
                  setIsSelectionMode(active => !active);
                  setSelectedFileIds([]);
                  setSelectedFolderNames([]);
                },
                onFile: toggleFileSelection,
                onFolder: toggleFolderSelection,
                onSelectVisible: selected => {
                  // Only the current rendered window and expanded folder rows;
                  // never imply selection of unloaded cursor results.
                  const visibleFileIds = renderedFiles.map(file => file.id);
                  const visibleFolderNames = visibleFolders.map(folder => folder.name);
                  setSelectedFileIds(current => selected
                    ? Array.from(new Set([...current, ...visibleFileIds]))
                    : current.filter(id => !visibleFileIds.includes(id)));
                  setSelectedFolderNames(current => selected
                    ? Array.from(new Set([...current, ...visibleFolderNames]))
                    : current.filter(name => !visibleFolderNames.includes(name)));
                },
              }}
              pagination={{
                renderWindow: fileRenderWindow,
                windowCount: fileRenderWindowCount,
                showWindowControls: displayedFileSource.length > FILE_RENDER_WINDOW_SIZE,
                hasMore: hasMoreFiles,
                loadingMore: loadingMoreFiles,
                onPrevious: () => setFileRenderWindow(value => Math.max(0, value - 1)),
                onNext: () => setFileRenderWindow(value => Math.min(fileRenderWindowCount - 1, value + 1)),
                onLoadMore: () => void loadMoreFiles(),
              }}
              bulkActions={<BulkActionToolbar
                isVisible
                selectedFilesCount={selectedFileIds.length}
                selectedFoldersCount={selectedFolderNames.length}
                selectedFileId={selectedFileIds.length === 1 ? selectedFileIds[0] : undefined}
                onCancel={() => {
                  setIsSelectionMode(false);
                  setSelectedFileIds([]);
                  setSelectedFolderNames([]);
                }}
                onMove={() => {
                  if (selectedFileIds.length === 1 && selectedFolderNames.length === 0) {
                    const file = files.find(item => item.id === selectedFileIds[0]);
                    if (file) setMovingFile(file);
                  } else if (selectedFileIds.length === 0 && selectedFolderNames.length === 1) {
                    setMovingFolder(selectedFolderNames[0]);
                  }
                }}
                onDelete={() => void handleBatchDelete()}
                onShare={handleShare}
                shareCapabilities={storageConfig?.capabilities}
                canDelete={storageConfig?.capabilities.userDelete !== false}
              />}
              uploadQueueAction={(uploadQueue.length > 0 || recoveredUploads.length > 0) && !isQueueModalOpen ? (
                <Button onClick={() => setIsQueueModalOpen(true)}>
                  <Upload className="h-4 w-4" />
                  {t('files.uploadQueue', { count: uploadQueue.filter(item => ['pending', 'uploading', 'processing'].includes(item.status)).length + recoveredUploads.length })}
                </Button>
              ) : null}
            />
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
          title={t('appCopy.cancelResumeTitle')}
          description={t('appCopy.cancelResumeDescription', { name: cancellingRecoveredUpload?.filename || '' })}
          confirmLabel={t('appCopy.cancelUpload')}
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
          onConfirm={async (dest) => {
            if (movingFile) await handleMoveFile(dest);
            else if (movingFolder) await handleMoveFolder(dest);
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
