import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestRequest } from './latestRequest.js';

test('new generation aborts the previous request and only latest may commit', () => {
    const requests = new LatestRequest();
    const first = requests.begin();
    const second = requests.begin();

    assert.equal(first.signal.aborted, true);
    assert.equal(first.isCurrent(), false);
    assert.equal(second.signal.aborted, false);
    assert.equal(second.isCurrent(), true);
});

test('cancel invalidates in-flight generation including load-more work', () => {
    const requests = new LatestRequest();
    const current = requests.begin();
    requests.cancel();
    assert.equal(current.signal.aborted, true);
    assert.equal(current.isCurrent(), false);
});
