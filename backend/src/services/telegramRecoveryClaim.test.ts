import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const recoveryBody = source.slice(
    source.indexOf('async function recoverTelegramJob'),
    source.indexOf('export async function repairTelegramJobInvariantsWithQuery'),
);
assert.match(recoveryBody, /downloadPendingForJob\(/);
assert.doesNotMatch(recoveryBody, /downloadTelegramChannelRange\(/);

const workerBody = source.slice(
    source.indexOf('export async function recoverInterruptedTelegramJobs'),
    source.indexOf('export function startTelegramJobRecoveryWorker'),
);
assert.match(workerBody, /WHERE status = 'downloading'[\s\S]*lease_expires_at IS NULL OR lease_expires_at < NOW\(\)/);
assert.match(source, /lease_token = gen_random_uuid\(\)/);
assert.match(source, /startClaimHeartbeat\(jobId, refs\)/);
assert.match(workerBody, /AND EXISTS \([\s\S]*j\.cancelled_at IS NULL[\s\S]*j\.paused_at IS NULL/);
assert.doesNotMatch(workerBody, /AND NOT EXISTS \([\s\S]*j\.status = 'running'/);

const invariantBody = source.slice(
    source.indexOf('export async function repairTelegramJobInvariantsWithQuery'),
    source.indexOf('export async function recoverInterruptedTelegramJobs'),
);
assert.match(invariantBody, /HAVING[\s\S]*COUNT\(\*\) FILTER \(WHERE i\.status = 'pending'/);
assert.doesNotMatch(invariantBody, /COUNT\(\*\) FILTER \(WHERE i\.status IN \('pending', 'downloading'\)\) > 0/);

console.log('telegram recovery claims and stale leases ok');
