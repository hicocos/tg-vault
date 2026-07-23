import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFileViewState } from './fileViewState.js';

test('file view distinguishes folder, search, filtered, and root empty states', () => {
    assert.equal(describeFileViewState({ folder: 'a/b', query: '', category: 'all', error: null, stale: false }).kind, 'empty-folder');
    assert.equal(describeFileViewState({ folder: null, query: 'cat', category: 'all', error: null, stale: false }).kind, 'empty-search');
    assert.equal(describeFileViewState({ folder: null, query: '', category: 'video', error: null, stale: false }).kind, 'empty-filter');
    assert.equal(describeFileViewState({ folder: null, query: '', category: 'all', error: null, stale: false }).kind, 'empty-root');
});

test('file view distinguishes blocking failures from stale-data warnings', () => {
    const offline = describeFileViewState({ folder: null, query: '', category: 'all', error: 'NETWORK_OFFLINE', stale: false });
    assert.deepEqual({ kind: offline.kind, canRetry: offline.canRetry }, { kind: 'offline', canRetry: true });

    const stale = describeFileViewState({ folder: null, query: '', category: 'all', error: 'provider unavailable', stale: true });
    assert.deepEqual({ kind: stale.kind, canRetry: stale.canRetry }, { kind: 'stale', canRetry: true });
});
