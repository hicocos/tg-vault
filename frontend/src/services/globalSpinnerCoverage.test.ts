import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

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
    assert.match(combined, /label="正在验证登录状态"/);
    assert.match(combined, /label="正在加载任务"/);
    assert.match(combined, /label="正在加载预览"/);
    assert.match(combined, /label="正在处理上传"/);
});
