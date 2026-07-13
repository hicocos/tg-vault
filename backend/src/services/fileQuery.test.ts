import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFilePageQuery,
    buildFolderAggregationQuery,
    decodeFileQueryCursor,
    encodeFileQueryCursor,
    normalizeFileQuery,
} from './fileQuery.js';

const localScope = { kind: 'local' as const };

test('normalizes validated global query options and rejects invalid values', () => {
    assert.deepEqual(normalizeFileQuery({
        q: '  holiday  ', type: 'image', folder: '', favorite: 'true',
        sort: 'name', direction: 'asc', limit: '999',
    }), {
        q: 'holiday', type: 'image', folder: null, favorite: true,
        sort: 'name', direction: 'asc', limit: 500, cursor: null,
    });

    assert.throws(() => normalizeFileQuery({ type: 'executable' }), /type/);
    assert.throws(() => normalizeFileQuery({ favorite: 'sometimes' }), /favorite/);
    assert.throws(() => normalizeFileQuery({ sort: 'size' }), /sort/);
    assert.throws(() => normalizeFileQuery({ direction: 'sideways' }), /direction/);
    assert.throws(() => normalizeFileQuery({ q: 'x'.repeat(201) }), /q/);
});

test('builds scoped search, type, root-folder and favorite predicates with deterministic name keyset', () => {
    const options = normalizeFileQuery({
        q: 'report_%', type: 'document', folder: '', favorite: 'true',
        sort: 'name', direction: 'asc', limit: '25',
    });
    const cursor = encodeFileQueryCursor({ sort: 'name', direction: 'asc', value: 'alpha', id: '00000000-0000-4000-8000-000000000001' });
    const built = buildFilePageQuery(localScope, { ...options, cursor });

    assert.match(built.text, /source = \$1/);
    assert.match(built.text, /name ILIKE \$2/);
    assert.match(built.text, /type NOT IN \('image', 'video', 'audio'\)/);
    assert.match(built.text, /folder IS NULL/);
    assert.match(built.text, /is_favorite = \$3/);
    assert.match(built.text, /\(LOWER\(name\), id\) > \(\$4, \$5::uuid\)/);
    assert.match(built.text, /ORDER BY LOWER\(name\) ASC, id ASC/);
    assert.deepEqual(built.params, ['local', '%report\\_\\%%', true, 'alpha', '00000000-0000-4000-8000-000000000001', 26]);
});

test('cursor is bound to sort and direction and date pages are stable beyond 200 records', () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(index / 3))).toISOString(),
    })).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

    const first = rows.slice(0, 200);
    const cursor = encodeFileQueryCursor({
        sort: 'date', direction: 'desc', value: first[199].created_at, id: first[199].id,
    });
    const decoded = decodeFileQueryCursor(cursor, 'date', 'desc');
    assert.deepEqual(decoded, { sort: 'date', direction: 'desc', value: first[199].created_at, id: first[199].id });
    assert.equal(decodeFileQueryCursor(cursor, 'name', 'desc'), null);

    const remaining = rows.filter(row =>
        row.created_at < decoded!.value || (row.created_at === decoded!.value && row.id < decoded!.id),
    );
    assert.deepEqual(remaining, rows.slice(200));
    assert.equal(new Set([...first, ...remaining].map(row => row.id)).size, 205);
});

test('folder aggregation uses the same global filters and excludes placeholders from count and bytes', () => {
    const options = normalizeFileQuery({ q: 'trip', type: 'image', favorite: 'true', sort: 'date', direction: 'desc' });
    const built = buildFolderAggregationQuery({ kind: 'account', accountId: 'account-1' }, options);

    assert.match(built.text, /storage_account_id = \$1/);
    assert.match(built.text, /name <> '\.folder'/);
    assert.match(built.text, /COUNT\(\*\) FILTER \(WHERE name <> '\.folder'\)::int AS file_count/);
    assert.match(built.text, /COALESCE\(SUM\(size\) FILTER \(WHERE name <> '\.folder'\), 0\)::bigint AS total_size_bytes/);
    assert.match(built.text, /LEFT JOIN LATERAL/);
    assert.match(built.text, /ORDER BY latest_at DESC, folder DESC/);
    assert.deepEqual(built.params, ['account-1', '%trip%', 'image', true]);
});
