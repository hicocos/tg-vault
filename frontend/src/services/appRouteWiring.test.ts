import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const layout = fs.readFileSync(new URL('../components/layout/AppLayout.tsx', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../components/pages/SettingsPage.tsx', import.meta.url), 'utf8');

test('App owns pathname state and synchronizes Browser History', () => {
    assert.match(app, /parseAppRoute\(window\.location\)/);
    assert.match(app, /addEventListener\(['"]popstate['"]/);
    assert.match(app, /window\.history\.pushState/);
    assert.match(app, /window\.history\.replaceState/);
    assert.match(app, /activeCategory=\{currentCategory\}/);
    assert.match(app, /activeSection=\{settingsSection\}/);
});

test('layout navigation is controlled by the current route', () => {
    assert.match(layout, /activeCategory: string/);
    assert.doesNotMatch(layout, /useState\(["']all["']\)/);
    assert.match(layout, /isActive=\{activeCategory === cat\.id\}/);
});

test('settings navigation is controlled by the current route', () => {
    assert.match(settings, /activeSection: SettingsSectionId/);
    assert.match(settings, /onSectionChange: \(section: SettingsSectionId\) => void/);
    assert.doesNotMatch(settings, /useState<SettingsSectionId>\(['"]general['"]\)/);
    assert.match(settings, /onClick=\{\(\) => onSectionChange\(section\.id\)\}/);
});
