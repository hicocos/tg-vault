import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const bot = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
const jobs = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');

test('date and tag wizards require a final scope and target confirmation', () => {
    assert.match(bot, /step === 'confirm'/);
    assert.match(bot, /t\(locale, 'bot\.wizard\.confirmTitle'\)/);
    assert.match(bot, /t\(locale, 'bot\.wizard\.confirmStorage'/);
    assert.match(bot, /t\(locale, 'bot\.wizard\.confirmNote'/);
    assert.match(bot, /state\.dayCount/);
    assert.match(bot, /t\(locale, 'bot\.wizard\.confirmLargeRange'/);
    assert.match(bot, /parseTelegramDateRange\(state\.startDate!, input\)/);
    assert.match(bot, /t\(locale, 'bot\.wizard\.confirmInput'\)/);
});

test('confirmed channel jobs pass an immutable target snapshot to admission', () => {
    assert.match(bot, /state\.target = target/);
    assert.match(bot, /target: state\.target/);
    assert.match(jobs, /resolveChannelJobTargetSnapshot\(options\.target/);
    assert.match(jobs, /target,/);
    assert.doesNotMatch(jobs, /storageProvider: options\.targetProvider/);
    assert.doesNotMatch(jobs, /storageAccountId: options\.targetAccountId/);
});
