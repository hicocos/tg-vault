import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const sourceRoot = path.resolve(import.meta.dirname, '..');
const allowedFiles = new Set([
  'i18n/hardcodedVisibleCopy.test.ts',
]);
const allowedLinePatterns = [
  /^\s*\/\//,
  /^\s*\/\*/,
  /^\s*\*/,
  /\/\/.*[\u3400-\u9fff]/,
  /console\.(?:debug|info|warn|error)/,
  /["'`]zh-CN["'`]/,
  /["'`]简体中文["'`]/, // locale native name is intentionally native
  /\/.*[\u3400-\u9fff].*\/[gimyus]*/, // language-aware diagnostic regex
];

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name) || /\.test\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [absolute];
  });
}

const productionUiRoots = [
  path.join(sourceRoot, 'App.tsx'),
  path.join(sourceRoot, 'components'),
];

test('production source has no hardcoded Chinese visible copy', () => {
  const failures: string[] = [];
  for (const root of productionUiRoots) {
    for (const file of fs.statSync(root).isDirectory() ? sourceFiles(root) : [root]) {
      const relative = path.relative(sourceRoot, file).replaceAll(path.sep, '/');
      if (allowedFiles.has(relative)) continue;
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
        if (!/[\u3400-\u9fff]/.test(line) || allowedLinePatterns.some(pattern => pattern.test(line))) return;
        failures.push(`${relative}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(failures, [], `Hardcoded Chinese copy:\n${failures.join('\n')}`);
});
