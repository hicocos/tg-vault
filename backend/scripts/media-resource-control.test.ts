import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// Loading boundaries are intentional: modules snapshot resource/cache env on
// initialization, so isolated limits/paths must be configured before import.
process.env.MEDIA_CONCURRENCY = '1';
process.env.MEDIA_QUEUE_LIMIT = '32';
const { MediaGate, MediaProcessTimeoutError, runMediaProcess, runMediaTask } = await import('../src/utils/mediaControl.js');

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
test('abort immediately after acquisition does not start work or leak a slot', async () => {
    const gate = new MediaGate(1, 0);
    const controller = new AbortController();
    let started = false;
    const task = gate.run(async () => { started = true; }, controller.signal);
    const rejected = assert.rejects(task, /cancelled/);
    controller.abort(new Error('cancelled'));
    await rejected;
    assert.equal(started, false);
    assert.equal(await gate.run(async () => 'available'), 'available');
});

test('configured media parallelism never starts a third operation before one settles', async () => {
    const gate = new MediaGate(2, 2);
    const firstStarted = deferred();
    const secondStarted = deferred();
    const release = deferred();
    const first = gate.run(async () => { firstStarted.resolve(); await release.promise; });
    const second = gate.run(async () => { secondStarted.resolve(); await release.promise; });
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    let thirdStarted = false;
    const third = gate.run(async () => { thirdStarted = true; });
    await Promise.resolve();
    assert.equal(thirdStarted, false);
    release.resolve();
    await Promise.all([first, second, third]);
    assert.equal(thirdStarted, true);
});


async function childPid(file: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const check = async () => {
            try {
                const value = await readFile(file, 'utf8').catch(() => '');
                if (!value) return;
                watcher.close();
                resolve(Number(value));
            } catch (error) {
                watcher.close();
                reject(error);
            }
        };
        const watcher = watch(path.dirname(file), () => { void check(); });
        watcher.on('error', error => { watcher.close(); reject(error); });
        void check();
    });
}

const sleepingChild = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)`;

test('bounded media gate rejects overflow and cancelled waiters never start or consume a slot', async () => {
    const gate = new MediaGate(1, 1);
    const started = deferred();
    const release = deferred();
    const first = gate.run(async () => { started.resolve(); await release.promise; });
    await started.promise;
    const controller = new AbortController();
    let cancelledStarted = false;
    const cancelled = gate.run(async () => { cancelledStarted = true; }, controller.signal);
    const rejected = assert.rejects(cancelled, /cancelled/);
    await assert.rejects(gate.run(async () => undefined), /queue full/);
    controller.abort(new Error('cancelled'));
    await rejected;
    let nextStarted = false;
    const next = gate.run(async () => { nextStarted = true; });
    assert.equal(nextStarted, false);
    release.resolve();
    await Promise.all([first, next]);
    assert.equal(cancelledStarted, false);
    assert.equal(nextStarted, true);
});

test('running cancellation holds its slot until native work settles, and failures release it', async () => {
    const gate = new MediaGate(1, 2);
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    const first = gate.run(async () => { started.resolve(); await release.promise; }, controller.signal);
    const rejected = assert.rejects(first, /cancelled/);
    await started.promise;
    controller.abort(new Error('cancelled'));
    let nextStarted = false;
    const next = gate.run(async () => { nextStarted = true; });
    await Promise.resolve();
    assert.equal(nextStarted, false);
    release.resolve();
    await Promise.all([rejected, next]);
    await assert.rejects(gate.run(async () => { throw new Error('native failure'); }), /native failure/);
    assert.equal(await gate.run(async () => 42), 42);
});

test('a pre-cancelled or queued-cancelled process never spawns', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'media-cancel-'));
    const marker = path.join(directory, 'pid');
    const controller = new AbortController();
    const started = deferred();
    const release = deferred();
    const blocker = runMediaTask(async () => { started.resolve(); await release.promise; });
    try {
        await started.promise;
        const child = runMediaProcess(process.execPath, ['-e', sleepingChild, marker], { timeoutMs: 5000, signal: controller.signal });
        const rejected = assert.rejects(child, /cancelled/);
        controller.abort(new Error('cancelled'));
        await rejected;
        await assert.rejects(runMediaProcess(process.execPath, ['-e', sleepingChild, marker], { timeoutMs: 5000, signal: controller.signal }), /cancelled/);
        await assert.rejects(stat(marker), { code: 'ENOENT' });
    } finally {
        release.resolve();
        await blocker;
        await rm(directory, { recursive: true, force: true });
    }
});

test('process abort kills and reaps before the next heavy operation starts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'media-abort-'));
    const marker = path.join(directory, 'pid');
    const controller = new AbortController();
    const child = runMediaProcess(process.execPath, ['-e', sleepingChild, marker], { timeoutMs: 5000, signal: controller.signal });
    const rejected = assert.rejects(child, /cancelled/);
    try {
        const pid = await childPid(marker);
        const next = runMediaTask(async () => {
            assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        });
        controller.abort(new Error('cancelled'));
        await Promise.all([rejected, next]);
    } finally {
        controller.abort(new Error('cleanup'));
        await child.catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
    }
});

test('process hard deadline reaps the child and spawn/exit failures release the media slot', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'media-timeout-'));
    const marker = path.join(directory, 'pid');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = runMediaProcess(process.execPath, ['-e', sleepingChild, marker], { timeoutMs: 1000 });
    const rejected = assert.rejects(child, MediaProcessTimeoutError);
    try {
        const pid = await childPid(marker);
        t.mock.timers.tick(1000);
        await rejected;
        t.mock.timers.reset();
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        await assert.rejects(runMediaProcess(path.join(directory, 'missing-executable'), [], { timeoutMs: 1000 }), { code: 'ENOENT' });
        await assert.rejects(runMediaProcess(process.execPath, ['-e', 'process.exit(7)'], { timeoutMs: 1000 }), /exited \(7\)/);
        assert.equal(await runMediaProcess(process.execPath, ['-e', 'process.stdout.write("ready")'], { timeoutMs: 1000 }), 'ready');
    } finally {
        t.mock.timers.reset();
        await rm(directory, { recursive: true, force: true });
    }
});

test('real preview consumers retain cache deduplication and one cancelled consumer cannot cancel the others', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'media-preview-'));
    process.env.PREVIEW_DIR = path.join(directory, 'previews');
    process.env.PREVIEW_MIN_FREE_BYTES = '1';
    // The preview cache directory must be isolated before module initialization.
    const { generateMediaPreview } = await import('../src/utils/previewCache.js');
    const source = path.join(directory, 'source.png');
    await sharp({ create: { width: 32, height: 24, channels: 3, background: '#abcdef' } }).png().toFile(source);
    const started = deferred();
    const release = deferred();
    const blocker = runMediaTask(async () => { started.resolve(); await release.promise; });
    const controller = new AbortController();
    try {
        await started.promise;
        const first = generateMediaPreview(source, 'source.png', 'image/png', 'shared', controller.signal);
        const rejected = assert.rejects(first, /cancelled/);
        const second = generateMediaPreview(source, 'source.png', 'image/png', 'shared');
        controller.abort(new Error('cancelled'));
        release.resolve();
        await blocker;
        await rejected;
        const output = await second;
        assert.ok(output);
        assert.ok((await stat(output)).size > 0);
        assert.equal(await generateMediaPreview(source, 'source.png', 'image/png', 'shared'), output);
        const metadata = await sharp(output).metadata();
        assert.equal(metadata.width, 32);
        assert.equal(metadata.height, 24);
        const broken = path.join(directory, 'broken.png');
        await writeFile(broken, 'invalid image');
        const failures = await Promise.allSettled([
            generateMediaPreview(broken, 'broken.png', 'image/png', 'retry'),
            generateMediaPreview(broken, 'broken.png', 'image/png', 'retry'),
        ]);
        assert.ok(failures.every(result => result.status === 'rejected'));
        assert.ok(await generateMediaPreview(source, 'source.png', 'image/png', 'retry'));
    } finally {
        controller.abort(new Error('cleanup'));
        release.resolve();
        await blocker;
        await rm(directory, { recursive: true, force: true });
    }
});
