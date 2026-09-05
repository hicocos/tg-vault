import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FileQueryCache, type FileQuerySnapshot, type KeyValueStorage } from './fileQueryCache.js';

class MemoryStorage implements KeyValueStorage {
    private readonly values = new Map<string, string>();
    getItem(key: string): string | null { return this.values.get(key) ?? null; }
    setItem(key: string, value: string): void { this.values.set(key, value); }
    removeItem(key: string): void { this.values.delete(key); }
}

const snapshot = (name: string): FileQuerySnapshot => ({
    files: [{ id: name } as FileQuerySnapshot['files'][number]],
    folders: [],
    nextCursor: null,
    hasMore: false,
});

test('cache returns fresh snapshots immediately and expires them after the ttl', () => {
    let now = 1_000;
    const cache = new FileQueryCache({ storage: new MemoryStorage(), now: () => now, ttlMs: 30_000 });
    cache.set('root', snapshot('a'));
    assert.deepEqual(cache.get('root'), snapshot('a'));
    now += 30_001;
    assert.equal(cache.get('root'), null);
});

test('cache survives a page reload through session storage', () => {
    const storage = new MemoryStorage();
    new FileQueryCache({ storage, now: () => 1_000 }).set('root', snapshot('a'));
    const restored = new FileQueryCache({ storage, now: () => 1_001 });
    assert.deepEqual(restored.get('root'), snapshot('a'));
});

test('invalidate prevents stale results after a file mutation', () => {
    const storage = new MemoryStorage();
    const cache = new FileQueryCache({ storage, now: () => 1_000 });
    cache.set('root', snapshot('a'));
    cache.set('images', snapshot('b'));
    cache.invalidate();
    assert.equal(cache.get('root'), null);
    assert.equal(cache.get('images'), null);
});

test('App restores cached query data before background revalidation and clears cache after mutations', () => {
    const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const effect = app;
    assert.match(app, /const initialFileSnapshot = useMemo/);
    assert.match(app, /useState<FileData\[\]>\(\(\) => initialFileSnapshot\?\.files \?\? \[\]\)/);
    assert.match(effect, /fileQueryCacheRef\.current\.get\(queryKey\)/);
    assert.match(effect, /applyFileQuerySnapshot\(cached\)/);
    assert.match(effect, /setLoading\(!cached\)/);
    assert.match(effect, /fileQueryCacheRef\.current\.set\(queryKey/);
    assert.match(app, /const invalidateFileQueryCache = useCallback/);
    assert.match(app, /invalidateFileQueryCache\(\)/);
});
