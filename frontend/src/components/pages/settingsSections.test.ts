import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_SECTIONS, normalizeSettingsSection } from './settingsSections.js';

test('settings navigation exposes focused product areas in a stable order', () => {
    assert.deepEqual(SETTINGS_SECTIONS.map(section => section.id), ['general', 'security', 'telegram', 'storage', 'maintenance']);
    assert.ok(SETTINGS_SECTIONS.every(section => section.labelKey.startsWith('settings.nav.')));
});

test('settings navigation defaults unknown sections to general', () => {
    assert.equal(normalizeSettingsSection('storage'), 'storage');
    assert.equal(normalizeSettingsSection('unknown'), 'general');
    assert.equal(normalizeSettingsSection(null), 'general');
});
