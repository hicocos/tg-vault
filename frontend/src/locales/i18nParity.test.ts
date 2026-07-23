import assert from 'node:assert/strict';
import test from 'node:test';
import zh from './zh.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

function keys(value: unknown, prefix = ''): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
    return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
}

test('Chinese and English locale catalogs have identical keys', () => {
    assert.deepEqual(keys(zh).sort(), keys(en).sort());
});

test('second-step core journeys are fully represented in both locales', () => {
    const required = [
        'sidebar.favorites', 'sidebar.tasks', 'sidebar.logout',
        'app.mobileSearch', 'app.refresh', 'app.sortName', 'app.sortDate',
        'upload.anyFile', 'upload.chunkHint', 'upload.speed', 'upload.eta',
        'empty.root.title', 'empty.folder.title', 'empty.search.title', 'empty.filter.title', 'empty.offline.title', 'empty.stale.title',
        'settings.nav.general', 'settings.nav.security', 'settings.nav.telegram', 'settings.nav.storage', 'settings.nav.maintenance',
    ];
    const zhKeys = new Set(keys(zh));
    const enKeys = new Set(keys(en));
    for (const key of required) {
        assert.ok(zhKeys.has(key), `zh missing ${key}`);
        assert.ok(enKeys.has(key), `en missing ${key}`);
    }
});
