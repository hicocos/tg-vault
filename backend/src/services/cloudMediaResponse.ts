export interface CloudMediaResponseInput {
    upstreamStatus?: number;
    upstreamHeaders?: Record<string, string | number | string[] | undefined> | { get(name: string): unknown };
    requestedRange?: string;
}

export interface CloudMediaResponse {
    status: number;
    headers: Record<string, string>;
}

function firstHeader(headers: CloudMediaResponseInput['upstreamHeaders'], name: string): string | undefined {
    if (!headers) return undefined;
    const getter = (headers as { get?: (headerName: string) => unknown }).get;
    const value = typeof getter === 'function'
        ? getter.call(headers, name)
        : (headers as Record<string, string | number | string[] | undefined>)[name]
            ?? (headers as Record<string, string | number | string[] | undefined>)[name.toLowerCase()]
            ?? (headers as Record<string, string | number | string[] | undefined>)[name.toUpperCase()];
    if (Array.isArray(value)) return value[0];
    return value === undefined || value === null ? undefined : String(value);
}

export function buildCloudMediaResponse(input: CloudMediaResponseInput): CloudMediaResponse {
    const upstreamStatus = input.upstreamStatus === 206 ? 206 : 200;
    const contentRange = firstHeader(input.upstreamHeaders, 'content-range');
    const contentLength = firstHeader(input.upstreamHeaders, 'content-length');
    const acceptRanges = firstHeader(input.upstreamHeaders, 'accept-ranges');
    const status = upstreamStatus === 206 && contentRange ? 206 : 200;
    const headers: Record<string, string> = {
        'Accept-Ranges': acceptRanges || 'bytes',
    };
    if (contentRange && status === 206) headers['Content-Range'] = contentRange;
    if (contentLength) headers['Content-Length'] = contentLength;
    return { status, headers };
}
