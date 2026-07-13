import assert from 'node:assert/strict';
import { getUniqueStoredName } from './fileUtils.js';

const first = await getUniqueStoredName('report.pdf', 'docs', 'account-a');
const second = await getUniqueStoredName('report.pdf', 'docs', 'account-a');
assert.notEqual(first, second, 'concurrent-safe object keys must not depend on an unreserved database lookup');
assert.match(first, /^report--[0-9a-f-]{36}\.pdf$/);
assert.match(second, /^report--[0-9a-f-]{36}\.pdf$/);

console.log('unique stored object name ok');
