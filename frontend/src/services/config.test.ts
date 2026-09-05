import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeApiBase } from './config.js';

test('API base accepts an origin or origin/api without duplicating the API prefix', () => {
    assert.equal(normalizeApiBase('https://api.example.com'), 'https://api.example.com');
    assert.equal(normalizeApiBase('https://api.example.com/'), 'https://api.example.com');
    assert.equal(normalizeApiBase('https://api.example.com/api'), 'https://api.example.com');
    assert.equal(normalizeApiBase('https://api.example.com/api/'), 'https://api.example.com');
    assert.equal(normalizeApiBase('  '), '');
});
