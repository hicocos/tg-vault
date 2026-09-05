import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zh from '../locales/zh-CN/index';
import en from '../locales/en/index';

const files = [
    '../App.tsx',
    '../components/pages/LoginPage.tsx',
    '../components/pages/SettingsPage.tsx',
    '../components/pages/TasksPage.tsx',
    '../components/ui/BulkActionToolbar.tsx',
    '../components/ui/Notification.tsx',
    '../components/ui/PreviewModal.tsx',
    '../components/ui/UploadQueueModal.tsx',
    '../components/ui/UploadZone.tsx',
];

test('all known unknown-duration loading surfaces use the shared spinner', () => {
    for (const relative of files) {
        const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
        assert.match(source, /IndeterminateSpinner/, relative);
        assert.doesNotMatch(source, /animate-spin/, relative);
    }
});

test('loading spinners supply contextual accessible labels', () => {
    const combined = files.map(relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')).join('\n');
    assert.match(combined, /label=\{t\('auth\.signingIn'\)\}/);
    assert.match(combined, /label=\{t\('tasks\.loading\.initial'\)\}/);
    assert.match(combined, /label=\{t\('files\.ui\.preview\.loadingPreview'\)\}/);
    assert.match(combined, /label=\{t\('files\.ui\.uploadZone\.processing'\)\}/);
    assert.equal(zh.auth.signingIn, '正在登录…');
    assert.equal(en.auth.signingIn, 'Signing in…');
    assert.equal(zh.files.ui.preview.loadingPreview, '正在加载预览');
    assert.equal(en.files.ui.preview.loadingPreview, 'Loading preview');
    assert.equal(zh.files.ui.uploadZone.processing, '正在处理上传');
    assert.equal(en.files.ui.uploadZone.processing, 'Processing upload');
});
