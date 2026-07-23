import assert from 'node:assert/strict';
import test from 'node:test';
import {
    appRouteHref,
    parseAppRoute,
    routeForCategory,
    routeForSettings,
} from './appRoute.js';

const cases = [
    ['/files', 'all'],
    ['/files/media', 'media'],
    ['/files/images', 'image'],
    ['/files/videos', 'video'],
    ['/files/audio', 'audio'],
    ['/files/documents', 'document'],
    ['/files/ytdlp', 'ytdlp'],
    ['/files/favorites', 'favorites'],
] as const;

test('file routes parse and serialize every category', () => {
    for (const [pathname, category] of cases) {
        const route = parseAppRoute({ pathname, search: '' });
        assert.equal(route.kind, 'files');
        if (route.kind !== 'files') continue;
        assert.equal(route.category, category);
        assert.equal(route.needsReplace, false);
        assert.equal(appRouteHref(route), pathname);
        assert.equal(appRouteHref(routeForCategory(category)), pathname);
    }
});

test('tasks and every settings section have stable paths', () => {
    assert.deepEqual(parseAppRoute({ pathname: '/tasks', search: '' }), { kind: 'tasks', needsReplace: false });
    for (const section of ['general', 'security', 'telegram', 'storage', 'maintenance'] as const) {
        const pathname = `/settings/${section}`;
        assert.deepEqual(parseAppRoute({ pathname, search: '' }), { kind: 'settings', section, needsReplace: false });
        assert.equal(appRouteHref(routeForSettings(section)), pathname);
    }
});

test('file routes preserve folder and search queries', () => {
    const route = parseAppRoute({ pathname: '/files/images', search: '?folder=%E7%85%A7%E7%89%87%2F2026&q=%E6%97%85%E8%A1%8C' });
    assert.deepEqual(route, { kind: 'files', category: 'image', folder: '照片/2026', query: '旅行', needsReplace: false });
    assert.equal(appRouteHref(route), '/files/images?folder=%E7%85%A7%E7%89%87%2F2026&q=%E6%97%85%E8%A1%8C');
});

test('root and unknown paths canonicalize safely to files', () => {
    assert.deepEqual(parseAppRoute({ pathname: '/', search: '' }), { kind: 'files', category: 'all', folder: null, query: '', needsReplace: true });
    assert.deepEqual(parseAppRoute({ pathname: '/missing', search: '?q=ignored' }), { kind: 'files', category: 'all', folder: null, query: '', needsReplace: true });
    assert.equal(appRouteHref(parseAppRoute({ pathname: '/', search: '' })), '/files');
});
