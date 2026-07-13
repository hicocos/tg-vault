import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./telegramCommands.ts', import.meta.url), 'utf8');
assert.match(source, /interface PendingStorageClearSnapshot/);
assert.match(source, /pendingStorageClearSnapshots\.set\(confirmationToken/);
assert.match(source, /indexedIds: indexed\.rows\.map/);
assert.match(source, /orphanPaths: stats\.paths\.map/);
assert.match(source, /SELECT \* FROM files WHERE source = 'local' AND id = ANY/);
assert.match(source, /for \(const resolved of snapshot\.orphanPaths\)/);
assert.doesNotMatch(source, /for \(const filePath of stats\.paths\)/);
console.log('telegram storage clear snapshot binding ok');
