import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const bot = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
const upload = fs.readFileSync(new URL('./telegramUpload.ts', import.meta.url), 'utf8');
const jobs = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const lifecycle = fs.readFileSync(new URL('./storageAccountLifecycle.ts', import.meta.url), 'utf8');

test('ordinary files, albums and channel jobs resolve chat target at admission', () => {
    assert.match(upload, /consumeOrGetTelegramTargetState\(chatKey\)/);
    assert.match(upload, /consumeOrGetTelegramTargetState\(chatIdStr\)/);
    assert.match(bot, /consumeOrGetTelegramTargetState\(chatKey\)/);
    assert.match(jobs, /target\?: StorageTargetSnapshot/);
});

test('chat target state is durable, account-bound and deletion-safe', () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS telegram_target_states/);
    assert.match(schema, /account_id UUID REFERENCES storage_accounts\(id\) ON DELETE RESTRICT/);
    assert.match(lifecycle, /SELECT chat_id FROM telegram_target_states/);
});

test('/target supports next, session, clear and never switches global active account', () => {
    assert.match(bot, /text === '\/target'/);
    assert.match(bot, /handleTarget\(message/);
    const commands = fs.readFileSync(new URL('./telegramCommands.ts', import.meta.url), 'utf8');
    assert.match(commands, /setTelegramTargetState/);
    assert.match(commands, /clearTelegramTargetState/);
    assert.doesNotMatch(commands.match(/export async function handleTarget[\s\S]*?\n}\n/)?.[0] || '', /switchAccount/);
});
