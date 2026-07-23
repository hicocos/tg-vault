import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudMediaResponse } from './cloudMediaResponse.js';

test('full cloud streams never synthesize content length from stale catalog size', () => {
    assert.deepEqual(buildCloudMediaResponse({
        upstreamStatus: 200,
        upstreamHeaders: {},
        requestedRange: undefined,
    }), {
        status: 200,
        headers: { 'Accept-Ranges': 'bytes' },
    });
});

test('full cloud streams preserve an upstream content length when supplied', () => {
    assert.deepEqual(buildCloudMediaResponse({
        upstreamStatus: 200,
        upstreamHeaders: { 'content-length': '283164' },
        requestedRange: undefined,
    }), {
        status: 200,
        headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '283164' },
    });
});

test('partial cloud streams use the upstream range instead of a catalog-derived range', () => {
    assert.deepEqual(buildCloudMediaResponse({
        upstreamStatus: 206,
        upstreamHeaders: {
            'content-range': 'bytes 1048576-2097151/16387237',
            'content-length': '1048576',
            'accept-ranges': 'bytes',
        },
        requestedRange: 'bytes=1048576-2097151',
    }), {
        status: 206,
        headers: {
            'Accept-Ranges': 'bytes',
            'Content-Range': 'bytes 1048576-2097151/16387237',
            'Content-Length': '1048576',
        },
    });
});

test('an upstream that ignores Range remains 200 and is never mislabeled as partial content', () => {
    assert.deepEqual(buildCloudMediaResponse({
        upstreamStatus: 200,
        upstreamHeaders: { 'content-length': '16387237' },
        requestedRange: 'bytes=1048576-2097151',
    }), {
        status: 200,
        headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '16387237' },
    });
});
