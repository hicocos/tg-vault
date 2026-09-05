import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./AppLayout.tsx', import.meta.url), 'utf8');

test('mobile header keeps brand and controls in one row at narrow widths', () => {
  assert.match(source, /data-testid="app-header"[^>]*className="[^"]*min-w-0[^"]*"/);
  assert.match(source, /data-testid="mobile-brand"[^>]*className="[^"]*min-w-0[^"]*"/);
  assert.match(source, /data-testid="header-actions"[^>]*className="[^"]*shrink-0[^"]*"/);
  assert.match(source, /<LanguageToggle compact className="[^"]*max-\[420px\]:w-\[84px\][^"]*max-\[420px\]:\[&_select\]:max-w-none[^"]*" \/>/);
  assert.match(source, /className="max-\[420px\]:hidden"><HeaderThemeSwitch \/>/);
});

test('mobile header keeps the language selector usable instead of collapsing it to an icon-sized box', () => {
  assert.match(source, /<LanguageToggle compact className="[^"]*max-\[420px\]:w-\[84px\][^"]*max-\[420px\]:\[&_select\]:max-w-none[^"]*" \/>/);
});