import { tr } from '../i18n/runtime';

export type ApiActionErrorKind = 'unauthorized' | 'rate_limited' | 'source_deleted' | 'unavailable' | 'generic';
interface ApiErrorPayload { error?: unknown; message?: unknown; code?: unknown }

const appendRequestId = (message: string, requestId?: string) => requestId ? tr('errors.services.generic.requestId', { message, requestId }) : message;
const parseRetryAfter = (value: string | null, now: number): number | undefined => {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const retryAt = Date.parse(value);
    return Number.isFinite(retryAt) ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : undefined;
};
export const formatRetryAfter = (seconds?: number): string | null => {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
    const rounded = Math.ceil(seconds);
    const minutes = Math.floor(rounded / 60), rest = rounded % 60;
    return minutes && rest
        ? tr('errors.services.generic.durationMinutesSeconds', { minutes, seconds: rest })
        : minutes
            ? tr('errors.services.generic.durationMinutes', { minutes })
            : tr('errors.services.generic.durationSeconds', { seconds: rest });
};

export class ApiActionError extends Error {
    readonly kind: ApiActionErrorKind;
    readonly status: number;
    readonly code?: string;
    readonly requestId?: string;
    readonly retryAfterSeconds?: number;
    constructor(options: { kind: ApiActionErrorKind; status: number; message: string; code?: string; requestId?: string; retryAfterSeconds?: number }) {
        super(options.message); this.name = 'ApiActionError'; Object.assign(this, options);
        this.kind = options.kind; this.status = options.status;
    }
}

export function isUnauthorizedError(error: unknown): error is ApiActionError {
    return error instanceof ApiActionError && error.kind === 'unauthorized';
}

export async function apiActionErrorFromResponse(response: Response, fallback: string, now = Date.now()): Promise<ApiActionError> {
    const payload = await response.json().catch(() => ({})) as ApiErrorPayload;
    const code = typeof payload.code === 'string' ? payload.code : undefined;
    const requestId = response.headers.get('X-Request-Id') || undefined;
    if (response.status === 401 || response.status === 428) return new ApiActionError({ kind: 'unauthorized', status: response.status, message: tr('errors.services.generic.sessionExpired'), code, requestId });
    if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'), now);
        const retry = formatRetryAfter(retryAfterSeconds);
        return new ApiActionError({ kind: 'rate_limited', status: 429, retryAfterSeconds, code, requestId, message: appendRequestId(retry ? tr('errors.services.generic.rateLimitedRetry', { duration: retry }) : tr('errors.services.generic.rateLimited'), requestId) });
    }
    if (response.status === 410 || code === 'MEDIA_SOURCE_MISSING') return new ApiActionError({ kind: 'source_deleted', status: response.status, code, requestId, message: appendRequestId(tr('errors.services.generic.sourceMissing'), requestId) });
    if (response.status === 503) return new ApiActionError({ kind: 'unavailable', status: 503, code, requestId, message: appendRequestId(tr('errors.services.generic.unavailable'), requestId) });
    const serverMessage = typeof payload.error === 'string' ? payload.error : typeof payload.message === 'string' ? payload.message : fallback;
    const statusMessage = response.status >= 500
        ? tr('errors.services.generic.serverStatus', { status: response.status })
        : serverMessage || fallback;
    return new ApiActionError({ kind: response.status >= 500 ? 'unavailable' : 'generic', status: response.status, code, requestId, message: appendRequestId(statusMessage, requestId) });
}

export function describeActionFailure(action: string, error: unknown): string {
    if (error instanceof ApiActionError) return error.kind === 'unauthorized'
        ? tr('errors.services.generic.actionAfterSignIn', { action })
        : tr('errors.services.generic.actionFailedWithDetail', { action, detail: error.message });
    if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) return tr('errors.services.generic.clipboardPermission', { action });
    return error instanceof Error && error.message
        ? tr('errors.services.generic.actionFailedWithDetail', { action, detail: error.message })
        : tr('errors.services.generic.actionFailed', { action });
}
