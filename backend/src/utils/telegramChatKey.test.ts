import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalTelegramChatKey, telegramChatKeyFromPeerParts } from './telegramChatKey.js';

test('canonical Telegram chat keys preserve Bot API marks', () => {
    assert.equal(canonicalTelegramChatKey(' 12345 '), '12345');
    assert.equal(canonicalTelegramChatKey('-67890'), '-67890');
    assert.equal(canonicalTelegramChatKey('-1001234567890'), '-1001234567890');
});

test('callback fallback marks raw group and channel peer IDs', () => {
    assert.equal(telegramChatKeyFromPeerParts({ userId: 12345 }), '12345');
    assert.equal(telegramChatKeyFromPeerParts({ chatId: 67890 }), '-67890');
    assert.equal(telegramChatKeyFromPeerParts({ channelId: 1234567890 }), '-1001234567890');
    assert.equal(telegramChatKeyFromPeerParts({ channelId: '-1001234567890' }), '-1001234567890');
});
