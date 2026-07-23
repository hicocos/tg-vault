import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../components/ui/PreviewModal.tsx', import.meta.url), 'utf8');

test('preview metadata is hidden behind an explicit details control', () => {
    assert.match(source, /aria-label="查看文件详情"/);
    assert.match(source, /setDetailsOpen\(true\)/);
    assert.match(source, /文件详情/);
    assert.match(source, /ID:\s*\{file\.id\}/);
    assert.doesNotMatch(source, /max-w-\[58vw\][\s\S]*ID:\s*\{file\.id\}/);
});

test('image, video, and audio previews expose loading and actionable error states', () => {
    assert.match(source, /图片加载失败/);
    assert.match(source, /视频加载失败/);
    assert.match(source, /音频加载失败/);
    assert.match(source, /重新加载/);
    assert.match(source, /preload="metadata"/);
    assert.match(source, /load\(\)/);
});

test('media source changes reset player state instead of retaining a stale error', () => {
    assert.match(source, /useEffect\(\(\) => \{[\s\S]*setHasError\(false\)[\s\S]*file\.previewUrl/);
    assert.match(source, /key=\{`\$\{file\.previewUrl\}-\$\{reloadKey\}`\}/);
});
