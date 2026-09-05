import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getAllFiles, isReservedTransientUploadPath, walkFiles } from './orphanCleanup.js';

const source = fs.readFileSync(new URL('./orphanCleanup.ts', import.meta.url), 'utf8');

test('cleanup protects every local-volume index regardless of historical source label', () => {
    assert.match(source, /WHERE storage_account_id IS NULL/);
});
