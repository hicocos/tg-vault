import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const frontendRoot = path.resolve(import.meta.dirname, '..', '..');
const projectRoot = path.resolve(frontendRoot, '..');
const russianCatalogs = [
  path.join(frontendRoot, 'src', 'locales', 'ru.json'),
  path.join(projectRoot, 'backend', 'src', 'i18n', 'telegramRussian.json'),
];

const flattenStrings = (value: unknown, prefix = ''): Array<[string, string]> => {
  if (typeof value === 'string') return [[prefix, value]];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => flattenStrings(child, prefix ? `${prefix}.${key}` : key));
};

const loadCatalog = (file: string) => {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false, `${file} must not contain a UTF-8 BOM`);
  const source = bytes.toString('utf8');
  assert.equal(source.includes('\uFFFD'), false, `${file} contains an invalid UTF-8 replacement character`);
  return { file, entries: flattenStrings(JSON.parse(source)) };
};

test('Russian catalogs use clean UTF-8 text and no invisible spacing controls', () => {
  for (const catalog of russianCatalogs.map(loadCatalog)) {
    for (const [key, value] of catalog.entries) {
      assert.doesNotMatch(value, /[\u200B\u200C\u200D\u2060\uFEFF\u3000]/, `${catalog.file}:${key} contains invisible or ideographic spacing`);
      assert.doesNotMatch(value, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/, `${catalog.file}:${key} contains a control character`);
    }
  }
});

test('Russian Cyrillic ka remains U+043A inside Cyrillic words', () => {
  for (const catalog of russianCatalogs.map(loadCatalog)) {
    for (const [key, value] of catalog.entries) {
      assert.doesNotMatch(value, /[А-Яа-яЁё]k|k[А-Яа-яЁё]/, `${catalog.file}:${key} mixes Latin k into a Cyrillic word`);
    }
  }
});

test('frontend declares a Cyrillic-safe sans-serif stack and neutral tracking defaults', () => {
  const css = fs.readFileSync(path.join(frontendRoot, 'src', 'index.css'), 'utf8');
  assert.match(css, /--font-sans:\s*[^;]*system-ui[^;]*sans-serif/);
  assert.match(css, /font-family:\s*var\(--font-sans\)/);
  assert.match(css, /letter-spacing:\s*normal/);
  assert.match(css, /font-feature-settings:\s*normal/);
  assert.match(css, /font-variant-ligatures:\s*normal/);
  assert.match(css, /font-variant-caps:\s*normal/);
});

test('Russian UI disables Latin-oriented tracking and word breaking on every locale root', () => {
  const css = fs.readFileSync(path.join(frontendRoot, 'src', 'index.css'), 'utf8');
  assert.match(css, /html\[lang=\"ru\"\]\s*,\s*html\[lang\^=\"ru-\"\]/);
  assert.match(css, /font-family:\s*var\(--font-sans-ru\)/);
  assert.match(css, /letter-spacing:\s*normal/);
  assert.match(css, /word-spacing:\s*normal/);
  assert.match(css, /word-break:\s*normal/);
  assert.match(css, /overflow-wrap:\s*normal/);
  assert.match(css, /text-align:\s*left/);
  assert.match(css, /text-justify:\s*none/);
});

test('storage headers keep Russian descriptions from collapsing beside action buttons', () => {
  const settings = fs.readFileSync(path.join(frontendRoot, 'src', 'components', 'pages', 'SettingsPage.tsx'), 'utf8');
  const openList = settings.slice(settings.indexOf("sectionId=\"openlist\""));
  assert.match(openList, /flex min-w-0 flex-1 items-center gap-3/);
  assert.match(openList, /<div className=\"min-w-0 flex-1\">/);
  assert.match(openList, /ru-copy text-xs text-muted-foreground[^\n]*t\('settings\.openlist\.description'\)/);
  assert.match(openList, /settings\.openlist\.rootHint/);
});
