import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { localeRegistry } from '../i18n/registry';

const requiredCoreKeys = [
  'settings.title',
  'settings.subtitle',
  'settings.nav.general',
  'settings.nav.security',
  'settings.general.title',
  'settings.general.language',
  'settings.general.theme',
  'settings.remaining.shared.guidePrefix',
  'settings.remaining.shared.guideLink',
  'settings.remaining.shared.guideSuffix',
] as const;

const interpolationTokens = (value: string) => [...value.matchAll(/{{\s*([\w.-]+)(?:\s*,[^}]*)?\s*}}/g)].map(match => match[1]).sort();
const flatten = (value: unknown, prefix = ''): Record<string, string> => {
  if (typeof value === 'string') return { [prefix]: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.assign({}, ...Object.entries(value).map(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key)));
};

test('all registered locale resources have key and interpolation parity', async () => {
  const catalogs = await Promise.all(localeRegistry.map(async locale => flatten(await locale.load())));
  const baselineKeys = Object.keys(catalogs[0]).sort();
  for (let index = 1; index < catalogs.length; index += 1) {
    assert.deepEqual(Object.keys(catalogs[index]).sort(), baselineKeys, `${localeRegistry[index].code} keys differ`);
    for (const key of baselineKeys) {
      assert.deepEqual(interpolationTokens(catalogs[index][key]), interpolationTokens(catalogs[0][key]), `${localeRegistry[index].code}:${key} interpolation differs`);
      assert.notEqual(catalogs[index][key], key, `${localeRegistry[index].code}:${key} renders its lookup key`);
    }
  }
});

test('all literal translation references resolve in every composed catalog', async () => {
  const flattenReferences = (value: unknown, prefix = '', output: Record<string, unknown> = {}): Record<string, unknown> => {
    if (typeof value === 'string' || Array.isArray(value)) output[prefix] = value;
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) flattenReferences(child, prefix ? `${prefix}.${key}` : key, output);
    return output;
  };
  const catalogs = await Promise.all(localeRegistry.map(async locale => flattenReferences(await locale.load())));
  const sourceRoot = path.resolve(import.meta.dirname, '..');
  const sourceFiles = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
  const references = new Set<string>();
  for (const file of sourceFiles(sourceRoot)) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) references.add(match[1]);
  }
  for (const key of references) {
    for (let index = 0; index < catalogs.length; index += 1) {
      const value = catalogs[index][key];
      assert.ok(typeof value === 'string' || Array.isArray(value), `${localeRegistry[index].code} missing referenced key ${key}`);
      if (typeof value === 'string') assert.notEqual(value, key, `${localeRegistry[index].code}:${key} renders its lookup key`);
    }
  }
});

test('English resources contain no Chinese user copy', async () => {
  const english = flatten(await localeRegistry.find(locale => locale.code === 'en')!.load());
  for (const [key, value] of Object.entries(english)) assert.doesNotMatch(value, /[\u3400-\u9fff]/, key);
});

test('Chinese resources do not silently render English copy for storage guide keys', async () => {
  const chinese = flatten(await localeRegistry.find(locale => locale.code === 'zh-CN')!.load());
  assert.equal(chinese['settings.remaining.shared.guidePrefix'], '需要配置帮助？请查看');
  assert.equal(chinese['settings.remaining.shared.guideLink'], '存储配置指南');
  assert.equal(chinese['settings.remaining.shared.guideSuffix'], '。');
});

test('locale resources contain only copy, not leaked TSX source fragments', async () => {
  for (const locale of localeRegistry) {
    const catalog = flatten(await locale.load());
    for (const [key, value] of Object.entries(catalog)) {
      assert.doesNotMatch(value, /\$\{|className=|placeholder=|onChange=|\{t\(|<\/|\.slice\(|event\.|telegramBotConfig/, `${locale.code}:${key}`);
    }
  }
});

test('composed locale resources preserve core copy when feature catalogs extend the same section', async () => {
  for (const locale of localeRegistry) {
    const catalog = flatten(await locale.load());
    for (const key of requiredCoreKeys) {
      assert.equal(typeof catalog[key], 'string', `${locale.code} missing ${key}`);
    }
  }
});
