import { API_BASE } from './config';
import { tr } from '../i18n/runtime';
import { apiActionErrorFromResponse } from './apiActionError';
import { authService } from './auth';

export interface HttpRequestOptions extends RequestInit {
    acceptedStatuses?: readonly number[];
    fallback?: string;
    classifyErrors?: boolean;
}

function apiUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const normalizedBase = API_BASE.replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (normalizedBase && (normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`))) return normalizedPath;
    return `${normalizedBase}${normalizedPath}`;
}

function mergeHeaders(headers?: HeadersInit): Headers {
    const merged = new Headers(headers);
    if (!merged.has('Accept')) merged.set('Accept', 'application/json');
    return merged;
}

export async function apiRequest(path: string, options: HttpRequestOptions = {}): Promise<Response> {
    const { acceptedStatuses = [], fallback = tr('errors.services.generic.requestFailed'), classifyErrors = true, ...init } = options;
    const response = await fetch(apiUrl(path), {
        ...init,
        credentials: init.credentials ?? 'include',
        headers: mergeHeaders(init.headers),
    });
    const rejected = !response.ok && !acceptedStatuses.includes(response.status);
    // Cross-origin manual redirects are intentionally opaque in browsers (status 0).
    const opaqueManualRedirect = init.redirect === 'manual' && response.type === 'opaqueredirect';
    if (rejected && !opaqueManualRedirect && (classifyErrors || response.status === 401 || response.status === 428)) {
        const error = await apiActionErrorFromResponse(response, fallback);
        if (error.kind === 'unauthorized') authService.invalidateSession(error.status);
        throw error;
    }
    return response;
}

export async function apiJson<T>(path: string, options: HttpRequestOptions = {}): Promise<T> {
    const response = await apiRequest(path, options);
    return response.json() as Promise<T>;
}

export async function apiJsonOr<T>(path: string, fallbackValue: T, options: HttpRequestOptions = {}): Promise<T> {
    const response = await apiRequest(path, options);
    return response.json().catch(() => fallbackValue) as Promise<T>;
}
