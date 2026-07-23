export interface SqlLoggingConfig {
    slowMs: number;
    logAll: boolean;
}

function parseNonNegativeInteger(name: string, value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === '') return fallback;
    if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a non-negative integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the safe integer range`);
    return parsed;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value.trim() === '') return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${name} must be true or false`);
}

export function parseSqlLoggingConfig(env: NodeJS.ProcessEnv = process.env): SqlLoggingConfig {
    return {
        slowMs: parseNonNegativeInteger('SQL_LOG_SLOW_MS', env.SQL_LOG_SLOW_MS, 500),
        logAll: parseBoolean('SQL_LOG_ALL', env.SQL_LOG_ALL, false),
    };
}

export function shouldLogSqlQuery(durationMs: number, config: SqlLoggingConfig): boolean {
    return config.logAll || durationMs >= config.slowMs;
}

export function sqlOperation(text: string): string {
    const match = text.trimStart().match(/^([A-Za-z]+)/);
    return match?.[1]?.toUpperCase() || 'UNKNOWN';
}

export function buildSqlLogEvent(input: { durationMs: number; rowCount: number | null; operation: string }) {
    return {
        event: 'db.slow_query' as const,
        durationMs: input.durationMs,
        rowCount: input.rowCount,
        operation: input.operation,
    };
}
