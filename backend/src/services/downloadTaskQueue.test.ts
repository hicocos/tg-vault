import assert from 'node:assert/strict';
import { DownloadTaskQueue } from './downloadTaskQueue.js';

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flush(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
}

async function testGroupsFilesAndStartsAutomatically() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    queue.ensureGroup({
        id: 'single-1',
        kind: 'single',
        title: 'report.pdf',
        chatId: 'chat-1',
        userId: 7,
        expectedTotal: 1,
    });
    queue.ensureGroup({
        id: 'album-1',
        kind: 'album',
        title: '夏日相册',
        chatId: 'chat-1',
        userId: 7,
        expectedTotal: 1,
    });

    const firstResult = queue.add('single-1', 'report.pdf', async () => {
        started.push('report.pdf');
        await first.promise;
    });
    const secondResult = queue.add('album-1', 'photo.jpg', async () => {
        started.push('photo.jpg');
        await second.promise;
    });

    await flush();
    assert.deepEqual(started, ['report.pdf']);

    const snapshot = queue.getSnapshot({ chatId: 'chat-1', userId: 7 });
    assert.equal(snapshot.groups.length, 2);
    assert.deepEqual(
        snapshot.groups.map(group => ({ id: group.id, state: group.state, total: group.total, active: group.active, pending: group.pending })),
        [
            { id: 'single-1', state: 'running', total: 1, active: 1, pending: 0 },
            { id: 'album-1', state: 'waiting', total: 1, active: 0, pending: 1 },
        ],
    );

    first.resolve();
    await firstResult;
    await flush();
    assert.deepEqual(started, ['report.pdf', 'photo.jpg']);

    second.resolve();
    await secondResult;
}

async function testPrioritizeGroupIsStableAndDoesNotPreemptActiveFile() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const blocker = deferred();
    const started: string[] = [];

    for (const group of [
        { id: 'blocker', title: 'blocker' },
        { id: 'group-b', title: 'B' },
        { id: 'group-c', title: 'C' },
    ]) {
        queue.ensureGroup({
            id: group.id,
            kind: 'album',
            title: group.title,
            chatId: 'chat-1',
            userId: 7,
            expectedTotal: group.id === 'blocker' ? 1 : 2,
        });
    }

    const promises = [
        queue.add('blocker', 'blocker', async () => {
            started.push('blocker');
            await blocker.promise;
        }),
        queue.add('group-b', 'b-1', async () => { started.push('b-1'); }),
        queue.add('group-c', 'c-1', async () => { started.push('c-1'); }),
        queue.add('group-b', 'b-2', async () => { started.push('b-2'); }),
        queue.add('group-c', 'c-2', async () => { started.push('c-2'); }),
    ];

    await flush();
    assert.deepEqual(started, ['blocker']);
    assert.equal(queue.prioritizeGroup('group-c', { chatId: 'chat-1', userId: 7 }).status, 'ok');
    assert.deepEqual(started, ['blocker']);

    blocker.resolve();
    await Promise.all(promises);
    assert.deepEqual(started, ['blocker', 'c-1', 'c-2', 'b-1', 'b-2']);
}

async function testPauseFinishesActiveFileThenResumeOnlySelectedGroup() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const a1 = deferred();
    const started: string[] = [];

    queue.ensureGroup({ id: 'group-a', kind: 'album', title: 'A', chatId: 'chat-1', userId: 7, expectedTotal: 2 });
    queue.ensureGroup({ id: 'group-b', kind: 'single', title: 'B', chatId: 'chat-1', userId: 7, expectedTotal: 1 });

    const promises = [
        queue.add('group-a', 'a-1', async () => { started.push('a-1'); await a1.promise; }),
        queue.add('group-a', 'a-2', async () => { started.push('a-2'); }),
        queue.add('group-b', 'b-1', async () => { started.push('b-1'); }),
    ];

    await flush();
    const pausing = queue.pauseGroup('group-a', { chatId: 'chat-1', userId: 7 });
    assert.equal(pausing.status, 'ok');
    assert.equal(pausing.group?.state, 'pausing');

    a1.resolve();
    await flush();
    assert.deepEqual(started, ['a-1', 'b-1']);
    await flush();
    assert.equal(queue.getGroup('group-a', { chatId: 'chat-1', userId: 7 })?.state, 'paused');

    const resumed = queue.resumeGroup('group-a', { chatId: 'chat-1', userId: 7 });
    assert.equal(resumed.status, 'ok');
    await Promise.all(promises);
    assert.deepEqual(started, ['a-1', 'b-1', 'a-2']);
}

async function testImmediatePauseWithoutActiveFileAndSystemPausePrecedence() {
    const userPausedQueue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const userBlocker = deferred<void>();
    userPausedQueue.ensureGroup({ id: 'user-blocker', kind: 'single', title: 'blocker', chatId: 'chat', expectedTotal: 1 });
    userPausedQueue.ensureGroup({ id: 'user-waiting', kind: 'single', title: 'waiting', chatId: 'chat', expectedTotal: 1 });
    const userActive = userPausedQueue.add('user-blocker', 'blocker', async () => userBlocker.promise);
    const userWaiting = userPausedQueue.add('user-waiting', 'waiting', async () => undefined);
    await flush();
    userPausedQueue.pauseAll();
    const userSnapshot = userPausedQueue.getSnapshot({ chatId: 'chat' }).groups.find(group => group.id === 'user-waiting');
    assert.equal(userSnapshot?.reason, '用户已暂停下载队列');
    assert.equal(userPausedQueue.resumeGroup('user-waiting', { chatId: 'chat' }).status, 'ok');
    assert.equal(userPausedQueue.getStats().userPaused, true);
    userBlocker.resolve();
    await userActive;
    await flush();
    assert.equal(userPausedQueue.getGroup('user-waiting', { chatId: 'chat' })?.state, 'paused');
    userPausedQueue.resumeAll();
    await userWaiting;

    const groupPausedByUser = new DownloadTaskQueue({ maxConcurrent: 1 });
    const gate = deferred<void>();
    groupPausedByUser.ensureGroup({ id: 'status-blocker', kind: 'single', title: 'blocker', chatId: 'chat', expectedTotal: 1 });
    groupPausedByUser.ensureGroup({ id: 'status-waiting', kind: 'single', title: 'waiting', chatId: 'chat', expectedTotal: 1 });
    const active = groupPausedByUser.add('status-blocker', 'blocker', async () => gate.promise);
    const waiting = groupPausedByUser.add('status-waiting', 'waiting', async () => undefined);
    await flush();
    groupPausedByUser.pauseAll();
    assert.equal(groupPausedByUser.getGroup('status-waiting', { chatId: 'chat' })?.state, 'paused');
    gate.resolve();
    groupPausedByUser.resumeGroup('status-waiting', { chatId: 'chat' });
    groupPausedByUser.resumeAll();
    await Promise.all([active, waiting]);

    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const blocker = deferred<void>();
    queue.ensureGroup({ id: 'blocker', kind: 'single', title: 'blocker', chatId: 'chat-1', expectedTotal: 1 });
    queue.ensureGroup({ id: 'waiting', kind: 'single', title: 'waiting', chatId: 'chat-1', expectedTotal: 1 });
    const first = queue.add('blocker', 'blocker', async () => blocker.promise);
    const second = queue.add('waiting', 'waiting', async () => undefined);
    await flush();

    assert.equal(queue.pauseGroup('waiting', { chatId: 'chat-1' }).group?.state, 'paused');
    queue.pauseAll('系统磁盘保护', 'system');
    assert.equal(queue.resumeGroup('waiting', { chatId: 'chat-1' }).status, 'blocked');

    blocker.resolve();
    await first;
    queue.resumeAll('system');
    assert.equal(queue.resumeGroup('waiting', { chatId: 'chat-1' }).status, 'ok');
    await second;
}

async function testCancelIsScopedOwnedAndIdempotent() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 2 });
    const activeA = deferred();
    const activeB = deferred();
    const aborted: string[] = [];
    const started: string[] = [];
    let pendingCancellationNotices = 0;

    queue.ensureGroup({ id: 'group-a', kind: 'album', title: 'A', chatId: 'chat-1', userId: 7, expectedTotal: 2 });
    queue.ensureGroup({ id: 'group-b', kind: 'album', title: 'B', chatId: 'chat-1', userId: 7, expectedTotal: 2 });
    queue.ensureGroup({ id: 'group-c', kind: 'single', title: 'C', chatId: 'chat-2', userId: 7, expectedTotal: 1 });

    const observeAbort = (name: string, signal: AbortSignal, gate: ReturnType<typeof deferred<void>>) => new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            aborted.push(name);
            reject(new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        gate.promise.then(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, reject);
    });

    const promises = [
        queue.add('group-a', 'a-1', async (signal: AbortSignal) => { started.push('a-1'); await observeAbort('a-1', signal, activeA); }),
        queue.add('group-b', 'b-1', async (signal: AbortSignal) => { started.push('b-1'); await observeAbort('b-1', signal, activeB); }),
        queue.add('group-a', 'a-2', async () => { started.push('a-2'); }, 0, () => { pendingCancellationNotices += 1; }),
        queue.add('group-b', 'b-2', async () => { started.push('b-2'); }),
        queue.add('group-c', 'c-1', async () => { started.push('c-1'); }),
    ];
    await flush();

    assert.equal(queue.cancelGroup('group-a', { chatId: 'chat-2', userId: 7 }).status, 'forbidden');
    const cancelled = queue.cancelGroup('group-a', { chatId: 'chat-1', userId: 7 });
    assert.equal(cancelled.status, 'ok');
    assert.equal(cancelled.pending, 0);
    assert.deepEqual(aborted, ['a-1']);
    assert.equal(pendingCancellationNotices, 1);
    assert.equal(queue.cancelGroup('group-a', { chatId: 'chat-1', userId: 7 }).status, 'ok');

    const sharedPrefixOtherChat = queue.pauseGroup('group', { chatId: 'chat-2', userId: 7 });
    assert.equal(sharedPrefixOtherChat.status, 'ok');
    assert.equal(queue.getGroup('group-b', { chatId: 'chat-1', userId: 7 })?.state, 'running');
    assert.equal(queue.resumeGroup('group-a', { chatId: 'chat-1', userId: 7 }).status, 'terminal');

    activeB.resolve();
    await flush();
    assert.deepEqual(started, ['a-1', 'b-1', 'b-2']);
    assert.equal(queue.getGroup('group-c', { chatId: 'chat-2', userId: 7 })?.state, 'paused');
    assert.equal(queue.resumeGroup('group-c', { chatId: 'chat-2', userId: 7 }).status, 'ok');
    await Promise.all(promises);
    assert.deepEqual(started, ['a-1', 'b-1', 'b-2', 'c-1']);
    assert.deepEqual(aborted, ['a-1']);
    assert.equal(queue.getGroup('group-a', { chatId: 'chat-1', userId: 7 }), undefined);
}

async function testPauseLastActiveFileCompletesInsteadOfLeavingEmptyPausedGroup() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const gate = deferred();
    queue.ensureGroup({ id: 'single-last', kind: 'single', title: 'last.bin', chatId: 'chat-1', userId: 7, expectedTotal: 1 });
    const task = queue.add('single-last', 'last.bin', async () => gate.promise);
    await flush();

    assert.equal(queue.pauseGroup('single-last', { chatId: 'chat-1', userId: 7 }).group?.state, 'pausing');
    gate.resolve();
    await task;
    await flush();

    assert.equal(queue.getGroup('single-last', { chatId: 'chat-1', userId: 7 }), undefined);
    assert.equal(queue.getSnapshot({ chatId: 'chat-1', userId: 7 }).groups.length, 0);
}

async function testAddingAfterCancellationSettlesAsCancelledWithoutExecuting() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    let executed = false;
    let cancellationNotices = 0;
    queue.ensureGroup({ id: 'cancelled-group', kind: 'album', title: 'cancelled', chatId: 'chat-1', userId: 7, expectedTotal: 1 });
    assert.equal(queue.cancelGroup('cancelled-group', { chatId: 'chat-1', userId: 7 }).status, 'ok');

    await queue.add(
        'cancelled-group',
        'late-file',
        async () => { executed = true; },
        0,
        () => { cancellationNotices += 1; },
    );

    assert.equal(executed, false);
    assert.equal(cancellationNotices, 1);
}

async function testRetryFailedIsScopedAndDoesNotRepeatTheSameHistoryEntry() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    let attemptsA = 0;
    let attemptsB = 0;
    queue.ensureGroup({ id: 'retry-a', kind: 'single', title: 'A', chatId: 'chat-a', userId: 7, expectedTotal: 1 });
    queue.ensureGroup({ id: 'retry-b', kind: 'single', title: 'B', chatId: 'chat-b', userId: 7, expectedTotal: 1 });

    await queue.add('retry-a', 'a.bin', async () => {
        attemptsA += 1;
        return attemptsA === 1 ? { status: 'failed', error: 'first failure' } : { status: 'success' };
    });
    await queue.add('retry-b', 'b.bin', async () => {
        attemptsB += 1;
        return { status: 'failed', error: 'always fails' };
    });

    const firstRetry = await queue.retryFailed(10, { chatId: 'chat-a', userId: 7 });
    assert.equal(firstRetry.retried, 1);
    await flush();
    assert.equal(attemptsA, 2);
    assert.equal(attemptsB, 1);

    const secondRetry = await queue.retryFailed(10, { chatId: 'chat-a', userId: 7 });
    assert.equal(secondRetry.retried, 0);
    assert.equal(attemptsA, 2);
}

async function testScopedCancelDoesNotAffectOtherChat() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const gate = deferred<void>();
    queue.ensureGroup({ id: 'scope-a', kind: 'single', title: 'A', chatId: 'chat-a', userId: 7, expectedTotal: 1 });
    queue.ensureGroup({ id: 'scope-b', kind: 'single', title: 'B', chatId: 'chat-b', userId: 8, expectedTotal: 1 });
    const a = queue.add('scope-a', 'a.bin', async signal => new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        gate.promise.then(resolve);
    }));
    const b = queue.add('scope-b', 'b.bin', async () => undefined);
    await flush();
    const cancelled = queue.cancelScope({ chatId: 'chat-a', userId: 7 });
    assert.equal(cancelled.total, 1);
    await Promise.all([a, b]);
    assert.equal(queue.getGroup('scope-b', { chatId: 'chat-b', userId: 8 }), undefined);
}

async function testReusingTerminalGroupStartsFreshGeneration() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    queue.ensureGroup({ id: 'reuse', kind: 'single', title: 'first', chatId: 'chat', userId: 1, expectedTotal: 1 });
    await queue.add('reuse', 'first.bin', async () => undefined);
    const fresh = queue.ensureGroup({ id: 'reuse', kind: 'single', title: 'second', chatId: 'chat', userId: 1, expectedTotal: 1 });
    assert.equal(fresh.completed, 0);
    assert.equal(fresh.total, 1);
    await queue.add('reuse', 'second.bin', async () => undefined);
}

async function testTerminalGroupsAreBounded() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 10 });
    for (let index = 0; index < 550; index += 1) {
        const id = `bounded-${index}`;
        queue.ensureGroup({ id, kind: 'single', title: id, chatId: 'chat', userId: 1, expectedTotal: 1 });
        await queue.add(id, `${id}.bin`, async () => undefined);
    }
    assert(queue.getDebugGroupCount() <= 500);
}

async function testUserPausedQueueCanResumeOneGroupAndNewGroupsAreNotPaused() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const blocker = deferred<void>();
    const first = queue.add(
        (queue.ensureGroup({ id: 'old', kind: 'single', title: 'old', chatId: 'chat', userId: 1, expectedTotal: 1 }), 'old'),
        'old.bin',
        async () => blocker.promise,
    );
    queue.ensureGroup({ id: 'paused', kind: 'single', title: 'paused', chatId: 'chat', userId: 1, expectedTotal: 1 });
    const pausedTask = queue.add('paused', 'paused.bin', async () => undefined);
    await flush();
    queue.pauseScope({ chatId: 'chat', userId: 1 });
    assert.equal(queue.getSnapshot().pauseReason, undefined);
    queue.pauseGroup('paused', { chatId: 'chat', userId: 1 });
    blocker.resolve();
    await first;
    assert.equal(queue.resumeGroup('paused', { chatId: 'chat', userId: 1 }).status, 'ok');
    await flush();
    assert.equal(queue.getScopeStatus({ chatId: 'chat', userId: 1 }).userPaused, true);
    queue.resumeScope({ chatId: 'chat', userId: 1 });
    await pausedTask;

    queue.ensureGroup({ id: 'new', kind: 'single', title: 'new', chatId: 'chat', userId: 1, expectedTotal: 1 });
    const newTask = queue.add('new', 'new.bin', async () => undefined);
    await newTask;
}

async function testCancelWhileScopedPausedDoesNotPauseFutureTasks() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const scope = { chatId: 'chat', userId: 1 };
    queue.ensureGroup({ id: 'cancel-old', kind: 'single', title: 'old', ...scope, expectedTotal: 1 });
    queue.pauseScope(scope);
    const oldTask = queue.add('cancel-old', 'old.bin', async () => undefined);
    assert.equal(queue.cancelGroup('cancel-old', scope).status, 'ok');
    await oldTask;
    assert.equal(queue.getScopeStatus(scope).userPaused, true);
    queue.resumeScope(scope);

    let newStarted = false;
    queue.ensureGroup({ id: 'after-cancel', kind: 'single', title: 'new', ...scope, expectedTotal: 1 });
    await queue.add('after-cancel', 'new.bin', async () => { newStarted = true; });
    assert.equal(newStarted, true);
}

async function testScopeStatusReflectsGroupPauseIndependentlyOfGlobalQueue() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const gate = deferred<void>();
    queue.ensureGroup({ id: 'scope-paused', kind: 'album', title: 'paused', chatId: 'chat', userId: 1, expectedTotal: 2 });
    const active = queue.add('scope-paused', 'a.bin', async () => gate.promise);
    const waiting = queue.add('scope-paused', 'b.bin', async () => undefined);
    await flush();

    assert.equal(queue.getStats().paused, false);
    assert.equal(queue.pauseGroup('scope-paused', { chatId: 'chat', userId: 1 }).group?.state, 'pausing');
    assert.deepEqual(queue.getScopeStatus({ chatId: 'chat', userId: 1 }), {
        paused: false,
        pausing: true,
        systemBlocked: false,
        userPaused: false,
        reason: '正在完成当前文件，随后暂停',
        systemPause: undefined,
    });

    gate.resolve();
    await active;
    await flush();
    assert.equal(queue.getStats().paused, false);
    assert.deepEqual(queue.getScopeStatus({ chatId: 'chat', userId: 1 }), {
        paused: true,
        pausing: false,
        systemBlocked: false,
        userPaused: true,
        reason: '用户已暂停任务',
        systemPause: undefined,
    });

    assert.equal(queue.resumeGroup('scope-paused', { chatId: 'chat', userId: 1 }).status, 'ok');
    await waiting;
}

async function testReasonTextCannotMisclassifyUserPauseAsSystemProtection() {
    const userReasonQueue = new DownloadTaskQueue({ maxConcurrent: 1 });
    userReasonQueue.ensureGroup({ id: 'wording', kind: 'single', title: 'wording', chatId: 'chat', expectedTotal: 1 });
    userReasonQueue.pauseAll('用户暂停：等待磁盘整理完成', 'user');
    const status = userReasonQueue.getScopeStatus({ chatId: 'chat' });
    assert.equal(status.systemBlocked, false);
    assert.equal(status.systemPause, undefined);
    userReasonQueue.resumeAll('user');

    const systemQueue = new DownloadTaskQueue({ maxConcurrent: 1 });
    systemQueue.ensureGroup({ id: 'disk', kind: 'single', title: 'disk', chatId: 'chat', expectedTotal: 1 });
    systemQueue.pauseForDiskPressure('磁盘空间不足：可用 1 GB', 30_000);
    const systemStatus = systemQueue.getScopeStatus({ chatId: 'chat' });
    assert.equal(systemStatus.systemBlocked, true);
    assert.deepEqual(systemStatus.systemPause, {
        kind: 'disk_pressure',
        reason: '磁盘空间不足：可用 1 GB',
        autoResume: true,
        recheckMs: 30_000,
        blockerCount: 1,
    });
    assert.equal(systemQueue.resumeGroup('disk', { chatId: 'chat' }).status, 'blocked');
    systemQueue.resumeFromDiskPressure();
    assert.equal(systemQueue.getScopeStatus({ chatId: 'chat' }).systemBlocked, false);
}

async function testMultipleDiskPressureBlockersDoNotResumeEarly() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    let started = false;
    queue.ensureGroup({ id: 'multi-disk', kind: 'single', title: 'disk', chatId: 'chat', expectedTotal: 1 });
    queue.acquireDiskPressureBlocker('a', 'A 仍需空间', 10_000);
    queue.acquireDiskPressureBlocker('b', 'B 仍需空间', 30_000);
    const pending = queue.add('multi-disk', 'file.bin', async () => { started = true; });
    await flush();
    assert.equal(started, false);
    assert.equal(queue.getStats().systemPause?.blockerCount, 2);
    assert.equal(queue.getSnapshot({ chatId: 'chat' }).systemPause?.blockerCount, 2);

    queue.releaseDiskPressureBlocker('a');
    await flush();
    assert.equal(started, false);
    assert.equal(queue.getStats().systemPause?.blockerCount, 1);

    queue.releaseDiskPressureBlocker('b');
    await pending;
    assert.equal(started, true);
    assert.equal(queue.getStats().systemPause, undefined);
}

async function testGlobalUserAndSystemPauseLocksRemainIndependent() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    queue.ensureGroup({ id: 'dual-lock', kind: 'single', title: 'dual', chatId: 'chat', expectedTotal: 1 });
    let starts = 0;
    queue.pauseAll('用户暂停', 'user');
    queue.acquireDiskPressureBlocker('disk', '容量低于安全阈值', 30_000);
    const pending = queue.add('dual-lock', 'file.bin', async () => { starts += 1; });
    queue.releaseDiskPressureBlocker('disk');
    await flush();
    assert.equal(starts, 0);
    assert.equal(queue.getStats().pauseReason, '用户已暂停下载队列');
    queue.resumeAll('user');
    await pending;
    assert.equal(starts, 1);
}

async function testLateAddToPausedGroupDoesNotStart() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    queue.ensureGroup({ id: 'late-paused', kind: 'album', title: 'late', chatId: 'chat', expectedTotal: 1 });
    assert.equal(queue.pauseGroup('late-paused', { chatId: 'chat' }).status, 'ok');
    let started = false;
    const pending = queue.add('late-paused', 'late.bin', async () => { started = true; });
    await flush();
    assert.equal(started, false);
    assert.equal(queue.getGroup('late-paused', { chatId: 'chat' })?.state, 'paused');
    queue.resumeGroup('late-paused', { chatId: 'chat' });
    await pending;
    assert.equal(started, true);
}

async function testScopedPauseDoesNotBlockOrResumeOtherOwners() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const started: string[] = [];
    const scopeA = { chatId: 'chat-a', userId: 1 };
    const scopeB = { chatId: 'chat-b', userId: 2 };
    queue.ensureGroup({ id: 'scope-pause-a', kind: 'single', title: 'A', ...scopeA, expectedTotal: 1 });
    queue.ensureGroup({ id: 'scope-pause-b', kind: 'single', title: 'B', ...scopeB, expectedTotal: 1 });

    assert.equal(queue.pauseScope(scopeA).total, 0);
    const a = queue.add('scope-pause-a', 'a.bin', async () => { started.push('a'); });
    const b = queue.add('scope-pause-b', 'b.bin', async () => { started.push('b'); });
    await b;
    assert.deepEqual(started, ['b']);
    assert.equal(queue.getScopeStatus(scopeA).userPaused, true);
    assert.equal(queue.getScopeStatus(scopeB).userPaused, false);

    queue.resumeScope(scopeB);
    await flush();
    assert.deepEqual(started, ['b']);
    queue.resumeScope(scopeA);
    await a;
    assert.deepEqual(started, ['b', 'a']);
}

async function testGroupControlNeverClearsGlobalPause() {
    const queue = new DownloadTaskQueue({ maxConcurrent: 1 });
    const scope = { chatId: 'chat', userId: 1 };
    queue.ensureGroup({ id: 'global-lock-a', kind: 'single', title: 'A', ...scope, expectedTotal: 1 });
    queue.ensureGroup({ id: 'global-lock-b', kind: 'single', title: 'B', ...scope, expectedTotal: 1 });
    queue.pauseAll();
    const a = queue.add('global-lock-a', 'a.bin', async () => undefined);
    const b = queue.add('global-lock-b', 'b.bin', async () => undefined);

    assert.equal(queue.resumeGroup('global-lock-a', scope).status, 'ok');
    assert.equal(queue.getStats().userPaused, true);
    assert.equal(queue.cancelGroup('global-lock-a', scope).status, 'ok');
    assert.equal(queue.getStats().userPaused, true);
    await a;
    await flush();
    assert.equal(queue.getGroup('global-lock-b', scope)?.state, 'paused');

    queue.resumeAll();
    await b;
}

async function main() {
    await testGroupsFilesAndStartsAutomatically();
    await testPrioritizeGroupIsStableAndDoesNotPreemptActiveFile();
    await testPauseFinishesActiveFileThenResumeOnlySelectedGroup();
    await testImmediatePauseWithoutActiveFileAndSystemPausePrecedence();
    await testCancelIsScopedOwnedAndIdempotent();
    await testPauseLastActiveFileCompletesInsteadOfLeavingEmptyPausedGroup();
    await testAddingAfterCancellationSettlesAsCancelledWithoutExecuting();
    await testRetryFailedIsScopedAndDoesNotRepeatTheSameHistoryEntry();
    await testScopedCancelDoesNotAffectOtherChat();
    await testReusingTerminalGroupStartsFreshGeneration();
    await testTerminalGroupsAreBounded();
    await testUserPausedQueueCanResumeOneGroupAndNewGroupsAreNotPaused();
    await testCancelWhileScopedPausedDoesNotPauseFutureTasks();
    await testScopeStatusReflectsGroupPauseIndependentlyOfGlobalQueue();
    await testReasonTextCannotMisclassifyUserPauseAsSystemProtection();
    await testMultipleDiskPressureBlockersDoNotResumeEarly();
    await testGlobalUserAndSystemPauseLocksRemainIndependent();
    await testLateAddToPausedGroupDoesNotStart();
    await testScopedPauseDoesNotBlockOrResumeOtherOwners();
    await testGroupControlNeverClearsGlobalPause();
    console.log('download task queue ok');
}

await main();
