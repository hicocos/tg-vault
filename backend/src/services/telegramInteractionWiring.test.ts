import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const bot = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');

test('Telegram channel wizards use chat-bound expiring interaction state', () => {
    assert.match(bot, /new TelegramInteractionStore<TelegramWizardState>/);
    assert.match(bot, /messageChatKey\(message, senderId\)/);
    assert.match(bot, /telegramWizardStates\.lookup\(senderId, chatKey\)/);
    assert.match(bot, /telegramWizardStates\.delete\(senderId, chatKey\)/);
    assert.doesNotMatch(bot, /new Map<number, TelegramWizardState>/);
});

test('wizard callbacks bind actor, chat, origin message and action and fail closed after restart', () => {
    assert.match(bot, /callbackChatKey\(update, userId\)/);
    assert.match(bot, /messageId: Number\(update\.msgId\)/);
    assert.match(bot, /allowedActions: \['cancel', 'mode_date', 'mode_tag', 'comments_on', 'comments_off'\]/);
    assert.match(bot, /bot\.wizard\.callbackExpired/);
});

test('wizard interactions expose cancellation, restart replacement, expiry and bounded capacity', () => {
    assert.match(bot, /TELEGRAM_INTERACTION_TTL_MS/);
    assert.match(bot, /TELEGRAM_INTERACTION_MAX_ENTRIES/);
    assert.match(bot, /putTelegramWizardState\(senderId, chatKey, state/);
    assert.match(bot, /bot\.wizard\.expired/);
    assert.match(bot, /bot\.wizard\.cancelled/);
});
