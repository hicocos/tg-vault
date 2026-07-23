import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSqlLogEvent, parseSqlLoggingConfig, shouldLogSqlQuery } from './dbLogging.js';

test('production SQL logging is quiet by default and only emits slow-query metadata', () => {
    const config = parseSqlLoggingConfig({ NODE_ENV: 'production' });
    assert.equal(config.logAll, false);
    assert.equal(config.slowMs, 500);
    assert.equal(shouldLogSqlQuery(499, config), false);
    assert.equal(shouldLogSqlQuery(500, config), true);
});

test('SQL logging config validates explicit threshold and all-query opt-in', () => {
    assert.deepEqual(parseSqlLoggingConfig({ SQL_LOG_SLOW_MS: '1200', SQL_LOG_ALL: 'true' }), {
        slowMs: 1200,
        logAll: true,
    });
    assert.throws(() => parseSqlLoggingConfig({ SQL_LOG_SLOW_MS: '-1' }), /SQL_LOG_SLOW_MS/);
    assert.throws(() => parseSqlLoggingConfig({ SQL_LOG_ALL: 'yes' }), /SQL_LOG_ALL/);
});

test('slow-query event is structured and never includes SQL text or parameters', () => {
    const event = buildSqlLogEvent({ durationMs: 732, rowCount: 4, operation: 'SELECT' });
    assert.deepEqual(event, {
        event: 'db.slow_query',
        durationMs: 732,
        rowCount: 4,
        operation: 'SELECT',
    });
    assert.equal(JSON.stringify(event).includes('secret'), false);
});
