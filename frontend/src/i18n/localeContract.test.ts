import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LOCALE, FALLBACK_LOCALE, localeRegistry, normalizeLocale, resolveInitialLocale } from './registry';
import { formatBytes, formatDateTime, formatDuration, formatInteger } from './format';
import { localizedApiError } from './errors';

test('locale registry is config driven and Chinese is the safe default/fallback', () => {
  assert.equal(DEFAULT_LOCALE, 'zh-CN');
  assert.equal(FALLBACK_LOCALE, 'zh-CN');
  assert.deepEqual(localeRegistry.map(locale => locale.code), ['zh-CN', 'en', 'ru']);
  assert.ok(localeRegistry.every(locale => locale.nativeName && locale.intlLocale && locale.direction && locale.aliases.length));
});

test('locale aliases and unsupported values normalize safely', () => {
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('fr-FR'), 'zh-CN');
  assert.equal(normalizeLocale(undefined), 'zh-CN');
});

test('explicit choice wins, then browser preference, then Chinese', () => {
  assert.equal(resolveInitialLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveInitialLocale('en', ['zh-CN']), 'en');
  assert.equal(resolveInitialLocale(null, ['fr-FR', 'en-GB']), 'en');
  assert.equal(resolveInitialLocale(null, ['fr-FR']), 'zh-CN');
  assert.equal(resolveInitialLocale(null, []), 'zh-CN');
});

test('locale formatters cover numbers, dates, duration and file size', () => {
  assert.equal(formatInteger(12345, 'en'), '12,345');
  assert.equal(formatInteger(12345, 'zh-CN'), '12,345');
  assert.match(formatBytes(1536, 'en'), /1\.5\s?kB/i);
  assert.match(formatBytes(1536, 'zh-CN'), /1\.5\s?kB/i);
  assert.match(formatDuration(65, 'en'), /1.*minute.*5.*second/i);
  assert.match(formatDuration(65, 'zh-CN'), /1.*分.*5.*秒/);
  assert.ok(formatDateTime('2026-01-02T03:04:00Z', 'en').length > 0);
});

test('stable API error codes localize without making raw details primary', () => {
  assert.match(localizedApiError({ code: 'RATE_LIMITED', params: { retryAfter: 30 }, message: 'raw upstream' }, 'en'), /too many requests/i);
  assert.doesNotMatch(localizedApiError({ code: 'RATE_LIMITED', message: '原始上游错误' }, 'en'), /原始上游错误/);
  assert.match(localizedApiError({ code: 'UNSUPPORTED_THING' }, 'zh-CN'), /操作失败/);
});
