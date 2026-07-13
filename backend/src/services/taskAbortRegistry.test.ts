import assert from 'node:assert/strict';
import { TaskAbortRegistry } from './taskAbortRegistry.js';

const registry = new TaskAbortRegistry();
const first = registry.acquire('job-1');
const second = registry.acquire('job-1');
assert.equal(second, first, 'live acquires share one cancellation controller');

registry.release('job-1', first);
assert.equal(registry.get('job-1'), second, 'first release must retain the live second reference');
assert.equal(registry.cancel('job-1', 'cancelled'), true);
assert.equal(second.signal.aborted, true, 'remaining worker must still receive cancellation');
assert.equal(registry.cancel('job-1'), false);

const replacement = registry.acquire('job-1');
assert.notEqual(replacement, first);
registry.release('job-1', first);
assert.equal(registry.get('job-1'), replacement, 'old generation release must not affect replacement');
registry.release('job-1', replacement);
assert.equal(registry.get('job-1'), undefined);
console.log('task abort registry refcount ok');
