import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./security.ts', import.meta.url), 'utf8');
assert.match(source, /export async function get2FAReadiness/);
assert.match(source, /enabled.*unreadable|unreadable.*enabled/s);
const verifyBody = source.slice(source.indexOf('export async function verifyTOTP'), source.indexOf('/**', source.indexOf('export async function verifyTOTP') + 1));
assert.doesNotMatch(verifyBody, /if \(!secret\) return true/);
assert.match(verifyBody, /enabled !== 'true'/);
console.log('TOTP security fails closed ok');
