import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canTelegramUserAuthenticate } from './telegramBot.js';

assert.equal(canTelegramUserAuthenticate(7, []), false);
assert.equal(canTelegramUserAuthenticate(7, [7]), true);
assert.equal(canTelegramUserAuthenticate(8, [7]), false);

const source = fs.readFileSync(new URL('./telegramBot.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /Received text from.*\$\{text\}/);
assert.doesNotMatch(source, /command received.*\$\{text\}/);

console.log('telegram authentication allowlist ok');
