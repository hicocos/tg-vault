import { Fragment, useId, useState, type ReactNode } from "react";
import { ArrowLeft, CheckSquare, ChevronDown, ChevronRight, Filter, Folder, FolderPlus, RefreshCw, Search, Upload, X } from "../ui/icons";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { FileCard } from "../ui/FileCard";
import { FolderCard, type FolderData } from "../ui/FolderCard";
import { ViewToggle } from "../ui/ViewToggle";
import { EmptyState } from "../ui/EmptyState";
import { IndeterminateSpinner } from "../ui/IndeterminateSpinner";
import { buildFolderBreadcrumbs, parentFolder } from "../../services/folderNavigation";
import type { FileData } from "../../services/api";
import type { FileViewStateKind } from "../../services/fileViewState";
import { fileBrowserCopy } from "../../services/fileBrowserPresentation";
import "./files.css";

interface FilesPageProps {
    currentCategory: string;
    currentFolder: string | null;
    searchQuery: string;
    onSearchChange: (query: string) => void;
    filterControl: ReactNode;
    onClearFilter: () => void;
    sortConfig: { key: 'name' | 'date'; direction: 'asc' | 'desc' };
    onSort: (key: 'name' | 'date') => void;
    viewMode: 'grid' | 'list';
    onViewModeChange: (mode: 'grid' | 'list') => void;
    onUpload: () => void;
    onRefresh: () => void;
    onCreateFolder: () => void;
    onNavigateFolder: (folder: string | null) => void;
    folders: FolderData[];
    renderedFiles: FileData[];
    displayedFileCount: number;
    loading: boolean;
    initialEmpty: boolean;
    queryError: string | null;
    isStale: boolean;
    emptyKind: FileViewStateKind;
    onOpenFolder: (name: string) => void;
    onRenameFolder: (name: string) => void;
    onFavoriteFolder: (name: string) => void;
    onMoveFolder: (name: string) => void;
    onDeleteFolder?: (name: string) => void;
    onPreviewFile: (file: FileData) => void;
    onRenameFile: (file: FileData) => void;
    onFavoriteFile: (id: string) => void;
    onMoveFile: (file: FileData) => void;
    onDeleteFile?: (file: FileData) => void;
    selection: {
        active: boolean;
        fileIds: string[];
        folderNames: string[];
        onToggle: () => void;
        onFile: (id: string) => void;
        onFolder: (name: string) => void;
        onSelectVisible: (selected: boolean) => void;
    };
    pagination: {
        renderWindow: number;
        windowCount: number;
        showWindowControls: boolean;
        hasMore: boolean;
        loadingMore: boolean;
        onPrevious: () => void;
        onNext: () => void;
        onLoadMore: () => void;
    };
    bulkActions: ReactNode;
    uploadQueueAction: ReactNode;
}

// Presentation only. Query generations, route history, upload queues and all
// mutation state stay in App so navigating between pages cannot reset them.
export const FilesPage = (props: FilesPageProps) => {
    const {
        currentCategory, currentFolder, searchQuery, onSearchChange, filterControl,
        onClearFilter, sortConfig, onSort, viewMode, onViewModeChange, onUpload,
        onRefresh, onCreateFolder, onNavigateFolder, folders, renderedFiles,
        displayedFileCount, loading, initialEmpty, queryError, isStale, emptyKind,
        onOpenFolder, onRenameFolder, onFavoriteFolder, onMoveFolder, onDeleteFolder,
        onPreviewFile, onRenameFile, onFavoriteFile, onMoveFile, onDeleteFile,
        selection, pagination, bulkActions, uploadQueueAction,
    } = props;
    const { t, i18n } = useTranslation();
    const copy = fileBrowserCopy(i18n.resolvedLanguage || i18n.language);
    const sortLabel = sortConfig.key === 'name'
        ? (sortConfig.direction === 'asc' ? copy.nameAsc : copy.nameDesc)
        : (sortConfig.direction === 'asc' ? copy.dateAsc : copy.dateDesc);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const filtersId = useId();
    const fileIds = new Set(selection.fileIds);
    const folderNames = new Set(selection.folderNames);
    const visibleCount = renderedFiles.length + folders.length;
    const selectedVisibleCount = renderedFiles.filter(file => fileIds.has(file.id)).length + folders.filter(folder => folderNames.has(folder.name)).length;
    const allVisibleSelected = visibleCount > 0 && visibleCount === selectedVisibleCount;
    const filterActive = currentCategory !== 'all' && currentCategory !== 'favorites';
    const filterLabel = i18n.language.startsWith('zh') ? '筛选与排序' : i18n.language.startsWith('ru') ? 'Фильтры и сортировка' : 'Filter & sort';
    const categoryLabel = currentCategory === 'favorites' ? t('sidebar.favorites')
        : currentCategory === 'media' ? t('sidebar.media')
        : currentCategory === 'image' ? t('app.fileTypes.images')
        : currentCategory === 'video' ? t('app.fileTypes.videos')
        : currentCategory === 'audio' ? t('app.fileTypes.audio')
        : currentCategory === 'document' ? t('app.fileTypes.other') : t('app.fileTypes.all');

    return (
        <section className="tv-files-page">
            <header className="tv-page-header tv-files-heading">
                <div>
                    <h1>{t(currentCategory === 'favorites' ? 'sidebar.favorites' : 'sidebar.files')}</h1>
                </div>
                <div className="tv-files-create-actions"><Button onClick={onUpload}><Upload aria-hidden="true" />{t('app.upload')}</Button><Button variant="outline" size="sm" onClick={onCreateFolder}><FolderPlus aria-hidden="true" />{t(currentFolder ? 'files.newSubfolder' : 'files.createFolder')}</Button></div>
            </header>

            <section data-testid="file-toolbar" className="tv-panel tv-files-filters" aria-label={t('app.fileTypes.filter')}>
                <div data-testid="file-toolbar-primary" className="tv-files-search-row min-w-0">
                    <label className="tv-files-search">
                        <Search aria-hidden="true" />
                        <input type="search" className="tv-field" placeholder={t('app.searchPlaceholder')} aria-label={t('app.mobileSearch')} value={searchQuery} onChange={event => onSearchChange(event.target.value)} />
                    </label>
                    <Button variant="outline" className="tv-files-filter-toggle" data-active={filterActive} aria-expanded={filtersOpen} aria-controls={filtersId} onClick={() => setFiltersOpen(open => !open)}>
                        <Filter aria-hidden="true" /><span>{filterLabel}</span>
                        {filterActive && <span className="tv-files-filter-count">1</span>}
                        <ChevronDown className={filtersOpen ? 'is-open' : ''} aria-hidden="true" />
                    </Button>
                </div>
                <div id={filtersId} className="tv-files-filter-options" hidden={!filtersOpen}>
                    {currentCategory !== 'favorites' && filterControl}
                    <div className="tv-files-sort-options">
                    <label className="tv-files-sort">
                        <span className="sr-only">{copy.sort}</span>
                        <select className="tv-field" value={sortConfig.key} onChange={event => onSort(event.target.value as 'name' | 'date')}>
                            <option value="name">{copy.sortName}</option>
                            <option value="date">{copy.sortDate}</option>
                        </select>
                    </label>
                    <Button variant="outline" size="sm" className="tv-files-sort-direction" onClick={() => onSort(sortConfig.key)} aria-label={sortLabel} title={sortLabel}>
                        <ChevronDown className={sortConfig.direction === 'asc' ? 'tv-sort-ascending' : undefined} aria-hidden="true" />
                        <span>{sortLabel}</span>
                    </Button>
                    </div>
                </div>
                {(filterActive || searchQuery) && (
                    <div className="tv-files-filter-summary">
                        <div>{filterActive && <span className="tv-badge">{categoryLabel}</span>}{searchQuery && <span className="tv-files-query" title={searchQuery}>{searchQuery}</span>}</div>
                        <Button variant="ghost" size="sm" onClick={currentCategory === 'favorites' ? () => onSearchChange('') : onClearFilter}><X aria-hidden="true" />{t('files.clearFilters')}</Button>
                    </div>
                )}
            <div className="tv-files-library-toolbar">
                <Button className="tv-files-selection-toggle" variant={selection.active ? 'secondary' : 'outline'} size="sm" aria-pressed={selection.active} onClick={selection.onToggle}>
                    <CheckSquare aria-hidden="true" /><span>{t(selection.active ? 'files.exitSelection' : 'files.select')}</span>
                </Button>
                <div data-testid="file-toolbar-secondary" className="tv-files-display-tools">
                    <ViewToggle viewMode={viewMode} setViewMode={onViewModeChange} />
                    <Button variant="outline" size="sm" className="tv-files-refresh" onClick={onRefresh} disabled={loading} aria-label={t('app.refresh')} title={t('app.refresh')}>
                        {loading ? <IndeterminateSpinner label={t('files.refreshFiles')} size="sm" /> : <RefreshCw aria-hidden="true" />}<span className="tv-files-refresh-label">{t('app.refresh')}</span>
                    </Button>
                </div>
                {selection.active && (
                    <label className="tv-files-select-visible">
                        <input type="checkbox" checked={allVisibleSelected} ref={element => { if (element) element.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected; }} onChange={event => selection.onSelectVisible(event.target.checked)} disabled={!visibleCount || loading || (!!queryError && !isStale)} />
                        <span>{t('files.selectVisible')}</span>
                    </label>
                )}
            </div>
            </section>

            {selection.active && <div className="tv-files-bulk">{bulkActions}</div>}

            <div className="tv-files-location">
                <div className="tv-files-location-main">
                    {currentFolder ? (
                        <nav className="tv-files-breadcrumbs" aria-label={t('files.root')}>
                            <Button variant="ghost" size="icon" onClick={() => onNavigateFolder(parentFolder(currentFolder))} aria-label={t('files.backToParent')}><ArrowLeft aria-hidden="true" /></Button>
                            <button type="button" onClick={() => onNavigateFolder(null)}>{t('files.root')}</button>
                            {buildFolderBreadcrumbs(currentFolder).map(({ label, path }) => (
                                <Fragment key={path}><ChevronRight aria-hidden="true" /><button type="button" title={label} aria-current={path === currentFolder ? 'page' : undefined} onClick={() => onNavigateFolder(path)}>{label}</button></Fragment>
                            ))}
                        </nav>
                    ) : <h2>{currentCategory === 'favorites' ? t('sidebar.favorites') : t('files.root')}</h2>}
                    <span className="tv-files-count tv-muted">{currentCategory === 'favorites' ? copy.favoritesScope : filterActive || searchQuery ? copy.results : copy.directory}: {t('files.folderCount', { count: folders.length })}<span aria-hidden="true"> · </span>{t('files.loadedFileCount', { count: displayedFileCount })}</span>
                </div>

            </div>

            {queryError && isStale && <div className="tv-files-stale" role="status"><span>{t('empty.stale.title')}: {queryError}</span><Button variant="outline" size="sm" onClick={onRefresh}>{t('empty.retry')}</Button></div>}
            <div className="tv-files-results" aria-busy={loading}>
                {loading && initialEmpty ? (
                    <div className="tv-files-loading"><IndeterminateSpinner label={t('files.loadingFiles')} size="lg" /></div>
                ) : queryError && !isStale ? (
                    <EmptyState kind={emptyKind} onRetry={onRefresh} />
                ) : displayedFileCount === 0 && folders.length === 0 ? (
                    currentCategory === 'favorites' && !searchQuery ? <div className="tv-panel tv-favorites-empty"><h3>{copy.favorites}</h3><p>{copy.favoritesHint}</p><Button variant="outline" onClick={onClearFilter}>{copy.browse}</Button></div> : <EmptyState kind={emptyKind} onRetry={onRefresh} onClearSearch={() => onSearchChange('')} onClearFilter={onClearFilter} />
                ) : (
                    <>
                        {folders.length > 0 && (
                            <section className="tv-files-folder-section">
                                <div className="tv-files-section-heading">
                                    <h3><Folder aria-hidden="true" />{t('appCopy.folderLabel')}<span className="tv-badge">{folders.length}</span></h3>
                                </div>
                                <div className={viewMode === 'grid' ? 'tv-files-grid tv-folders-grid' : 'tv-folders-list'}>
                                    {folders.map(folder => <FolderCard
                                        key={folder.name} folder={folder} viewMode={viewMode}
                                        onClick={() => onOpenFolder(folder.name)} onRename={() => onRenameFolder(folder.name)}
                                        onToggleFavorite={() => onFavoriteFolder(folder.name)} onMove={() => onMoveFolder(folder.name)}
                                        onDelete={onDeleteFolder ? () => onDeleteFolder(folder.name) : undefined}
                                        isSelectionMode={selection.active} isSelected={folderNames.has(folder.name)} onSelect={selection.onFolder}
                                    />)}
                                </div>
                            </section>
                        )}
                        {displayedFileCount > 0 && (
                            <section className="tv-files-file-section">
                                {folders.length > 0 && <div className="tv-files-section-heading"><h3>{t('appCopy.fileLabel')}</h3></div>}
                                {viewMode === 'list' && <div className="tv-files-list-heading" aria-hidden="true"><span>{t('files.sortName')}</span><span>{t('file.moreActions')}</span></div>}
                                <div className={viewMode === 'grid' ? 'tv-files-grid' : 'tv-files-list'}>
                                    {renderedFiles.map(file => <FileCard
                                        key={file.id} file={file} viewMode={viewMode}
                                        onPreview={() => onPreviewFile(file)} onRename={() => onRenameFile(file)}
                                        onToggleFavorite={() => onFavoriteFile(file.id)} onMove={() => onMoveFile(file)}
                                        onDelete={onDeleteFile ? () => onDeleteFile(file) : undefined}
                                        isSelectionMode={selection.active} isSelected={fileIds.has(file.id)} onSelect={selection.onFile}
                                    />)}
                                </div>
                            </section>
                        )}
                    </>
                )}
            </div>

            {!loading && (pagination.showWindowControls || pagination.hasMore) && (
                <footer className="tv-files-pagination">
                    {pagination.showWindowControls && <nav aria-label={t('appCopy.loadedFilesWindow')}>
                        <Button variant="outline" size="sm" disabled={pagination.renderWindow === 0} onClick={pagination.onPrevious}>{t('files.previousBatch')}</Button>
                        <span>{t('files.loadedBatch', { current: pagination.renderWindow + 1, total: pagination.windowCount })}</span>
                        <Button variant="outline" size="sm" disabled={pagination.renderWindow >= pagination.windowCount - 1} onClick={pagination.onNext}>{t('files.nextBatch')}</Button>
                    </nav>}
                    {pagination.hasMore && <Button variant="outline" onClick={pagination.onLoadMore} disabled={pagination.loadingMore}>
                        {pagination.loadingMore ? <IndeterminateSpinner label={t('files.loadingMore')} size="sm" /> : <RefreshCw aria-hidden="true" />}
                        {t(pagination.loadingMore ? 'common.status.loading' : 'common.actions.loadMore')}
                    </Button>}
                </footer>
            )}
            {uploadQueueAction && <div className="tv-files-queue-action">{uploadQueueAction}</div>}
        </section>
    );
};
