import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./files.ts', import.meta.url), 'utf8');
const helperStart = source.indexOf('async function serveCloudMediaStream');
const helperEnd = source.indexOf('function parseRangeHeader', helperStart);
const helper = source.slice(helperStart, helperEnd);

test('cloud media forwards Range and uses upstream response headers', () => {
    assert.match(helper, /provider\.getFileStream\(storedPath, range \? \{ range \} : undefined\)/);
    assert.match(helper, /buildCloudMediaResponse\(\{/);
    assert.match(helper, /upstreamHeaders: stream\.upstreamHeaders/);
    assert.doesNotMatch(helper, /file\.size|Content-Range.*size|Content-Length.*size/);
});

test('cloud preview and original routes share the same streaming helper', () => {
    const previewStart = source.indexOf("router.get('/:id([0-9a-fA-F-]{36})/preview'");
    const originalStart = source.indexOf("router.get('/:id([0-9a-fA-F-]{36})/original'");
    const previewRoute = source.slice(previewStart, originalStart);
    const originalRoute = source.slice(originalStart);
    assert.match(previewRoute, /serveCloudMediaStream\(/);
    assert.match(originalRoute, /serveCloudMediaStream\(/);
    assert.match(originalRoute, /classifyMediaProxyError/);
    assert.match(originalRoute, /Retry-After/);
});
