import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOperationalEvent, normalizeRequestId } from './operationalEvents.js';

test('request IDs accept a bounded safe alphabet and reject attacker-controlled log text', () => {
    assert.equal(normalizeRequestId('req_abc-123'), 'req_abc-123');
    assert.equal(normalizeRequestId('bad\nforged'), null);
    assert.equal(normalizeRequestId('x'.repeat(129)), null);
});

test('structured events redact secrets, paths and filenames recursively', () => {
    const event = buildOperationalEvent('delete.partial', 'req-1', {
        token: 'secret', authToken: 'secret2', path: '/data/private/a.txt', filename: 'private.txt',
        nested: { refreshToken: 'refresh', error: 'provider timeout' }, count: 2,
    });
    const serialized = JSON.stringify(event);
    assert.equal(event.data.token, '[REDACTED]');
    assert.equal(event.data.authToken, '[REDACTED]');
    assert.equal(event.data.path, '[REDACTED]');
    assert.equal(event.data.filename, '[REDACTED]');
    assert.equal((event.data.nested as Record<string, unknown>).refreshToken, '[REDACTED]');
    assert.doesNotMatch(serialized, /"secret"|"secret2"|\/data\/private|private\.txt|"refresh"/);
    assert.match(serialized, /provider timeout/);
    assert.equal(event.requestId, 'req-1');
    assert.equal(event.data.count, 2);
});
