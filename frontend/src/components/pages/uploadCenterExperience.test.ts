import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const layout = fs.readFileSync(new URL('../layout/AppLayout.tsx', import.meta.url), 'utf8');
const uploadCenter = fs.readFileSync(new URL('./UploadCenter.tsx', import.meta.url), 'utf8');

test('upload center is the first navigation destination and owns the upload experience', () => {
    assert.match(layout, /id: "upload"[\s\S]*label: t\("sidebar\.uploadCenter"\)/);
    assert.ok(layout.indexOf('id: "upload"') < layout.indexOf('id: "all"'));
    assert.match(app, /currentCategory === "upload"[\s\S]*<UploadCenter/);
    assert.match(uploadCenter, /<UploadZone/);
});

test('upload center puts the upload action before secondary information and destination controls', () => {
    const uploadZoneIndex = uploadCenter.indexOf('<UploadZone');
    assert.ok(uploadZoneIndex > -1);
    assert.ok(uploadZoneIndex < uploadCenter.indexOf('data-testid="upload-destination"'));
    assert.ok(uploadZoneIndex < uploadCenter.indexOf('data-testid="upload-queue-summary"'));
});

test('upload center heading is at the top without a redundant home label', () => {
    assert.ok(uploadCenter.indexOf('id="upload-center-title"') < uploadCenter.indexOf('<UploadZone'));
    assert.doesNotMatch(uploadCenter, />\s*首页\s*</);
});

test('special file menus use context-specific headings and descriptions', () => {
    assert.match(app, /currentCategory === "favorites"[\s\S]*t\("sidebar\.favorites"\)/);
    assert.match(app, /t\("app\.favoritesSubtitle"\)/);
});

test('upload center exposes destination, queue status, and resumable upload guidance', () => {
    assert.match(uploadCenter, /data-testid="upload-destination"/);
    assert.match(uploadCenter, /data-testid="upload-queue-summary"/);
    assert.match(uploadCenter, /management\.upload\.reliable\.resumable/);
    assert.match(uploadCenter, /management\.upload\.chunkThreshold/);
});

test('my files is a file-only workspace labeled as all files', () => {
    assert.match(app, /currentCategory === "upload"/);
    assert.match(app, /t\("app\.allFiles"\)/);
    assert.doesNotMatch(app, /<UploadZone/);
    assert.doesNotMatch(app, /t\("app\.recent"\)/);
});
