import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const apiTypes = fs.readFileSync(new URL('./apiTypes.ts', import.meta.url), 'utf8');
const tasksClient = fs.readFileSync(new URL('./clients/tasksClient.ts', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../components/pages/TasksPage.tsx', import.meta.url), 'utf8');
const zh = fs.readFileSync(new URL('../locales/zh.json', import.meta.url), 'utf8');

test('task API exposes terminal dismissal preview and confirm contracts', () => {
    assert.match(apiTypes, /dismissible: boolean/);
    assert.match(api, /prepareTaskDismissal/);
    assert.match(api, /confirmTaskDismissal/);
    assert.match(tasksClient, /dismissals\/prepare/);
    assert.match(tasksClient, /dismissals\/confirm/);
});

test('task center supports single, multi-select, and filter-scoped cleanup', () => {
    for (const key of ['tasks.selection.enter', 'tasks.selection.selectAll', 'tasks.actions.cleanTerminal', 'tasks.actions.deleteRecord', 'tasks.dialogs.dismissDescription']) {
        assert.ok(page.includes(key), key);
    }
    for (const copy of ['选择任务', '全选可删除', '清理终态记录', '删除记录', '不会删除任何文件']) {
        assert.match(zh, new RegExp(copy));
    }
    assert.match(page, /task\.dismissible/);
});

test('mobile task controls use compact filters and avoid duplicate stage labels', () => {
    assert.match(page, /grid-cols-2/);
    assert.match(page, /STAGE_LABELS\[task\.stage\].*STATUS_LABELS\[task\.status\]/s);
});
