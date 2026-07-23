import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./upload.ts', import.meta.url), 'utf8');

test('cloud image uploads generate local thumbnails and previews from the temporary source', () => {
    assert.match(source, /if \(mimeType\.startsWith\('image\/'\) \|\| mimeType\.startsWith\('video\/'\)\)/);
    assert.match(source, /if \(mimeType\.startsWith\('image\/'\)\)[\s\S]*generateMediaPreview\(tempPath/);
});

test('cloud video temporary source survives until asynchronous preview generation settles', () => {
    assert.match(source, /const previewSource = provider\.name === 'local' \? storedPath : tempPath/);
    assert.match(source, /generateMediaPreview\(previewSource[\s\S]*\.finally\(\(\) => \{[\s\S]*fs\.unlinkSync\(tempPath\)/);
    const indexedAt = source.indexOf('const storedPath = await saveAndIndexWithCompensation');
    const videoAt = source.indexOf("if (type === 'video')", indexedAt);
    assert.ok(indexedAt >= 0 && videoAt > indexedAt);
    assert.doesNotMatch(source.slice(indexedAt, videoAt), /fs\.unlinkSync\(tempPath\)/);
});
