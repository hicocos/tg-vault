import assert from 'node:assert/strict';
import { waitForChannelExecutionPermission } from './telegramUpload.js';

const activeController = new AbortController();
let activeChecks = 0;
const activeResult = await waitForChannelExecutionPermission(async () => {
    activeChecks += 1;
    return 'paused';
}, activeController.signal, { allowUserPauseForActiveWorker: true });
assert.equal(activeResult, 'run');
assert.equal(activeChecks, 1);

const cancelledController = new AbortController();
cancelledController.abort();
assert.equal(await waitForChannelExecutionPermission(async () => 'run', cancelledController.signal), 'cancelled');
console.log('telegram graceful pause permission ok');
