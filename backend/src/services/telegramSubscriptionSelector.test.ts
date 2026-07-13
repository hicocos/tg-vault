import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./telegramChannelJobs.ts', import.meta.url), 'utf8');
const updateFolder = source.slice(source.indexOf('export async function updateTelegramSubscriptionFolder'), source.indexOf('export async function unsubscribeTelegramChannel'));
const unsubscribe = source.slice(source.indexOf('export async function unsubscribeTelegramChannel'), source.indexOf('async function pauseTelegramSubscriptionForError'));
assert.match(updateFolder, /resolveUniqueTelegramSubscriptionId/);
assert.doesNotMatch(updateFolder, /UPDATE telegram_channel_subscriptions[\s\S]*id::text LIKE/);
assert.match(unsubscribe, /resolveUniqueTelegramSubscriptionId/);
assert.doesNotMatch(unsubscribe, /UPDATE telegram_channel_subscriptions[\s\S]*id::text LIKE/);
console.log('telegram subscription prefix mutation fails closed ok');
