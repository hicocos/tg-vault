export type FileQuerySort = 'date' | 'name';
export type FileQueryDirection = 'asc' | 'desc';
export type FileQueryScope = { kind: 'local' } | { kind: 'account'; accountId: string };

export interface NormalizedFileQuery {
    q: string | null;
    type: 'image' | 'video' | 'audio' | 'document' | 'other' | 'media' | null;
    folder: string | null | undefined;
    favorite: boolean | null;
    sort: FileQuerySort;
    direction: FileQueryDirection;
    limit: number;
    cursor: string | null;
}

export interface FileQueryCursor {
    sort: FileQuerySort;
    direction: FileQueryDirection;
    value: string;
    id: string;
}

export interface BuiltQuery {
    text: string;
    params: unknown[];
}

const FILE_TYPES = new Set(['image', 'video', 'audio', 'document', 'other', 'media']);
const SORTS = new Set(['date', 'name']);
const DIRECTIONS = new Set(['asc', 'desc']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function single(value: unknown): string | undefined {
    if (Array.isArray(value)) throw new Error('query parameter must be singular');
    return typeof value === 'string' ? value : undefined;
}

export function normalizeFileQuery(input: Record<string, unknown>): NormalizedFileQuery {
    const rawQ = single(input.q)?.trim() || null;
    if (rawQ && rawQ.length > 200) throw new Error('q is too long');

    const rawType = single(input.type)?.trim() || null;
    if (rawType && !FILE_TYPES.has(rawType)) throw new Error('invalid type');

    const rawFavorite = single(input.favorite);
    let favorite: boolean | null = null;
    if (rawFavorite !== undefined && rawFavorite !== '') {
        if (rawFavorite !== 'true' && rawFavorite !== 'false') throw new Error('invalid favorite');
        favorite = rawFavorite === 'true';
    }

    const rawSort = single(input.sort) || 'date';
    if (!SORTS.has(rawSort)) throw new Error('invalid sort');
    const rawDirection = single(input.direction) || 'desc';
    if (!DIRECTIONS.has(rawDirection)) throw new Error('invalid direction');

    const rawFolder = single(input.folder);
    const folder = rawFolder === undefined ? undefined : (rawFolder.trim() || null);
    if (folder && folder.length > 500) throw new Error('folder is too long');

    const parsedLimit = Number.parseInt(single(input.limit) || '200', 10);
    const limit = Math.min(500, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 200));

    return {
        q: rawQ,
        type: rawType as NormalizedFileQuery['type'],
        folder,
        favorite,
        sort: rawSort as FileQuerySort,
        direction: rawDirection as FileQueryDirection,
        limit,
        cursor: single(input.cursor) || null,
    };
}

export function encodeFileQueryCursor(cursor: FileQueryCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeFileQueryCursor(
    encoded: string | null,
    sort: FileQuerySort,
    direction: FileQueryDirection,
): FileQueryCursor | null {
    if (!encoded) return null;
    try {
        const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<FileQueryCursor>;
        if (parsed.sort !== sort || parsed.direction !== direction || typeof parsed.value !== 'string' || !UUID_PATTERN.test(parsed.id || '')) {
            return null;
        }
        if (sort === 'date' && Number.isNaN(Date.parse(parsed.value))) return null;
        return parsed as FileQueryCursor;
    } catch {
        return null;
    }
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function addScope(scope: FileQueryScope, where: string[], params: unknown[], alias = ''): void {
    const prefix = alias ? `${alias}.` : '';
    if (scope.kind === 'local') {
        params.push('local');
        where.push(`${prefix}source = $${params.length}`);
    } else {
        params.push(scope.accountId);
        where.push(`${prefix}storage_account_id = $${params.length}`);
    }
}

function addFilters(options: NormalizedFileQuery, where: string[], params: unknown[], alias = '', includeFolder = true): void {
    const prefix = alias ? `${alias}.` : '';
    if (options.q) {
        params.push(`%${escapeLike(options.q)}%`);
        where.push(`(${prefix}name ILIKE $${params.length} ESCAPE '\\' OR ${prefix}folder ILIKE $${params.length} ESCAPE '\\')`);
    }
    if (options.type === 'media') {
        where.push(`${prefix}type IN ('image', 'video', 'audio')`);
    } else if (options.type === 'document') {
        where.push(`${prefix}type NOT IN ('image', 'video', 'audio')`);
    } else if (options.type) {
        params.push(options.type);
        where.push(`${prefix}type = $${params.length}`);
    }
    if (includeFolder && options.folder !== undefined) {
        if (options.folder === null) {
            where.push(`${prefix}folder IS NULL`);
        } else {
            params.push(options.folder);
            where.push(`${prefix}folder = $${params.length}`);
        }
    }
    if (options.favorite !== null) {
        params.push(options.favorite);
        where.push(`${prefix}is_favorite = $${params.length}`);
    }
}

export function buildFilePageQuery(scope: FileQueryScope, options: NormalizedFileQuery): BuiltQuery {
    const where: string[] = [];
    const params: unknown[] = [];
    addScope(scope, where, params);
    addFilters(options, where, params);

    const cursor = decodeFileQueryCursor(options.cursor, options.sort, options.direction);
    const comparator = options.direction === 'asc' ? '>' : '<';
    const direction = options.direction.toUpperCase();
    if (cursor) {
        if (options.sort === 'name') {
            params.push(cursor.value.toLocaleLowerCase(), cursor.id);
            where.push(`(LOWER(name), id) ${comparator} ($${params.length - 1}, $${params.length}::uuid)`);
        } else {
            params.push(cursor.value, cursor.id);
            where.push(`(created_at, id) ${comparator} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
        }
    }

    params.push(options.limit + 1);
    const sortColumn = options.sort === 'name' ? 'LOWER(name)' : 'created_at';
    return {
        text: `SELECT
    id, name, stored_name, type, mime_type, size, thumbnail_path, preview_path,
    width, height, source, folder, storage_account_id, is_favorite, created_at, updated_at
FROM files
WHERE ${where.join(' AND ')}
ORDER BY ${sortColumn} ${direction}, id ${direction}
LIMIT $${params.length}`,
        params,
    };
}

export function buildFolderAggregationQuery(scope: FileQueryScope, options: NormalizedFileQuery): BuiltQuery {
    const where: string[] = ['folder IS NOT NULL'];
    const params: unknown[] = [];
    addScope(scope, where, params);
    addFilters({ ...options, folder: undefined }, where, params, '', false);

    const direction = options.direction.toUpperCase();
    const order = options.sort === 'name'
        ? `folder ${direction}`
        : `latest_at ${direction}, folder ${direction}`;

    return {
        text: `WITH filtered AS (
    SELECT * FROM files WHERE ${where.join(' AND ')}
), grouped AS (
    SELECT
        folder,
        COUNT(*) FILTER (WHERE name <> '.folder')::int AS file_count,
        COALESCE(SUM(size) FILTER (WHERE name <> '.folder'), 0)::bigint AS total_size_bytes,
        MAX(created_at) AS latest_at,
        BOOL_AND(is_favorite)::boolean AS is_favorite
    FROM filtered
    GROUP BY folder
)
SELECT grouped.*, cover.id AS cover_id, cover.name AS cover_name, cover.type AS cover_type,
       cover.mime_type AS cover_mime_type, cover.thumbnail_path AS cover_thumbnail_path,
       cover.preview_path AS cover_preview_path, cover.created_at AS cover_created_at
FROM grouped
LEFT JOIN LATERAL (
    SELECT id, name, type, mime_type, thumbnail_path, preview_path, created_at
    FROM filtered candidate
    WHERE candidate.folder = grouped.folder AND candidate.name <> '.folder'
    ORDER BY candidate.created_at DESC, candidate.id DESC
    LIMIT 1
) cover ON TRUE
ORDER BY ${order}`,
        params,
    };
}

export function cursorForFile(file: Record<string, unknown>, sort: FileQuerySort, direction: FileQueryDirection): string {
    const value = sort === 'name'
        ? String(file.name || '').toLocaleLowerCase()
        : new Date(String(file.created_at)).toISOString();
    return encodeFileQueryCursor({ sort, direction, value, id: String(file.id) });
}
