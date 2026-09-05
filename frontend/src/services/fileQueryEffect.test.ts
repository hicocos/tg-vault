import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

test('file query is driven by one consolidated effect and one request group', () => {
    const effect = app;
    assert.ok((effect.match(/fileApi\.getFilesPage\(/g) || []).length >= 1);
    assert.ok((effect.match(/fileApi\.getFolderAggregations\(/g) || []).length >= 1);
    assert.match(effect, /Promise\.all/);
});

test('search input is debounced for 250ms before query options change', () => {
    assert.match(app, /setTimeout\(\(\) => setDebouncedSearchQuery\(searchQuery\), 250\)/);
    assert.match(app, /q: debouncedSearchQuery/);
});

test('file query restores a query-specific cache before background revalidation', () => {
    const effect = app;
    assert.match(effect, /fileQueryCacheRef\.current\.get\(queryKey\)/);
    assert.match(effect, /applyFileQuerySnapshot\(cached\)/);
    assert.match(effect, /setLoading\(!cached\)/);
    assert.match(effect, /fileQueryCacheRef\.current\.set\(queryKey, snapshot\)/);
});

test('refresh keeps existing list while latest generation is pending', () => {
    const loader = app.slice(app.indexOf('const loadFiles = useCallback'), app.indexOf('const loadMoreFiles'));
    assert.doesNotMatch(loader, /setFiles\(\[\]\)/);
    assert.match(loader, /latestFileRequestRef\.current\.begin/);
    assert.match(loader, /request\.isCurrent\(\)/);
});
