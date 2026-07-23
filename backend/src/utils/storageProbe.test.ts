import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeStorageProbeFailure } from './storageProbe.js';

test('storage probe failures classify common provider errors', () => {
    assert.equal(summarizeStorageProbeFailure({ response: { status: 401 }, message: 'request failed' }).reason, '凭据无效或已过期');
    assert.equal(summarizeStorageProbeFailure({ code: 'ENOTFOUND', message: 'lookup failed' }).reason, '端点无法连接或 DNS 解析失败');
    assert.equal(summarizeStorageProbeFailure({ name: 'TimeoutError', message: 'timed out' }).reason, '连接测试超时');
});

test('storage probe summaries never expose raw provider diagnostics', () => {
    const secret = 'super-secret-value';
    const summary = summarizeStorageProbeFailure({
        name: 'ProviderFailure',
        message: `request to https://admin:${secret}@private.example failed, password=${secret}, token=${secret}`,
    });
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('private.example'), false);
    assert.deepEqual(summary, { reason: '连接测试返回错误 ProviderFailure', code: 'ProviderFailure' });
});
