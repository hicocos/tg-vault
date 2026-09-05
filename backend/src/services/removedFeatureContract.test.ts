import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(backendRoot, '..');
const thisFile = fileURLToPath(import.meta.url);
const forbidden = [
    ['yt', 'dlp'].join('-'),
    ['yt', 'dlp'].join(''),
    ['yt', 'dlp'].join('_'),
    ['you', 'tube'].join(''),
];

function collectFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git', 'coverage'].includes(entry.name)) continue;
        const fullPath = path.join(root, entry.name);
        if (fullPath === thisFile) continue;
        if (entry.isDirectory()) files.push(...collectFiles(fullPath));
        else files.push(fullPath);
    }
    return files;
}

test('removed media-link downloader has no runtime, UI, config, dependency, or documentation surface', () => {
    const roots = [
        path.join(repositoryRoot, 'backend', 'src'),
        path.join(repositoryRoot, 'frontend', 'src'),
        path.join(repositoryRoot, 'backend', 'Dockerfile'),
        path.join(repositoryRoot, 'docker-compose.yml'),
        path.join(repositoryRoot, 'README.md'),
    ];
    const candidates = roots.flatMap(root => fs.statSync(root).isDirectory() ? collectFiles(root) : [root]);
    const violations: string[] = [];

    for (const file of candidates) {
        const relative = path.relative(repositoryRoot, file);
        if (relative.startsWith(`backend${path.sep}src${path.sep}db${path.sep}migrations${path.sep}`)) continue;
        const lowerName = path.basename(file).toLowerCase();
        const content = fs.readFileSync(file, 'utf8').toLowerCase();
        if (forbidden.some(term => lowerName.includes(term) || content.includes(term))) violations.push(relative);
    }

    assert.deepEqual(violations, []);
});
