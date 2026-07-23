import assert from 'node:assert/strict';
import test from 'node:test';
import { filterDismissedTasks, isTaskDismissible, type TaskCenterIdentity } from './taskCenterDismissals.js';

const task = (status: string, updatedAt = '2026-07-23T00:00:00.000Z'): TaskCenterIdentity & { status: string } => ({
    sourceType: 'subscription', id: 'task-1', status, updatedAt,
});

test('only terminal task states are dismissible', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'disabled', 'interrupted', 'retry_required']) {
        assert.equal(isTaskDismissible(task(status)), true, status);
    }
    for (const status of ['pending', 'running', 'paused', 'waiting', 'scheduled', 'open', 'completing']) {
        assert.equal(isTaskDismissible(task(status)), false, status);
    }
});

test('dismissal hides only the exact task version', () => {
    const dismissed = [{ sourceType: 'subscription', taskId: 'task-1', taskUpdatedAt: new Date('2026-07-23T00:00:00.000Z') }];
    assert.deepEqual(filterDismissedTasks([task('disabled')], dismissed), []);
    assert.equal(filterDismissedTasks([task('disabled', '2026-07-23T00:01:00.000Z')], dismissed).length, 1);
});
