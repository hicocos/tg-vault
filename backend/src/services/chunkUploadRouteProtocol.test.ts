import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const route = fs.readFileSync(new URL('../routes/chunkedUpload.ts', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

test('chunk routes use the durable owner-scoped session protocol', () => {
    assert.match(route, /PostgresChunkUploadSessionRepository/);
    assert.match(route, /getAuthToken/);
    assert.match(route, /createHash\('sha256'\)/);
    assert.match(route, /chunkStore\.reserve/);
    assert.match(route, /chunkStore\.writeChunk/);
    assert.match(route, /chunkStore\.claimCompletion/);
    assert.match(route, /chunkStore\.renewCompletion/);
    assert.match(route, /deleteExpiredSessions/);
    assert.match(route, /清理过期分块目录失败/);
    assert.match(route, /clearInterval\(completionHeartbeat\)/);
    assert.match(route, /chunkStore\.failCompletion/);
    assert.match(route, /chunkStore\.completeWithReconciliation/);
    assert.match(route, /beginChunkCompletionReconciliation/);
    assert.match(route, /markChunkReconciliationObjectPresent/);
    assert.match(route, /markChunkReconciliationIndexPresent/);
    assert.match(route, /compensateChunkCompletionFailure/);
    assert.match(route, /updateChunkReconciliationAfterCompensation\(pool, operationId, evidence\)/);
    assert.match(route, /provider 保存结果不确定/);
    assert.match(route, /objectState: 'unknown', indexState: 'deleted'/);
    assert.match(route, /chunkStore\.cancel/);
    assert.doesNotMatch(route, /const uploadSessions = new Map/);
});

test('chunk init negotiates the server maximum chunk size and authoritative count', () => {
    assert.match(route, /const chunks = Math\.ceil\(bytes \/ MAX_CHUNK_BYTES\)/);
    assert.match(route, /maxChunkBytes: MAX_CHUNK_BYTES/);
    assert.match(route, /totalChunks: chunks/);
});

test('chunk init freezes an explicit queue target instead of silently using the active account', () => {
    assert.match(route, /lockStorageTargetForUse/);
    assert.match(route, /storageManager\.getTarget\(selected\.provider, selected\.accountId\)/);
    assert.match(route, /targetProvider: target\.provider\.name/);
    assert.match(route, /targetAccountId: target\.accountId/);
});

test('chunk ownership uses the stable single-admin principal instead of a bearer session', () => {
    assert.match(route, /stableWebAdminPrincipalId/);
    assert.doesNotMatch(route, /createHash\('sha256'\)\.update\(token\)/);
});

test('schema persists session target, lifecycle lease and idempotent chunk metadata', () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS chunk_upload_sessions/);
    assert.match(schema, /owner_id VARCHAR\(64\) NOT NULL/);
    assert.match(schema, /target_provider VARCHAR\(50\) NOT NULL/);
    assert.match(schema, /status VARCHAR\(20\).*open.*completing.*completed.*cancelled.*failed/s);
    assert.match(schema, /completion_token UUID/);
    assert.match(schema, /ALTER TABLE chunk_upload_sessions ADD COLUMN IF NOT EXISTS completion_expires_at TIMESTAMPTZ/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS chunk_upload_chunks/);
    assert.match(schema, /PRIMARY KEY \(upload_id, chunk_index\)/);
    assert.match(schema, /sha256 VARCHAR\(64\) NOT NULL/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS chunk_upload_reconciliations/);
    assert.match(schema, /operation_id UUID PRIMARY KEY/);
    assert.match(schema, /object_state VARCHAR\(20\)/);
    assert.match(schema, /index_state VARCHAR\(20\)/);
    assert.match(schema, /FOREIGN KEY \(upload_id\) REFERENCES chunk_upload_sessions\(upload_id\) ON DELETE CASCADE/);
});
