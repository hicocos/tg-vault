import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const modal = fs.readFileSync(new URL('../components/ui/PreviewModal.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

test('media load failures ask the backend for an accurate source status', () => {
    assert.match(api, /getMediaStatus\(fileId: string\)/);
    assert.match(api, /\/api\/files\/\$\{fileId\}\/media-status/);
    assert.match(modal, /fileApi\.getMediaStatus\(fileId\)/);
    assert.match(modal, /resolveMediaErrorMessage\(file\.id/);
});

test('preview errors distinguish deleted cloud sources from quota and generic failures', () => {
    assert.match(modal, /MEDIA_SOURCE_MISSING/);
    assert.match(modal, /云盘中的源文件已删除或已移入回收站/);
    assert.match(modal, /MEDIA_QUOTA_EXCEEDED/);
    assert.match(modal, /云盘下载额度已用完/);
});
