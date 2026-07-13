import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDeleteSize } from './deletePresentation.js';

const cases: Array<[number, string]> = [
    [0, '0 B'],
    [1, '1 B'],
    [1024 * 1024 - 1, '1024.0 KiB'],
    [1024 * 1024, '1.0 MiB'],
    [1024 * 1024 * 1024 - 1, '1024.0 MiB'],
    [1024 * 1024 * 1024, '1.0 GiB'],
    [2 * 1024 * 1024 * 1024, '2.0 GiB'],
];

for (const [bytes, expected] of cases) {
    test(`formats ${bytes} bytes as ${expected}`, () => {
        assert.equal(formatDeleteSize(bytes), expected);
    });
}
