export type MediaSourceMissingReason = 'not_found' | 'trashed';

export class MediaSourceMissingError extends Error {
    constructor(public readonly reason: MediaSourceMissingReason) {
        super(reason === 'trashed' ? 'Remote media source is trashed' : 'Remote media source was not found');
        this.name = 'MediaSourceMissingError';
    }
}

export interface MediaProxyErrorResponse {
    status: number;
    code: 'MEDIA_SOURCE_MISSING' | 'MEDIA_QUOTA_EXCEEDED' | 'MEDIA_RATE_LIMITED' | 'MEDIA_UPSTREAM_UNAVAILABLE';
    error: string;
    reason?: MediaSourceMissingReason;
    retryAfter?: number;
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

export function classifyMediaProxyError(error: unknown): MediaProxyErrorResponse {
    if (error instanceof MediaSourceMissingError) {
        return {
            status: 410,
            code: 'MEDIA_SOURCE_MISSING',
            error: '云盘中的源文件已删除或已移入回收站。',
            reason: error.reason,
        };
    }

    const text = errorText(error).toLowerCase();

    if (text.includes('downloadquotaexceeded') || text.includes('download quota')) {
        return {
            status: 429,
            code: 'MEDIA_QUOTA_EXCEEDED',
            error: '云端文件下载额度已用完，请稍后重试或改用其他存储。',
            retryAfter: 3600,
        };
    }

    if (text.includes('ratelimit') || text.includes('rate limit') || text.includes('too many requests')) {
        return {
            status: 429,
            code: 'MEDIA_RATE_LIMITED',
            error: '云端存储请求过于频繁，请稍后重试。',
            retryAfter: 60,
        };
    }

    return {
        status: 503,
        code: 'MEDIA_UPSTREAM_UNAVAILABLE',
        error: '云端媒体暂时无法读取，请稍后重试。',
    };
}
