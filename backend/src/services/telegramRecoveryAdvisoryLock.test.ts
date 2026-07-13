import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const recoveryBody = source.slice(
    source.indexOf('export async function recoverInterruptedTelegramJobs'),
    source.indexOf('export function startTelegramJobRecoveryWorker'),
);
assert.match(recoveryBody, /pool\.connect\(\)/, 'recovery must hold a dedicated DB connection');
assert.match(recoveryBody, /pg_try_advisory_lock/);
assert.match(recoveryBody, /tg-vault:telegram-job-recovery/);
assert.match(recoveryBody, /pg_advisory_unlock/);
assert.match(recoveryBody, /client\?\.release\(\)/);
console.log('telegram recovery advisory lock ok');
