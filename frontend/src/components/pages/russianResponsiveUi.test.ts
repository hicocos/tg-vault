import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');

test('settings heading keeps its icon beside the title on mobile', () => {
  const source = fs.readFileSync(path.join(root, 'components', 'pages', 'SettingsPage.tsx'), 'utf8');
  assert.match(source, /className="flex min-w-0 items-start gap-3 sm:items-center"/);
  assert.match(source, /className="min-w-0">\s*<h2 className="text-2xl font-bold/);
  assert.doesNotMatch(source, /className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"/);
});


test('Russian catalog uses natural UI labels instead of literal translations', () => {
  const ru = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'ru.json'), 'utf8')) as Record<string, unknown>;
  const text = JSON.stringify(ru);
  assert.doesNotMatch(text, /"select":"Select"|"running":"Бег"|"idle":"Праздный"|Неполноценный/);
});

test('Russian mobile file filters allow long labels to wrap inside their grid cells', () => {
  const source = fs.readFileSync(path.join(root, 'components', 'ui', 'FileTypeFilter.tsx'), 'utf8');
  assert.ok(source.includes('break-words whitespace-normal'));
  assert.doesNotMatch(source, /<span className="truncate">\{option\.shortLabel\}<\/span>/);
});

test('Russian storage statistics stack server capacity and free-space details on mobile', () => {
  const source = fs.readFileSync(path.join(root, 'components', 'pages', 'SettingsPage.tsx'), 'utf8');
  assert.match(source, /flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between/);
  assert.match(source, /flex min-w-0 flex-wrap items-center gap-3/);
});
