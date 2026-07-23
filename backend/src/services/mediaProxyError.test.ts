import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyMediaProxyError, MediaSourceMissingError } from './mediaProxyError.js';

test('missing cloud sources become a non-retryable 410 response', () => {
    assert.deepEqual(classifyMediaProxyError(new MediaSourceMissingError('trashed')), {
        status: 410,
        code: 'MEDIA_SOURCE_MISSING',
        error: '云盘中的源文件已删除或已移入回收站。',
        reason: 'trashed',
    });
});

test('Google Drive download quota errors become a retryable 429 response', () => {
    assert.deepEqual(classifyMediaProxyError(new Error('reason: downloadQuotaExceeded')), {
        status: 429,
        code: 'MEDIA_QUOTA_EXCEEDED',
        error: '云端文件下载额度已用完，请稍后重试或改用其他存储。',
        retryAfter: 3600,
    });
});

test('provider rate limits become a short retryable 429 response', () => {
    assert.deepEqual(classifyMediaProxyError(new Error('User rate limit exceeded')), {
        status: 429,
        code: 'MEDIA_RATE_LIMITED',
        error: '云端存储请求过于频繁，请稍后重试。',
        retryAfter: 60,
    });
});

test('unknown upstream read failures become 503 without exposing provider internals', () => {
    assert.deepEqual(classifyMediaProxyError(new Error('secret provider response')), {
        status: 503,
        code: 'MEDIA_UPSTREAM_UNAVAILABLE',
        error: '云端媒体暂时无法读取，请稍后重试。',
    });
});
