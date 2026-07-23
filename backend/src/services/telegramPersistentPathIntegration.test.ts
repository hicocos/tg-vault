import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./telegramUpload.ts', import.meta.url), 'utf8');

test('ordinary single upload consumes a once path exactly once before queue execution', () => {
    const matches = source.match(/resolveTelegramStorageFolderPersistent\(chatIdStr/g) || [];
    assert.equal(matches.length, 1);
    assert.match(source, /const storageFolder = previewFolder/);
});
