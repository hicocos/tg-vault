type RuntimeEnv = NodeJS.ProcessEnv;

interface NumberSpec {
    name: string;
    fallback: number;
    min: number;
    max: number;
}

const NUMBER_SPECS: NumberSpec[] = [
    { name: 'PORT', fallback: 51947, min: 1, max: 65535 },
    { name: 'MAX_UPLOAD_CHUNK_MB', fallback: 32, min: 1, max: 512 },
    { name: 'MAX_CHUNK_UPLOAD_GB', fallback: 20, min: 1, max: 2048 },
    { name: 'CHUNK_GLOBAL_BUDGET_GB', fallback: 40, min: 1, max: 4096 },
    { name: 'CHUNK_DISK_RESERVE_GB', fallback: 8, min: 1, max: 1024 },
    { name: 'MAX_TOTAL_CHUNKS', fallback: 50_000, min: 1, max: 1_000_000 },
    { name: 'CHUNK_SESSION_TTL_MS', fallback: 86_400_000, min: 3_600_000, max: 2_592_000_000 },
    { name: 'CHUNK_COMPLETION_LEASE_MS', fallback: 1_800_000, min: 60_000, max: 86_400_000 },
    { name: 'ORPHAN_CLEANUP_MIN_AGE_MS', fallback: 600_000, min: 60_000, max: 2_592_000_000 },
    { name: 'SQL_LOG_SLOW_MS', fallback: 500, min: 0, max: 3_600_000 },
    { name: 'TELEGRAM_DOWNLOAD_WORKERS', fallback: 4, min: 1, max: 16 },
    { name: 'TELEGRAM_FILE_DOWNLOAD_CONCURRENCY', fallback: 2, min: 1, max: 4 },
    { name: 'TELEGRAM_RATE_WINDOW_MS', fallback: 60_000, min: 10_000, max: 86_400_000 },
    { name: 'TELEGRAM_RATE_MAX', fallback: 30, min: 5, max: 10_000 },
    { name: 'TELEGRAM_HEAVY_RATE_WINDOW_MS', fallback: 600_000, min: 60_000, max: 86_400_000 },
    { name: 'TELEGRAM_HEAVY_RATE_MAX', fallback: 5, min: 1, max: 1_000 },
    { name: 'TELEGRAM_PIN_FAIL_WINDOW_MS', fallback: 900_000, min: 60_000, max: 86_400_000 },
    { name: 'TELEGRAM_PIN_FAIL_MAX', fallback: 5, min: 3, max: 100 },
    { name: 'TELEGRAM_PIN_LOCK_MS', fallback: 900_000, min: 60_000, max: 86_400_000 },
    { name: 'TELEGRAM_COMMENTS_MAX_PER_POST', fallback: 200, min: 1, max: 10_000 },
    { name: 'TELEGRAM_SUBSCRIPTION_INTERVAL_MS', fallback: 300_000, min: 60_000, max: 86_400_000 },
    { name: 'TELEGRAM_SUBSCRIPTION_SCAN_LIMIT', fallback: 100, min: 1, max: 10_000 },
    { name: 'TG_JOB_RECOVERY_DELAY_MS', fallback: 10_000, min: 1_000, max: 3_600_000 },
    { name: 'TG_JOB_SCAN_SEGMENT_SIZE', fallback: 100, min: 20, max: 10_000 },
    { name: 'TG_JOB_DOWNLOAD_BATCH_SIZE', fallback: 20, min: 1, max: 1_000 },
    { name: 'TG_JOB_MAX_ATTEMPTS', fallback: 3, min: 1, max: 100 },
    { name: 'TG_LARGE_TASK_SEGMENT_SIZE', fallback: 50, min: 10, max: 10_000 },
    { name: 'TG_LARGE_TASK_REFRESH_INTERVAL_MS', fallback: 10_000, min: 3_000, max: 3_600_000 },
    { name: 'TG_MEDIA_GROUP_ENQUEUE_BATCH_SIZE', fallback: 50, min: 1, max: 10_000 },
    { name: 'TG_MIN_FREE_DISK_GB', fallback: 8, min: 1, max: 1024 },
    { name: 'TG_DISK_WATERMARK_RECHECK_MS', fallback: 30_000, min: 5_000, max: 3_600_000 },
    { name: 'TG_DISK_WATERMARK_MAX_WAIT_MS', fallback: 0, min: 0, max: 604_800_000 },
    { name: 'TG_DEBUG_LOG_MAX_MB', fallback: 5, min: 1, max: 1024 },
    { name: 'WEBDAV_INACTIVITY_TIMEOUT_MS', fallback: 300_000, min: 30_000, max: 86_400_000 },
    { name: 'WEBDAV_UPLOAD_TIMEOUT_MS', fallback: 21_600_000, min: 60_000, max: 604_800_000 },
    { name: 'YTDLP_MAX_CONCURRENT', fallback: 1, min: 1, max: 16 },
];

function configured(env: RuntimeEnv, name: string): boolean {
    return Boolean(env[name]?.trim());
}

function parseNumbers(env: RuntimeEnv, errors: string[]): Record<string, number> {
    const values: Record<string, number> = {};
    for (const spec of NUMBER_SPECS) {
        const raw = env[spec.name]?.trim();
        const value = raw ? Number(raw) : spec.fallback;
        if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
            errors.push(`${spec.name} 必须是 ${spec.min} 到 ${spec.max} 之间的整数`);
            continue;
        }
        values[spec.name] = value;
    }
    return values;
}

function validateEnum(env: RuntimeEnv, errors: string[], name: string, values: string[], fallback: string): string {
    const value = env[name]?.trim() || fallback;
    if (!values.includes(value)) errors.push(`${name} 必须是 ${values.join(' / ')}`);
    return value;
}

function validateOrigins(value: string, errors: string[]): number {
    if (!value.trim()) return 0;
    const origins = value.split(',').map(item => item.trim()).filter(Boolean);
    for (const origin of origins) {
        if (origin === '*') continue;
        try {
            const parsed = new URL(origin);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error();
        } catch {
            errors.push(`CORS_ORIGIN 包含无效来源：${origin}`);
        }
    }
    return origins.length;
}

function allowedUserCount(raw: string, errors: string[]): number {
    const values = raw.split(',').map(value => value.trim()).filter(Boolean);
    if (values.some(value => !/^\d+$/.test(value))) errors.push('TELEGRAM_ALLOWED_USER_IDS 只能包含逗号分隔的数字 user id');
    return new Set(values).size;
}

export interface RuntimeConfigSummary {
    server: Record<string, unknown>;
    upload: Record<string, unknown>;
    logging: Record<string, unknown>;
    telegram: Record<string, unknown>;
    ytdlp: Record<string, unknown>;
    storage: Record<string, unknown>;
    security: Record<string, unknown>;
}

export function validateRuntimeConfig(env: RuntimeEnv = process.env): RuntimeConfigSummary {
    const errors: string[] = [];
    const numbers = parseNumbers(env, errors);
    const cookieSecure = validateEnum(env, errors, 'COOKIE_SECURE', ['true', 'false'], env.NODE_ENV === 'production' ? 'true' : 'false') === 'true';
    const duplicateMode = validateEnum(env, errors, 'DUPLICATE_FILE_MODE', ['copy', 'skip'], 'copy');
    const autoCleanup = validateEnum(env, errors, 'AUTO_CLEANUP_ORPHANS', ['true', 'false'], 'true') === 'true';
    const allowInsecureEndpoints = validateEnum(env, errors, 'ALLOW_INSECURE_STORAGE_ENDPOINTS', ['true', 'false'], 'false') === 'true';
    const debugStatus = validateEnum(env, errors, 'TG_STATUS_DEBUG', ['0', '1'], '0') === '1';
    const jsonBodyLimit = env.JSON_BODY_LIMIT?.trim() || '2mb';
    if (!/^\d+(?:\.\d+)?(?:b|kb|mb|gb)$/i.test(jsonBodyLimit)) errors.push('JSON_BODY_LIMIT 必须是带 b/kb/mb/gb 单位的大小，例如 2mb');

    const telegramParts = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH'].filter(name => configured(env, name));
    if (telegramParts.length > 0 && telegramParts.length < 3) errors.push('启用 Telegram 时必须同时配置 TELEGRAM_BOT_TOKEN、TELEGRAM_API_ID 和 TELEGRAM_API_HASH');
    if (configured(env, 'TELEGRAM_API_ID') && !/^\d+$/.test(env.TELEGRAM_API_ID!.trim())) errors.push('TELEGRAM_API_ID 必须是数字');
    const telegramEnabled = telegramParts.length === 3;
    const originCount = validateOrigins(env.CORS_ORIGIN || '', errors);
    const userCount = allowedUserCount(env.TELEGRAM_ALLOWED_USER_IDS || '', errors);

    if (numbers.CHUNK_GLOBAL_BUDGET_GB < numbers.MAX_CHUNK_UPLOAD_GB) {
        errors.push('CHUNK_GLOBAL_BUDGET_GB 不能小于 MAX_CHUNK_UPLOAD_GB');
    }
    if (errors.length > 0) throw new Error(`运行配置无效：\n- ${errors.join('\n- ')}`);

    return {
        server: {
            nodeEnv: env.NODE_ENV || 'development',
            port: numbers.PORT,
            trustProxy: env.TRUST_PROXY || 'loopback',
            corsOriginCount: originCount,
            jsonBodyLimit,
        },
        upload: {
            chunkMiB: numbers.MAX_UPLOAD_CHUNK_MB,
            maxUploadGiB: numbers.MAX_CHUNK_UPLOAD_GB,
            globalBudgetGiB: numbers.CHUNK_GLOBAL_BUDGET_GB,
            diskReserveGiB: numbers.CHUNK_DISK_RESERVE_GB,
            maxChunks: numbers.MAX_TOTAL_CHUNKS,
            sessionTtlMs: numbers.CHUNK_SESSION_TTL_MS,
            duplicateMode,
            autoCleanup,
        },
        logging: {
            level: env.LOG_LEVEL || 'info',
            sqlSlowMs: numbers.SQL_LOG_SLOW_MS,
            sqlAll: env.SQL_LOG_ALL === 'true',
        },
        telegram: {
            enabled: telegramEnabled,
            allowedUserCount: userCount,
            sourceAllowlistConfigured: configured(env, 'TELEGRAM_ALLOWED_SOURCES') || configured(env, 'TELEGRAM_SOURCE_ALLOWLIST'),
            userSessionPathConfigured: configured(env, 'TELEGRAM_USER_SESSION_FILE'),
            downloadWorkers: numbers.TELEGRAM_DOWNLOAD_WORKERS,
            fileConcurrency: numbers.TELEGRAM_FILE_DOWNLOAD_CONCURRENCY,
            subscriptionIntervalMs: numbers.TELEGRAM_SUBSCRIPTION_INTERVAL_MS,
            statusDebug: debugStatus,
        },
        ytdlp: {
            binary: env.YTDLP_BIN || 'yt-dlp',
            maxConcurrent: numbers.YTDLP_MAX_CONCURRENT,
            workDir: env.YTDLP_WORK_DIR || './data/uploads/ytdlp',
        },
        storage: {
            webdavInactivityTimeoutMs: numbers.WEBDAV_INACTIVITY_TIMEOUT_MS,
            webdavUploadTimeoutMs: numbers.WEBDAV_UPLOAD_TIMEOUT_MS,
            allowInsecureEndpoints,
        },
        security: {
            cookieSecure,
            sessionSecretSource: configured(env, 'SESSION_SECRET') ? 'environment' : 'persistent-file',
            storageCredentialsSecretSource: configured(env, 'STORAGE_CREDENTIALS_SECRET') ? 'environment' : 'persistent-file',
            totpFallbackConfigured: configured(env, 'TOTP_SECRET'),
        },
    };
}

export function logRuntimeConfigSummary(summary: RuntimeConfigSummary): void {
    console.log(`[config] effective=${JSON.stringify(summary)}`);
}

