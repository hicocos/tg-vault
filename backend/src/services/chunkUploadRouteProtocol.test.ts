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
    assert.match(route, /chunkStore\.failCompletion/);
    assert.match(route, /chunkStore\.complete/);
    assert.match(route, /chunkStore\.cancel/);
    assert.doesNotMatch(route, /const uploadSessions = new Map/);
});

test('schema persists session target, lifecycle lease and idempotent chunk metadata', () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS chunk_upload_sessions/);
    assert.match(schema, /owner_id VARCHAR\(64\) NOT NULL/);
    assert.match(schema, /target_provider VARCHAR\(50\) NOT NULL/);
    assert.match(schema, /status VARCHAR\(20\).*open.*completing.*completed.*cancelled.*failed/s);
    assert.match(schema, /completion_token UUID/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS chunk_upload_chunks/);
    assert.match(schema, /PRIMARY KEY \(upload_id, chunk_index\)/);
    assert.match(schema, /sha256 VARCHAR\(64\) NOT NULL/);
});
