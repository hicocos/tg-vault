import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./storage.ts', import.meta.url), 'utf8');

assert.match(source, /status\s+IN\s*\(\s*'success'\s*,\s*'failed'\s*,\s*'skipped'\s*\)/);
assert.doesNotMatch(source, /status\s*=\s*'completed'/);

console.log('storage maintenance download item cleanup statuses ok');
