import { useState, useMemo, useEffect, useCallback } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { Button } from "./components/ui/Button";
import { FileCard } from "./components/ui/FileCard";
import { FolderCard, type FolderData } from "./components/ui/FolderCard";
import { UploadZone } from "./components/ui/UploadZone";
import { Search, RefreshCw, ArrowLeft, ChevronDown, ChevronRight, CheckSquare } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { PreviewModal } from "./components/ui/PreviewModal";
import { BulkActionToolbar } from "./components/ui/BulkActionToolbar";
import { useTranslation } from "react-i18next";
import { EmptyState } from "./components/ui/EmptyState";
import { SettingsPage } from "./components/pages/SettingsPage";
import { LoginPage } from "./components/pages/LoginPage";
import { ViewToggle } from "./components/ui/ViewToggle";
import { FileMenu } from "./components/ui/FileMenu";
import { DeleteAlert } from "./components/ui/DeleteAlert";
import { FolderPromptModal } from "./components/ui/FolderPromptModal";
import { UploadQueueModal, type QueueItem } from "./components/ui/UploadQueueModal";
import { fileApi, type FileData, type StorageStats as StorageStatsType } from "./services/api";
import { authService } from "./services/auth";

function App() {
  // 认证状态
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(true);
  const [authChecking, setAuthChecking] = useState(true);

  const [files, setFiles] = useState<FileData[]>([]);
  const [loading, setLoading] = useState(true);

  // 改用队列管理上传状态
  const [uploadQueue, setUploadQueue] = useState<QueueItem[]>([]);
  const [isQueueModalOpen, setIsQueueModalOpen] = useState(false);

  const [storageStats, setStorageStats] = useState<StorageStatsType | null>(null);

  const { t } = useTranslation();
  const [currentCategory, setCurrentCategory] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedFile, setSelectedFile] = useState<FileData | null>(null);
  const [deletingFile, setDeletingFile] = useState<FileData | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentFolder, setCurrentFolder] = useState<string | null>(null); // 当前选中的文件夹

  const [isFoldersExpanded, setIsFoldersExpanded] = useState(false); // 文件夹区域折叠状态，默认折叠

  const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);
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

  // 检查认证状态
  useEffect(() => {
    const checkAuth = async () => {
      try {
        // 检查是否需要密码
        const passwordRequired = await authService.checkPasswordRequired();
        setNeedsPassword(passwordRequired);

        if (!passwordRequired) {
          // 不需要密码，直接进入
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

  // 加载文件列表
  const loadFiles = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setLoading(true);
      const data = await fileApi.getFiles();
      setFiles(data);
    } catch (error: any) {
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('加载文件失败:', error);
      }
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

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

  // 认证成功后加载数据
  useEffect(() => {
    if (isAuthenticated) {
      loadFiles();
      loadStorageStats();
    }
  }, [isAuthenticated, loadFiles, loadStorageStats]);

  // 登录处理
  const handleLogin = async (password: string) => {
    const result = await authService.login(password);
    if (result.success) {
      setIsAuthenticated(true);
    }
    return result;
  };

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
      startUpload(newFiles);
    }
  };

  const startUpload = async (newFiles: File[], folder?: string) => {
    // 1. 创建队列项
    const newItems: QueueItem[] = newFiles.map(file => ({
      id: `${file.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file,
      status: 'pending',
      progress: 0
    }));

    // 2. 添加到队列
    setUploadQueue(prev => [...prev, ...newItems]);

    // 3. 如果是多文件上传，打开队列弹窗
    if (newFiles.length > 1) {
      setIsQueueModalOpen(true);
    }

    try {
      // 4. 并行上传
      const uploadPromises = newItems.map(async (item) => {
        // 更新状态为上传中
        setUploadQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'uploading' } : q));

        try {
          await fileApi.uploadFile(item.file, folder, (progress) => {
            setUploadQueue(prev => prev.map(q => q.id === item.id ? {
              ...q,
              status: 'uploading',
              progress: progress.percent
            } : q));
          });

          // 上传成功
          setUploadQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'completed', progress: 100 } : q));
        } catch (err: any) {
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
      await Promise.all([loadFiles(), loadStorageStats()]);

    } catch (error: any) {
      console.error('批量上传过程出错:', error);
    }
  };

  // 关闭队列弹窗并清空已完成项目
  const handleCloseQueue = () => {
    setIsQueueModalOpen(false);
    // 延迟清空队列，让关闭动画播放完
    setTimeout(() => {
      setUploadQueue([]);
    }, 300);
  };

  const verifyDelete = (file: FileData) => {
    setDeletingFile(file);
  };

  const handleConfirmDelete = async () => {
    if (deletingFile) {
      try {
        await fileApi.deleteFile(deletingFile.id);
        setFiles((prev) => prev.filter((f) => f.id !== deletingFile.id));
        setDeletingFile(null);
        // 刷新存储统计
        loadStorageStats();
      } catch (error: any) {
        if (error.message === 'UNAUTHORIZED') {
          authService.clearToken();
          setIsAuthenticated(false);
        } else {
          console.error('删除失败:', error);
        }
      }
    }
  };

  const handleBatchDelete = async () => {
    if (selectedFileIds.length === 0 && selectedFolderNames.length === 0) return;

    // 简单确认
    if (!confirm(`确定要删除选中的 ${selectedFileIds.length + selectedFolderNames.length} 个项目吗？`)) {
      return;
    }

    try {
      setLoading(true);
      await fileApi.batchDelete(selectedFileIds, selectedFolderNames);
      setIsSelectionMode(false);
      setSelectedFileIds([]);
      setSelectedFolderNames([]);
      await Promise.all([loadFiles(), loadStorageStats()]);
    } catch (error: any) {
      if (error.message === 'UNAUTHORIZED') {
        authService.clearToken();
        setIsAuthenticated(false);
      } else {
        console.error('批量删除失败:', error);
      }
    } finally {
      setLoading(false);
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

  const filteredFiles = useMemo(() => {
    return files.filter(file => {
      const matchesCategory =
        currentCategory === "all" ||
        (currentCategory === "media" && ["image", "video", "audio"].includes(file.type)) ||
        (currentCategory === "image" && file.type === "image") ||
        (currentCategory === "video" && file.type === "video") ||
        (currentCategory === "audio" && file.type === "audio") ||
        (currentCategory === "document" && file.type === "document");

      const matchesSearch = file.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (file.folder && file.folder.toLowerCase().includes(searchQuery.toLowerCase()));

      return matchesCategory && matchesSearch;
    });
  }, [files, currentCategory, searchQuery]);

  // 按文件夹分组文件，生成文件夹列表
  const folders = useMemo(() => {
    const folderMap = new Map<string, FileData[]>();

    // 只处理有文件夹的文件
    filteredFiles.forEach(file => {
      if (file.folder) {
        if (!folderMap.has(file.folder)) {
          folderMap.set(file.folder, []);
        }
        folderMap.get(file.folder)!.push(file);
      }
    });

    // 生成 FolderData 数组
    const result: FolderData[] = [];
    folderMap.forEach((files, name) => {
      // 找到第一个有缩略图的文件作为封面
      const coverFile = files.find(f => f.thumbnailUrl || f.type === 'image' || f.type === 'video') || files[0];

      result.push({
        name,
        files,
        fileCount: files.length,
        coverFile,
        latestDate: files.reduce((latest, file) => {
          return !latest || new Date(file.created_at) > new Date(latest) ? file.created_at : latest;
        }, '')
      });
    });

    // 排序逻辑
    return result.sort((a, b) => {
      let comparison = 0;
      if (sortConfig.key === 'name') {
        comparison = a.name.localeCompare(b.name, 'zh-CN');
      } else {
        // 文件夹日期排序使用其中最新文件的日期
        const dateA = a.latestDate ? new Date(a.latestDate).getTime() : 0;
        const dateB = b.latestDate ? new Date(b.latestDate).getTime() : 0;
        comparison = dateA - dateB;
      }
      return sortConfig.direction === 'asc' ? comparison : -comparison;
    });
  }, [filteredFiles, sortConfig]);

  const visibleFolders = useMemo(() => {
    if (isFoldersExpanded) return folders;
    return folders.slice(0, columns);
  }, [folders, isFoldersExpanded, columns]);

  // 如果文件夹总数不超过一行，则不需要显示展开/折叠按钮
  const showFolderToggle = folders.length > columns;

  // 没有文件夹的散文件
  const looseFiles = useMemo(() => {
    const files = filteredFiles.filter(file => !file.folder);

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
  }, [filteredFiles, sortConfig]);

  // 当前显示的文件（在文件夹内时显示该文件夹的文件）
  const displayFiles = useMemo(() => {
    if (currentFolder) {
      return filteredFiles.filter(file => file.folder === currentFolder);
    }
    return looseFiles;
  }, [currentFolder, filteredFiles, looseFiles]);

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
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <AppLayout onCategoryChange={setCurrentCategory} storageStats={storageStats}>
      <div className="flex flex-col gap-8 max-w-7xl mx-auto min-h-full">

        {/* Main Content Area */}
        {currentCategory === "settings" ? (
          <SettingsPage storageStats={storageStats} />
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
                  className="h-10 w-10 rounded-full"
                  onClick={() => { loadFiles(); loadStorageStats(); }}
                  disabled={loading}
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>

                {/* 多选切换按钮 */}
                <Button
                  variant={isSelectionMode ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 px-3 text-xs flex items-center gap-2"
                  onClick={() => {
                    setIsSelectionMode(!isSelectionMode);
                    setSelectedFileIds([]);
                    setSelectedFolderNames([]);
                  }}
                >
                  <CheckSquare className="h-4 w-4" />
                  <span>多选</span>
                </Button>

                {/* 排序按钮 */}
                <div className="bg-muted/50 rounded-lg p-1 flex items-center gap-1">
                  <Button
                    variant={sortConfig.key === 'name' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-8 px-2 text-xs"
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
                    className="h-8 px-2 text-xs"
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

            {/* Upload Zone */}
            <UploadZone
              onDrop={handleDrop}
              uploading={isUploading}
              uploadProgress={totalUploadProgress}
            />

            <div className="sticky top-0 z-30 bg-background/80 backdrop-blur-sm -mx-4 px-4 pt-2">
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
              />
            </div>

            {/* Files View */}
            <div className="flex-1 flex flex-col mt-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  {currentFolder ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-full"
                        onClick={() => setCurrentFolder(null)}
                      >
                        <ArrowLeft className="h-4 w-4" />
                      </Button>
                      <span>{currentFolder}</span>
                      <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                        {displayFiles.length} 个文件
                      </span>
                    </>
                  ) : (
                    <>
                      {t("app.recent")}
                      <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                        {folders.length > 0 ? `${folders.length} 个文件夹, ` : ''}{looseFiles.length} 个文件
                      </span>
                    </>
                  )}
                </h3>

              </div>

              {loading ? (
                <div className="flex items-center justify-center py-20">
                  <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : filteredFiles.length === 0 ? (
                <EmptyState />
              ) : currentFolder ? (
                /* 文件夹内容视图 */
                <div className={viewMode === "grid" ? "grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5" : "flex flex-col gap-2"}>
                  <AnimatePresence mode="wait">
                    {displayFiles.map((file) => (
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
                            isSelectionMode={isSelectionMode}
                            isSelected={selectedFileIds.includes(file.id)}
                            onSelect={toggleFileSelection}
                          />
                        ) : (
                          <div
                            className={`flex items-center gap-4 p-3 rounded-xl border ${selectedFileIds.includes(file.id) ? 'border-primary bg-primary/5' : 'border-border bg-card'} shadow-sm cursor-pointer group hover:bg-muted/50 transition-colors`}
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
                              <p className="text-xs text-muted-foreground">{file.date}</p>
                            </div>
                            <div className="text-sm font-medium tabular-nums text-muted-foreground px-4">{file.size}</div>
                            <div>
                              <FileMenu onDelete={() => verifyDelete(file)} />
                            </div>
                          </div>
                        )}
                      </motion.div>
                    ))}
                  </AnimatePresence>
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
                                onClick={() => setCurrentFolder(folder.name)}
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
                                  isSelectionMode={isSelectionMode}
                                  isSelected={selectedFileIds.includes(file.id)}
                                  onSelect={toggleFileSelection}
                                />
                              ) : (
                                <div
                                  className={`flex items-center gap-4 p-3 rounded-xl border ${selectedFileIds.includes(file.id) ? 'border-primary bg-primary/5' : 'border-border bg-card'} shadow-sm cursor-pointer group hover:bg-muted/50 transition-colors`}
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
                                    <p className="text-xs text-muted-foreground">{file.date}</p>
                                  </div>
                                  <div className="text-sm font-medium tabular-nums text-muted-foreground px-4">{file.size}</div>
                                  <div>
                                    <FileMenu onDelete={() => verifyDelete(file)} />
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
            </div>
          </>
        )}
      </div>

      <PreviewModal file={selectedFile} onClose={() => setSelectedFile(null)} />

      {/* 这里的 isOpen 逻辑是：如果有正在上传的，或者用户没点关闭（且有内容），就显示？ */}
      {/* 现在的逻辑是：多文件触发 setIsQueueModalOpen(true)，关闭则 false。 */}
      <UploadQueueModal
        isOpen={isQueueModalOpen}
        onClose={handleCloseQueue}
        items={uploadQueue}
      />

      <DeleteAlert
        isOpen={!!deletingFile}
        onClose={() => setDeletingFile(null)}
        onConfirm={handleConfirmDelete}
        fileName={deletingFile?.name}
      />

      <FolderPromptModal
        isOpen={isFolderModalOpen}
        onClose={() => setIsFolderModalOpen(false)}
        onConfirm={(folderName) => startUpload(pendingFiles, folderName)}
        onCancel={() => startUpload(pendingFiles)}
      />
    </AppLayout >
  );
}

export default App;
