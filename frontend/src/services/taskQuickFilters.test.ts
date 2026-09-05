import assert from 'node:assert/strict';
import test from 'node:test';
import { dismissibleTaskSnapshot, pruneSelectedTaskKeys, scopeTasks, summarizeTaskStatuses, taskQuickFilter } from './taskQuickFilters.js';

const tasks = [
    { id: 'scheduled-a', sourceType: 'telegram_target', status: 'scheduled', dismissible: false, target: { accountId: 'a' } },
    { id: 'pending-a', sourceType: 'web_upload', status: 'pending', dismissible: false, target: { accountId: 'a' } },
    { id: 'completing-a', sourceType: 'web_upload', status: 'completing', dismissible: false, target: { accountId: 'a' } },
    { id: 'failed-a', sourceType: 'web_upload', status: 'failed', dismissible: true, target: { accountId: 'a' } },
    { id: 'completed-a', sourceType: 'web_upload', status: 'completed', dismissible: true, target: { accountId: 'a' } },
    { id: 'failed-b', sourceType: 'web_upload', status: 'failed', dismissible: true, target: { accountId: 'b' } },
];

const key = (task: typeof tasks[number]) => `${task.sourceType}:${task.id}`;

test('task quick-filter counts use the same predicate and scheduled is active', () => {
    const summary = summarizeTaskStatuses(tasks);
    assert.equal(summary.active, 3);
    assert.equal(summary.attention, 2);
    assert.equal(summary.completed, 1);
    assert.deepEqual(tasks.filter(taskQuickFilter('active')).map(task => task.status), ['scheduled', 'pending', 'completing']);
});

test('visible, selectable and cleanup snapshots share the same intersected scope', () => {
    const filters = { source: 'web_upload', accountId: 'a', quickFilter: 'attention' as const };
    const visible = scopeTasks(tasks, filters);
    const dismissible = dismissibleTaskSnapshot(tasks, filters);
    assert.deepEqual(visible.map(task => task.id), ['failed-a']);
    assert.deepEqual(dismissible.map(task => task.id), ['failed-a']);
});

test('poll refresh prunes selection to dismissible tasks still inside the current scope', () => {
    const filters = { quickFilter: 'attention' as const };
    const selected = tasks.filter(task => task.dismissible).map(key);
    assert.deepEqual(pruneSelectedTaskKeys(selected, tasks, filters, key), [
        'web_upload:failed-a',
        'web_upload:failed-b',
    ]);
});
