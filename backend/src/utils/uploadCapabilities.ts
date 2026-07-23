const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

export const SIMPLE_UPLOAD_THRESHOLD_BYTES = 40 * MIB;
export const SIMPLE_UPLOAD_MAX_BYTES = 2 * GIB;

export interface UploadCapabilities {
    acceptsAnyFile: true;
    simpleUploadThresholdBytes: number;
    simpleUploadMaxBytes: number;
    chunkBytes: number;
    maxChunkUploadBytes: number;
    globalSessionBudgetBytes: number;
    maxChunks: number;
    sessionTtlMs: number;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const value = Number(env[name] || fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function buildUploadCapabilities(env: NodeJS.ProcessEnv = process.env): UploadCapabilities {
    return {
        acceptsAnyFile: true,
        simpleUploadThresholdBytes: SIMPLE_UPLOAD_THRESHOLD_BYTES,
        simpleUploadMaxBytes: SIMPLE_UPLOAD_MAX_BYTES,
        chunkBytes: int(env, 'MAX_UPLOAD_CHUNK_MB', 32) * MIB,
        maxChunkUploadBytes: int(env, 'MAX_CHUNK_UPLOAD_GB', 20) * GIB,
        globalSessionBudgetBytes: int(env, 'CHUNK_GLOBAL_BUDGET_GB', 40) * GIB,
        maxChunks: int(env, 'MAX_TOTAL_CHUNKS', 50_000),
        sessionTtlMs: int(env, 'CHUNK_SESSION_TTL_MS', 86_400_000),
    };
}
