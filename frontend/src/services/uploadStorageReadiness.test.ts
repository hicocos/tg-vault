import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zh from '../locales/zh-CN/index';
import en from '../locales/en/index';

const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const uploadCenter = fs.readFileSync(new URL('../components/pages/UploadCenter.tsx', import.meta.url), 'utf8');
const uploadZone = fs.readFileSync(new URL('../components/ui/UploadZone.tsx', import.meta.url), 'utf8');

test('upload stays disabled until the authoritative storage config is loaded', () => {
    assert.match(uploadCenter, /ready: boolean/);
    assert.match(uploadCenter, /disabled=\{!ready\}/);
    assert.match(uploadZone, /disabled\?: boolean/);
    assert.match(uploadZone, /if \(disabled\) return/);
    assert.match(app, /ready=\{!!storageConfig\}/);
});

test('App refuses enqueueing an upload without an authoritative target', () => {
    assert.match(app, /if \(!storageConfig\) \{[\s\S]*t\('appCopy\.uploadTargetUnavailable'\)/);
    assert.equal(zh.appCopy.uploadTargetUnavailable, '上传目标尚未加载，请稍后重试');
    assert.match(en.appCopy.uploadTargetUnavailable, /upload destination is not ready/i);
});
