import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMagnetLinks } from '../src/services/qbittorrentBatch.ts';

test('magnet batches preserve complete URLs and order while ignoring blank and duplicate lines', () => {
    const first = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=First%20file&tr=https%3A%2F%2Ftracker.example%2Fannounce';
    const second = 'magnet:?xt=urn:btih:abcdef0123456789012345678901234567890123&dn=Second+file';
    assert.deepEqual(parseMagnetLinks(` \r\n ${first} \r\n\r\n${second}\n${first}\n`), [first, second]);
});

test('magnet batches retain malformed lines so one invalid source cannot silently disappear', () => {
    assert.deepEqual(parseMagnetLinks('magnet:?xt=valid\nnot-a-magnet'), ['magnet:?xt=valid', 'not-a-magnet']);
    assert.deepEqual(parseMagnetLinks(' \n\r\n\t'), []);
});
