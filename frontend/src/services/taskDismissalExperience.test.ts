import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../components/pages/TasksPage.tsx', import.meta.url), 'utf8');

test('task API exposes terminal dismissal preview and confirm contracts', () => {
    assert.match(api, /dismissible: boolean/);
    assert.match(api, /prepareTaskDismissal/);
    assert.match(api, /confirmTaskDismissal/);
    assert.match(api, /dismissals\/prepare/);
    assert.match(api, /dismissals\/confirm/);
});

test('task center supports single, multi-select, and filter-scoped cleanup', () => {
    assert.match(page, /选择任务/);
    assert.match(page, /全选可删除/);
    assert.match(page, /清理终态记录/);
    assert.match(page, /删除记录/);
    assert.match(page, /task\.dismissible/);
    assert.match(page, /不会删除任何文件/);
});

test('mobile task controls use compact filters and avoid duplicate stage labels', () => {
    assert.match(page, /grid-cols-2/);
    assert.match(page, /STAGE_LABELS\[task\.stage\].*STATUS_LABELS\[task\.status\]/s);
});
