import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiActionError, apiActionErrorFromResponse, describeActionFailure, formatRetryAfter } from './apiActionError.js';
const response = (status: number, headers: Record<string,string> = {}, body: Record<string,unknown> = {}) => new Response(JSON.stringify(body), { status, headers });

test('401 expires session with actionable sign-in copy', async () => {
    const error = await apiActionErrorFromResponse(response(401), '下载失败');
    assert.equal(error.kind, 'unauthorized');
    assert.equal(describeActionFailure('下载', error), '登录会话已失效，请重新登录后下载');
});
test('429 parses Retry-After', async () => {
    const error = await apiActionErrorFromResponse(response(429, { 'Retry-After': '90' }), '分享失败');
    assert.equal(error.retryAfterSeconds, 90);
    assert.equal(formatRetryAfter(90), '1 分 30 秒');
});
test('410 and 503 provide source/request guidance', async () => {
    const gone = await apiActionErrorFromResponse(response(410), '打开失败');
    assert.equal(gone.kind, 'source_deleted');
    const unavailable = await apiActionErrorFromResponse(response(503, { 'X-Request-Id': 'req-a' }), '下载失败');
    assert.equal(unavailable.message, '服务暂时不可用，请稍后重试（请求 ID：req-a）');
    assert.ok(unavailable instanceof ApiActionError);
});

test('502 HTML gateway errors expose a status-specific unavailable message', async () => {
    const error = await apiActionErrorFromResponse(new Response('<html>Bad Gateway</html>', { status: 502 }), '网络错误');
    assert.equal(error.kind, 'unavailable');
    assert.equal(error.message, '服务暂时不可用（HTTP 502），请稍后重试');
});
