import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zh from '../locales/zh-CN/index';
import en from '../locales/en/index';

const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const card = fs.readFileSync(new URL('../components/ui/FileCard.tsx', import.meta.url), 'utf8');
const preview = fs.readFileSync(new URL('../components/ui/PreviewModal.tsx', import.meta.url), 'utf8');

test('download, share and original-source API failures use the unified response classifier', () => {
    assert.match(api, /apiActionErrorFromResponse/);
    const actionArea = api.slice(api.indexOf('async createShareLink'), api.indexOf('async getAdvancedTaskSettings'));
    assert.ok((actionArea.match(/apiActionErrorFromResponse\(/g) || []).length >= 3);
});

test('file card and preview render actionable classified failure copy', () => {
    assert.match(card, /describeActionFailure\(t\('files\.ui\.preview\.downloadAction'\)/);
    assert.match(preview, /describeActionFailure\(t\('files\.ui\.preview\.downloadAction'\)/);
    assert.match(preview, /describeActionFailure\(t\('files\.ui\.preview\.copyIdAction'\)/);
    assert.match(preview, /describeActionFailure\(t\('files\.ui\.preview\.openOriginalAction'\)/);
    for (const key of ['downloadAction', 'copyIdAction', 'openOriginalAction'] as const) {
        assert.equal(typeof zh.files.ui.preview[key], 'string');
        assert.equal(typeof en.files.ui.preview[key], 'string');
        assert.notEqual(zh.files.ui.preview[key], en.files.ui.preview[key]);
    }
});

test('unauthorized action errors trigger the shared logout path', () => {
    assert.match(card, /error instanceof ApiActionError && error.kind === 'unauthorized'/);
    assert.match(preview, /error instanceof ApiActionError && error.kind === 'unauthorized'/);
    assert.match(card, /authService\.invalidateSession/);
    assert.match(preview, /authService\.invalidateSession/);
});
