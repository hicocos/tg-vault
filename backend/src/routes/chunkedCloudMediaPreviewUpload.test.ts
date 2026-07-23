import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./chunkedUpload.ts', import.meta.url), 'utf8');

test('chunked cloud media generates local thumbnail and image preview before remote save', () => {
    assert.match(source, /if \(session\.mimeType\.startsWith\('image\/'\) \|\| session\.mimeType\.startsWith\('video\/'\)\)/);
    assert.match(source, /if \(session\.mimeType\.startsWith\('image\/'\)\)[\s\S]*generateMediaPreview\(tempMergedPath/);
});

test('chunked cloud video keeps merged source until preview generation settles', () => {
    assert.match(source, /const previewSource = target\.provider\.name === 'local' \? storedPath : tempMergedPath/);
    assert.match(source, /generateMediaPreview\(previewSource[\s\S]*\.finally\(async \(\) => \{[\s\S]*fsPromises\.rm\(tempMergedPath/);
    const completedAt = source.indexOf('if (!completed)');
    const videoAt = source.indexOf("if (type === 'video')", completedAt);
    assert.ok(completedAt >= 0 && videoAt > completedAt);
    assert.doesNotMatch(source.slice(completedAt, videoAt), /fsPromises\.rm\(tempMergedPath/);
});
