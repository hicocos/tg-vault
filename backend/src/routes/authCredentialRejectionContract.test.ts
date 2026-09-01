import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const authRoute = fs.readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');

test('a wrong current password is forbidden without invalidating an authenticated session', () => {
    assert.match(
        authRoute,
        /message === '当前密码不正确'\) return res\.status\(403\)/,
        'credential confirmation failure must be 403; 401 makes the frontend treat a still-valid session as expired',
    );
});
