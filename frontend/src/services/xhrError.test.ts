import assert from 'node:assert/strict';
import test from 'node:test';
import { parseXhrError } from './xhrError.js';
import { isUnauthorizedError } from './apiActionError.js';

test('auth statuses expire session', () => {
  assert.equal(isUnauthorizedError(parseXhrError(401, '')), true);
});

test('non-JSON server upload errors remain actionable', () => {
  const error = parseXhrError(502, '<html>Bad Gateway</html>') as any;
  assert.equal(error.kind, 'unavailable');
  assert.equal(error.status, 502);
  assert.match(error.message, /HTTP 502/);
});

test('JSON error details are preserved for client errors', () => {
  assert.equal(parseXhrError(400, JSON.stringify({ message: 'Token 无效' })).message, 'Token 无效');
});
