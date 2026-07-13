import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ensureJobCanRunForTest } from './telegramChannelJobs.js';

const jobs = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const upload = fs.readFileSync(new URL('./telegramUpload.ts', import.meta.url), 'utf8');
const commands = fs.readFileSync(new URL('./telegramCommands.ts', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');

assert.match(jobs, /FOR UPDATE OF i SKIP LOCKED/);
assert.match(jobs, /i\.status = 'pending'/);
assert.match(jobs, /j\.cancelled_at IS NULL/);
assert.match(jobs, /restoreClaimedRefs/);
assert.match(jobs, /ensureJobCanRun\(jobId\)/);
assert.match(upload, /waitForDiskWatermark\(totalSize \|\| 0, signal\)/);
assert.match(upload, /signal\?\.addEventListener/);
assert.match(upload, /getExecutionControlState/);
assert.match(commands, /forceStopDownloadTasksForScope/);
assert.match(commands, /旧版取消按钮已失效，请使用新版 \/tasks/);
assert.match(commands, /pendingTaskCenterCancels/);
assert.match(commands, /taskCenterCardOwners/);
assert.match(commands, /refreshSilentProgress\(client, update\.peer, userId,/);
assert.match(jobs, /status = 'cooling'/);
assert.match(jobs, /restoreUnfinishedClaimedRefs\(jobId, refs/);
assert.match(jobs, /paused_at IS NULL AND status NOT IN \('cancelled', 'paused', 'cooling'\)/);
assert.match(jobs, /j\.kind IN \('date_range', 'tag_download', 'subscription_sync'\)/);
assert.match(commands, /if \(executionGroup\) pauseChannelExecutionGroup\(fullId\)/);
assert.match(bot, /下载任务已取消/);
assert.match(bot, /slice\(0, 12\)/);

assert.match(bot, /callbackChatId !== canonicalControlChatId/);
assert.match(upload, /进入静默模式缺少任务所有者/);
assert.match(upload, /scope\.userId !== userId/);
assert.match(upload, /ownerUserId \?\? requestMessage\.senderId/);
assert.match(jobs, /downloadPendingForJob\([\s\S]*String\(job\.id\)/);
assert.doesNotMatch(jobs, /reconcileTelegramDownloadItemsWithFilesQuery/);

const now = Date.parse('2026-07-11T00:00:00.000Z');
assert.equal(await ensureJobCanRunForTest({ status: 'cooling', cooldown_until: '2026-07-11T00:01:00.000Z' }, now), 'cooldown');
assert.equal(await ensureJobCanRunForTest({ status: 'cooling', cooldown_until: '2026-07-10T23:59:00.000Z' }, now), 'run');
assert.equal(await ensureJobCanRunForTest({ status: 'paused', paused_at: '2026-07-10T23:00:00.000Z' }, now), 'paused');
assert.equal(await ensureJobCanRunForTest({ status: 'cancelled', cancelled_at: '2026-07-10T23:00:00.000Z' }, now), 'cancelled');

console.log('telegram task safety regression markers ok');
