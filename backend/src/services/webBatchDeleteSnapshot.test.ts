import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../routes/folderOperations.ts', import.meta.url), 'utf8');
assert.match(source, /ARRAY_AGG\(DISTINCT id\)/);
assert.match(source, /const immutableFileIds: string\[\] = row\.file_ids \|\| \[\]/);
assert.match(source, /batchDeleteConfirmationStore\.issue/);
const executeRoute = source.slice(source.indexOf("router.post('/batch-delete',"));
assert.match(executeRoute, /const \{ confirmationToken \} = req\.body/);
assert.match(executeRoute, /batchDeleteConfirmationStore\.consume/);
assert.doesNotMatch(executeRoute, /folder = ANY/);
assert.match(executeRoute, /id = ANY\(\$\{nextParam\(storageScope, 1\)\}::uuid\[\]\)/);
console.log('web batch delete snapshot token binding ok');
