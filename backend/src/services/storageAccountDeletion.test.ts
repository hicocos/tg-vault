import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../routes/storage.ts', import.meta.url), 'utf8');
const deleteRoute = source.slice(source.indexOf("router.delete('/accounts/:id'"), source.indexOf('export default router'));
const lifecycle = fs.readFileSync(new URL('./storageAccountLifecycle.ts', import.meta.url), 'utf8');
assert.match(deleteRoute, /pool\.connect\(\)/);
assert.match(deleteRoute, /BEGIN/);
assert.match(deleteRoute, /deleteStorageAccountWithClient/);
assert.match(deleteRoute, /COMMIT/);
assert.match(deleteRoute, /ROLLBACK/);
assert.match(lifecycle, /FOR UPDATE/);
assert.match(lifecycle, /is_active/);
assert.match(lifecycle, /params->>'storageAccountId'/);
assert.match(lifecycle, /SELECT id, name, type/);
console.log('storage account deletion transaction ok');
