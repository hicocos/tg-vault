import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
assert.match(source, /async function initializeApplication/);
assert.match(source, /await initializeApplication\(\)[\s\S]*app\.listen/);
assert.doesNotMatch(source, /const server = app\.listen\(PORT, async \(\) =>/);
assert.match(source, /process\.exitCode = 1/);
console.log('backend only listens after initialization ok');
