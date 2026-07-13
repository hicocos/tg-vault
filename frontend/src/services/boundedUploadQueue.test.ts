import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedUploadQueue, summarizeUploads } from './boundedUploadQueue.js';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('bounded workers never exceed configured concurrency', async () => {
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    let active = 0;
    let peak = 0;
    const queue = new BoundedUploadQueue<number, number>(2, async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await gates[value].promise;
        active -= 1;
        return value;
    });

    const promises = Array.from({ length: 5 }, (_, index) => queue.enqueue(String(index), index));
    await flush();
    assert.equal(peak, 2);
    gates[0].resolve(); gates[1].resolve();
    await flush();
    assert.equal(peak, 2);
    gates[2].resolve(); gates[3].resolve();
    await flush();
    gates[4].resolve();
    assert.deepEqual(await Promise.all(promises), [0, 1, 2, 3, 4]);
});

test('cancel aborts active upload and cancels a pending item without starting it', async () => {
    const started: string[] = [];
    const firstGate = deferred<void>();
    const queue = new BoundedUploadQueue<string, string>(1, async (value, signal) => {
        started.push(value);
        if (value === 'first') {
            await Promise.race([
                firstGate.promise,
                new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
            ]);
        }
        return value;
    });

    const first = queue.enqueue('first', 'first');
    const second = queue.enqueue('second', 'second');
    await flush();
    assert.equal(queue.cancel('second'), true);
    assert.equal(queue.cancel('first'), true);
    await assert.rejects(first, /Aborted/);
    await assert.rejects(second, /cancelled/i);
    assert.deepEqual(started, ['first']);
});

test('failed item can be retried and partial summary remains truthful', async () => {
    let attempts = 0;
    const queue = new BoundedUploadQueue<string, string>(2, async value => {
        if (value === 'retry' && attempts++ === 0) throw new Error('temporary');
        return value;
    });

    await assert.rejects(queue.enqueue('item', 'retry'), /temporary/);
    assert.equal(await queue.retry('item'), 'retry');
    assert.deepEqual(summarizeUploads([
        { status: 'completed' }, { status: 'error' }, { status: 'cancelled' }, { status: 'uploading' },
    ]), { total: 4, completed: 1, failed: 1, cancelled: 1, active: 1, settled: false });
});
