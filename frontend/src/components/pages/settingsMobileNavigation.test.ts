import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');

test('mobile settings tabs stay viewport-bound and scroll horizontally', () => {
    assert.match(source, /data-testid="settings-page"[^>]*className="[^"]*w-full[^"]*min-w-0[^"]*"/);
    assert.match(source, /data-testid="settings-tabs"[^>]*className="[^"]*w-full[^"]*max-w-full[^"]*overflow-x-auto[^"]*touch-pan-x[^"]*"/);
});
