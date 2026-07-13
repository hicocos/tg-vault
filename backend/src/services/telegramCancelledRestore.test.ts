import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseUnfinishedClaimStatus } from './telegramChannelJobs.js';

test('cancel terminalizes only still-downloading claims as skipped', () => {
    assert.equal(chooseUnfinishedClaimStatus('cancelled'), 'skipped');
});

test('pause and cooldown restore unfinished claims to pending', () => {
    assert.equal(chooseUnfinishedClaimStatus('paused'), 'pending');
    assert.equal(chooseUnfinishedClaimStatus('cooldown'), 'pending');
});
