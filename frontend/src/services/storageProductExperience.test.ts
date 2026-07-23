import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const toolbar = fs.readFileSync(new URL('../components/ui/BulkActionToolbar.tsx', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8');

test('share UI is driven by backend capabilities and hides unsupported fields', () => {
    assert.match(app, /shareCapabilities=\{storageConfig\?\.capabilities\}/);
    assert.match(toolbar, /shareCapabilities\?\.share === true/);
    assert.match(toolbar, /shareCapabilities\?\.shareExpiration/);
    assert.match(toolbar, /shareCapabilities\?\.sharePassword/);
});

test('storage account deletion previews impact before execution', () => {
    assert.match(api, /previewAccountDeletion/);
    assert.match(settings, /impact\.fileCount/);
    assert.match(settings, /impact\.folderCount/);
    assert.match(settings, /activeLeaseCount/);
    assert.match(settings, /不会删除云端原文件/);
});
