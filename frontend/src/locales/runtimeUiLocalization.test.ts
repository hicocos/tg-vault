import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import en from './runtime-en.json' with { type: 'json' };

const sources = ['../components/pages/SettingsPage.tsx', '../components/pages/TasksPage.tsx']
    .map(path => fs.readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');

test('runtime English catalog covers core hard-coded settings and task journeys', () => {
    const required = ['安全设置', '数据维护', 'Telegram Bot 设置', '存储源设置', '任务中心', '全部来源', '全部状态', '没有符合条件的任务', '确认取消任务'];
    for (const text of required) assert.equal(typeof (en as Record<string, string>)[text], 'string', `missing ${text}`);
    assert.match(sources, /任务中心/);
});
