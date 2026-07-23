import assert from 'node:assert/strict';
import test from 'node:test';
import {
    folderBaseName,
    folderParent,
    isFolderWithin,
    joinFolderPath,
    normalizeFolderName,
    normalizeFolderPath,
} from './folderPath.js';

test('folder paths preserve valid hierarchy', () => {
    assert.equal(normalizeFolderPath(' telegram/channel/images '), 'telegram/channel/images');
    assert.equal(folderParent('telegram/channel/images'), 'telegram/channel');
    assert.equal(folderBaseName('telegram/channel/images'), 'images');
    assert.equal(joinFolderPath('telegram/channel', 'images'), 'telegram/channel/images');
    assert.equal(isFolderWithin('telegram/channel/images', 'telegram'), true);
    assert.equal(isFolderWithin('telegram-other', 'telegram'), false);
});

test('folder paths reject ambiguous or unsafe segments', () => {
    assert.throws(() => normalizeFolderPath('../secret'), /相对路径/);
    assert.throws(() => normalizeFolderPath('a//b'), /空目录/);
    assert.throws(() => normalizeFolderPath('a\\b'), /非法字符/);
    assert.throws(() => normalizeFolderName('a/b'), /路径分隔符/);
});
