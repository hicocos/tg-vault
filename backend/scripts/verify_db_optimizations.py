from pathlib import Path

root = Path(__file__).resolve().parents[1]
schema = (root / 'src/db/schema.sql').read_text()
db_index = (root / 'src/db/index.ts').read_text()
files_route = (root / 'src/routes/files.ts').read_text()
file_query = (root / 'src/services/fileQuery.ts').read_text()
storage_route = (root / 'src/routes/storage.ts').read_text()
frontend_api = (root.parent / 'frontend/src/services/api.ts').read_text()
app = (root.parent / 'frontend/src/App.tsx').read_text()
settings = (root.parent / 'frontend/src/components/pages/SettingsPage.tsx').read_text()

checks = [
    ('idx_files_account_created', schema),
    ('idx_files_source_created', schema),
    ('idx_files_account_fav_created', schema),
    ('idx_files_account_folder_created', schema),
    ('idx_files_source_fav_created', schema),
    ('idx_files_source_folder_created', schema),
    ('ensureFilesPerformanceIndexes', db_index),
    ('buildFilePageQuery', file_query),
    ('id, name, stored_name, type, mime_type, size', file_query),
    ('(created_at, id)', file_query),
    ('nextCursor', files_route),
    ('hasMore', files_route),
    ('/maintenance/download-items/cleanup', storage_route),
    ('DELETE FROM telegram_download_items', storage_route),
    ('getFilesPage', frontend_api),
    ('cleanupDownloadItems', frontend_api),
    ('fileCursor', app),
    ('loadMoreFiles', app),
    ('清理已完成下载明细', settings),
]

missing = [needle for needle, haystack in checks if needle not in haystack]
if missing:
    raise SystemExit('Missing optimization markers: ' + ', '.join(missing))
print('DB/list pagination/maintenance optimization markers verified')
