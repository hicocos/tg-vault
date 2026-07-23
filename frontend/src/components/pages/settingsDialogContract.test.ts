import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');

test('settings uses product dialogs instead of browser alert, confirm, or prompt', () => {
    assert.doesNotMatch(source, /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
    assert.match(source, /ActionDialog/);
});
