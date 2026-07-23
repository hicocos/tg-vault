import assert from 'node:assert/strict';
import test from 'node:test';
import { PersistentYtDlpQueue } from './ytDlpDownload.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

test('retry committed while the old worker is active is enqueued after old generation cleanup', async () => {
    const firstGate = deferred();
    const secondDone = deferred();
    let attempts = 0;
    let durablePending = false;
    const queue = new PersistentYtDlpQueue(1, async () => {
        attempts += 1;
        if (attempts === 1) await firstGate.promise;
        else secondDone.resolve();
    }, async () => durablePending && attempts < 2);

    queue.enqueue('yd-race');
    await new Promise(resolve => setTimeout(resolve, 0));
    durablePending = true;
    queue.enqueue('yd-race');
    firstGate.resolve();

    await Promise.race([
        secondDone.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('retried generation was stranded')), 1000)),
    ]);
    assert.equal(attempts, 2);
});