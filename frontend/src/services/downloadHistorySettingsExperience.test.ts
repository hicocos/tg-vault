import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

test('Web exposes an immediate download history policy with errors-only as the recommended default', () => {
    assert.match(api, /telegramDownloadHistoryPolicy/);
    assert.match(settings, /settings\.cards\.maintenance\.history\.title/);
    assert.match(settings, /settings\.cards\.maintenance\.history\.errorsOnly/);
    assert.match(settings, /settings\.cards\.maintenance\.history\.all/);
    assert.match(settings, /value="errors_only"/);
    assert.match(settings, /value="all"/);
    assert.match(settings, /settings\.cards\.maintenance\.history\.description/);
    assert.match(settings, /stackActionOnMobile/);
    assert.match(settings, /w-full sm:w-auto/);
});

test('history cleanup remains available and clearly says it only deletes audit details', () => {
    assert.match(settings, /settings\.cards\.maintenance\.cleanupHistory\.title/);
    assert.match(settings, /settings\.cards\.maintenance\.cleanupHistory\.description/);
});
