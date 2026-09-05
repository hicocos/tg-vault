import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

test('security settings expose an off-by-default unsafe WebDAV control with explicit risk confirmation', () => {
    assert.match(api, /allowUnsafeWebdavEndpoints/);
    assert.match(api, /setUnsafeWebdavEndpointsAllowed/);
    assert.match(settings, /settings\.security\.networkTitle/);
    assert.match(settings, /settings\.cards\.security\.unsafeWebdav\.title/);
    assert.match(settings, /role="switch"/);
    assert.match(settings, /aria-checked=\{!!config\?\.allowUnsafeWebdavEndpoints\}/);
    assert.match(settings, /CONFIRMATION_REQUIRED/);
    assert.match(settings, /settings\.cards\.security\.unsafeWebdav\.confirmation/);
    assert.match(settings, /settings\.cards\.security\.unsafeWebdav\.confirmationTitle/);
});

test('risk confirmation is portalled to the viewport and has dedicated danger treatment', () => {
    assert.match(settings, /createPortal/);
    assert.match(settings, /tone\?: 'default' \| 'danger'/);
    assert.match(settings, /settings\.cards\.security\.unsafeWebdav\.confirmEnable/);
    assert.match(settings, /bg-destructive\/10/);
});
