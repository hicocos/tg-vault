import assert from 'node:assert/strict';
import { saveAndIndexWithCompensation } from './storageWrite.js';

const deleted: string[] = [];
const provider = {
    name: 's3',
    async saveFile() { return 'object-id'; },
    async deleteFile(path: string) { deleted.push(path); },
};

await assert.rejects(
    () => saveAndIndexWithCompensation(
        provider as any,
        '/tmp/input',
        'stored.bin',
        'application/octet-stream',
        'folder',
        async () => { throw new Error('db insert failed'); },
    ),
    /db insert failed/,
);
assert.deepEqual(deleted, ['object-id']);

let indexedPath = '';
const path = await saveAndIndexWithCompensation(
    provider as any,
    '/tmp/input',
    'stored.bin',
    'application/octet-stream',
    'folder',
    async storedPath => { indexedPath = storedPath; },
);
assert.equal(path, 'object-id');
assert.equal(indexedPath, 'object-id');

console.log('storage write compensation ok');
