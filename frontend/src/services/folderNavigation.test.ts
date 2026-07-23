import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFolderBreadcrumbs, directChildFolders, folderLeafName, parentFolder } from './folderNavigation.js';

test('folder navigation preserves hierarchy and exposes only direct children', () => {
    assert.deepEqual(buildFolderBreadcrumbs('telegram/channel/images'), [
        { label: 'telegram', path: 'telegram' },
        { label: 'channel', path: 'telegram/channel' },
        { label: 'images', path: 'telegram/channel/images' },
    ]);
    assert.equal(parentFolder('telegram/channel/images'), 'telegram/channel');
    assert.equal(folderLeafName('telegram/channel/images'), 'images');
    assert.deepEqual(directChildFolders(['telegram/channel', 'telegram/channel/images', 'telegram/music'], 'telegram'), [
        { label: 'channel', path: 'telegram/channel' },
        { label: 'music', path: 'telegram/music' },
    ]);
});
