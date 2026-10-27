import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveQbSource } from '../src/services/qbittorrentTasks.js';

const file = (name: string, size = 4) => ({ index: 0, name, size, progress: 1, priority: 1 });

test('BT transfer rejects traversal, absolute paths and symlinks escaping its task directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-path-'));
    try {
        const task = path.join(root, 'task');
        await fs.mkdir(task);
        await fs.writeFile(path.join(root, 'outside.txt'), 'safe');
        await fs.symlink(path.join(root, 'outside.txt'), path.join(task, 'link.txt'));
        for (const name of ['../outside.txt', '/etc/passwd', 'sub/../../outside.txt', 'sub\\outside.txt', 'link.txt']) {
            await assert.rejects(resolveQbSource(task, file(name)), /不安全|超出/);
        }
        assert.equal(await fs.readFile(path.join(root, 'outside.txt'), 'utf8'), 'safe');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('BT transfer accepts nested completed files but rejects size changes and directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-file-'));
    try {
        await fs.mkdir(path.join(root, 'nested'));
        await fs.writeFile(path.join(root, 'nested', 'file.txt'), 'safe');
        assert.equal(await resolveQbSource(root, file('nested/file.txt')), path.join(root, 'nested', 'file.txt'));
        await assert.rejects(resolveQbSource(root, file('nested/file.txt', 5)), /大小不符/);
        await assert.rejects(resolveQbSource(root, file('nested')), /大小不符/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
