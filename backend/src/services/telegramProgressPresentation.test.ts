import assert from 'node:assert/strict';
import { buildLegacyJobProgressPresentation } from './telegramBot.js';

const flood = buildLegacyJobProgressPresentation({
    jobId: '1234567890abcdef', status: 'cooling', downloadStatus: 'cooling', cooldownUntil: '2026-07-13T10:00:00Z', error: 'Telegram FloodWait 60s',
} as any);
assert.match(flood, /Telegram FloodWait/);
assert.doesNotMatch(flood, /Google Drive/);
assert.doesNotMatch(flood, /task_resume/);

const paused = buildLegacyJobProgressPresentation({ jobId: '1234567890abcdef', status: 'paused', downloadStatus: 'paused' } as any);
assert.match(paused, /task_resume/);
console.log('legacy job progress presentation truth ok');
