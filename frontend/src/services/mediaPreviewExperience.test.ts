import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zh from '../locales/zh-CN/index';
import en from '../locales/en/index';

const source = fs.readFileSync(new URL('../components/ui/PreviewModal.tsx', import.meta.url), 'utf8');

test('preview metadata is hidden behind an explicit details control', () => {
    assert.match(source, /aria-label=\{t\('files\.ui\.preview\.details'\)\}/);
    assert.match(source, /setDetailsOpen\(true\)/);
    assert.equal(zh.files.ui.preview.details, '文件详情');
    assert.equal(en.files.ui.preview.details, 'File details');
    assert.match(source, /ID:\s*\{file\.id\}/);
    assert.doesNotMatch(source, /max-w-\[58vw\][\s\S]*ID:\s*\{file\.id\}/);
});

test('image, video, and audio previews expose loading and actionable error states', () => {
    for (const key of ['imageFailed', 'videoFailed', 'audioFailed', 'reload'] as const) {
        assert.match(source, new RegExp(`t\\('files\\.ui\\.preview\\.${key}'\\)`));
        assert.equal(typeof zh.files.ui.preview[key], 'string');
        assert.equal(typeof en.files.ui.preview[key], 'string');
        assert.notEqual(zh.files.ui.preview[key], en.files.ui.preview[key]);
    }
    assert.match(source, /preload="metadata"/);
    assert.match(source, /load\(\)/);
});

test('media source changes reset player state instead of retaining a stale error', () => {
    assert.match(source, /useEffect\(\(\) => \{[\s\S]*setHasError\(false\)[\s\S]*file\.previewUrl/);
    assert.match(source, /key=\{`\$\{file\.previewUrl\}-\$\{reloadKey\}`\}/);
});
