import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('frontend product flows do not use browser alert confirm or prompt', () => {
    const root = path.resolve(new URL('../', import.meta.url).pathname);
    const files: string[] = [];
    const walk = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(fullPath);
            else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) files.push(fullPath);
        }
    };
    walk(root);
    for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /window\.(alert|confirm|prompt)\(/, file);
});