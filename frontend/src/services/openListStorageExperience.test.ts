import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8');
const apiTypes = fs.readFileSync(new URL('../services/apiTypes.ts', import.meta.url), 'utf8');
const bulk = fs.readFileSync(new URL('../components/ui/BulkActionToolbar.tsx', import.meta.url), 'utf8');

test('settings exposes only a minimal native OpenList connection form', () => {
    assert.match(settings, /settings\.openlist\.title/);
    assert.match(settings, /openlistBaseUrl/);
    assert.match(settings, /openlistRootPath/);
    assert.match(settings, /openlistUsername/);
    assert.match(settings, /openlistPassword/);
    assert.match(api, /addOpenListAccount/);
    assert.match(app, /openlist: 'OpenList'/);
    assert.doesNotMatch(settings, /OpenList 远端搜索|OpenList 离线下载|OpenList 分享管理|OpenList 挂载管理/);
});

test('OpenList user deletion is hidden in file and bulk actions while backend capability remains authoritative', () => {
    assert.match(apiTypes, /userDelete: boolean/);
    assert.match(app, /storageConfig\?\.capabilities\.userDelete/);
    assert.match(app, /onDelete=\{storageConfig/);
    assert.match(bulk, /canDelete/);
});
