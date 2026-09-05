import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import zh from '../locales/zh-CN/index';
import en from '../locales/en/index';

const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const toolbar = fs.readFileSync(new URL('../components/ui/BulkActionToolbar.tsx', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8');
const apiTypes = fs.readFileSync(new URL('../services/apiTypes.ts', import.meta.url), 'utf8');

test('share UI is driven by backend capabilities and hides unsupported fields', () => {
    assert.match(app, /shareCapabilities=\{storageConfig\?\.capabilities\}/);
    assert.match(toolbar, /shareCapabilities\?\.share === true/);
    assert.match(toolbar, /shareCapabilities\?\.shareExpiration/);
    assert.match(toolbar, /shareCapabilities\?\.sharePassword/);
});

test('storage account deletion previews every server-side task reference and opens the filtered task center when blocked', () => {
    assert.match(api, /previewAccountDeletion/);
    assert.match(apiTypes, /expiresAt: number/);
    assert.match(api, /delete-confirmation/);
    assert.match(settings, /impact\.fileCount/);
    assert.match(settings, /impact\.folderCount/);
    assert.match(settings, /activeLeaseCount/);
    assert.match(settings, /settings\.remaining\.copy\.221/);
    assert.match(settings, /onOpenTasksForAccount\?\.\(accountId\)/);
    assert.match(settings, /settings\.remaining\.copy\.223/);
});

test('cloud storage account creation cannot leave the settings form saving forever', () => {
    assert.match(api, /setTimeout\(\(\) => controller\.abort\(\), 65_000\)/);
    assert.match(api, /tr\('errors\.services\.storage\.connectionTimeout', \{ provider: providerLabel \}\)/);
    assert.match(zh.errors.services.storage.connectionTimeout, /连接测试超时/);
    assert.match(en.errors.services.storage.connectionTimeout, /connection test timed out/i);
    assert.match(api, /postStorageAccount\('\/api\/storage\/config\/aliyun-oss'/);
    assert.match(api, /postStorageAccount\('\/api\/storage\/config\/s3'/);
    assert.match(api, /postStorageAccount\('\/api\/storage\/config\/webdav'/);
});
