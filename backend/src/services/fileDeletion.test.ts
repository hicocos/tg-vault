import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileDeletionService, type IndexedFile } from './fileDeletion.js';

const file: IndexedFile = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'report.pdf',
    path: 'remote-object-id',
    source: 'google_drive',
    storage_account_id: '22222222-2222-4222-8222-222222222222',
};

test('physical deletion failure returns failed and never removes the index', async () => {
    let indexDeleteCalls = 0;
    const service = createFileDeletionService({
        removePhysicalFile: async () => { throw new Error('provider timeout'); },
        deleteIndex: async () => { indexDeleteCalls += 1; return true; },
    });

    const result = await service.deleteIndexedFile(file);

    assert.deepEqual(result, { status: 'failed', error: 'provider timeout' });
    assert.equal(indexDeleteCalls, 0);
});

test('physical not-found is idempotent and removes the stale index', async () => {
    let indexDeleteCalls = 0;
    const notFound = Object.assign(new Error('not found'), { response: { status: 404 } });
    const service = createFileDeletionService({
        removePhysicalFile: async () => { throw notFound; },
        deleteIndex: async (id) => { assert.equal(id, file.id); indexDeleteCalls += 1; return true; },
    });

    const result = await service.deleteIndexedFile(file);

    assert.deepEqual(result, { status: 'not_found' });
    assert.equal(indexDeleteCalls, 1);
});

test('database deletion failure is returned and leaves the index as retry evidence', async () => {
    let physicalDeleteCalls = 0;
    const service = createFileDeletionService({
        removePhysicalFile: async () => { physicalDeleteCalls += 1; },
        deleteIndex: async () => { throw new Error('database unavailable'); },
    });

    const result = await service.deleteIndexedFile(file);

    assert.deepEqual(result, { status: 'failed', error: 'database unavailable' });
    assert.equal(physicalDeleteCalls, 1);
});

test('successful physical and index deletion returns deleted', async () => {
    const service = createFileDeletionService({
        removePhysicalFile: async () => undefined,
        deleteIndex: async () => true,
    });

    assert.deepEqual(await service.deleteIndexedFile(file), { status: 'deleted' });
});
