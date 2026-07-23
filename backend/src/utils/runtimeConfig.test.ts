import assert from 'node:assert/strict';
import { validateRuntimeConfig } from './runtimeConfig.js';

function testDefaultsMatchRuntimeContract() {
    const summary = validateRuntimeConfig({});
    assert.equal(summary.upload.chunkMiB, 32);
    assert.equal(summary.upload.maxUploadGiB, 20);
    assert.equal(summary.telegram.enabled, false);
    assert.equal(summary.ytdlp.maxConcurrent, 1);
}

function testRejectsUnsafeRangesAndPartialTelegramConfig() {
    assert.throws(
        () => validateRuntimeConfig({ MAX_UPLOAD_CHUNK_MB: '0' }),
        /MAX_UPLOAD_CHUNK_MB/,
    );
    assert.throws(
        () => validateRuntimeConfig({ MAX_CHUNK_UPLOAD_GB: '50', CHUNK_GLOBAL_BUDGET_GB: '40' }),
        /CHUNK_GLOBAL_BUDGET_GB/,
    );
    assert.throws(
        () => validateRuntimeConfig({ TELEGRAM_BOT_TOKEN: 'token-only' }),
        /必须同时配置/,
    );
}

function testSummaryDoesNotExposeSecretsOrAllowedUserIds() {
    const secret = 'do-not-print-this-secret-value';
    const summary = validateRuntimeConfig({
        SESSION_SECRET: secret,
        STORAGE_CREDENTIALS_SECRET: `${secret}-storage`,
        TELEGRAM_BOT_TOKEN: `${secret}-bot`,
        TELEGRAM_API_ID: '12345',
        TELEGRAM_API_HASH: `${secret}-hash`,
        TELEGRAM_ALLOWED_USER_IDS: '10001,10002',
    });
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('10001'), false);
    assert.equal(summary.telegram.allowedUserCount, 2);
    assert.equal(summary.security.sessionSecretSource, 'environment');
}

testDefaultsMatchRuntimeContract();
testRejectsUnsafeRangesAndPartialTelegramConfig();
testSummaryDoesNotExposeSecretsOrAllowedUserIds();
console.log('runtime config ok');

