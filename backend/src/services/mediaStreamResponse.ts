import type { Request, Response } from 'express';
import type { Readable } from 'node:stream';
import { classifyMediaProxyError } from './mediaProxyError.js';
import { firstHeader, type CloudMediaResponseInput } from './cloudMediaResponse.js';

/** A failed media response must never become a second JSON response. */
export function sendMediaError(res: Response, error: unknown): void {
    const upstream = error as { code?: unknown; response?: { status?: unknown } } | null;
    const safeToken = (value: unknown) => typeof value === 'number' ? value
        : typeof value === 'string' && /^[A-Za-z0-9_ .-]{1,80}$/.test(value) ? value : undefined;
    console.error('[Media] request failed', {
        route: res.req?.route?.path,
        headersSent: res.headersSent,
        destroyed: res.destroyed,
        code: safeToken(upstream?.code),
        upstreamStatus: safeToken(upstream?.response?.status),
    });
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
        res.destroy();
        return;
    }
    // Headers may be staged even though no bytes have been written yet.
    for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Disposition', 'ETag', 'Content-Encoding']) {
        res.removeHeader(name);
    }
    res.set('Cache-Control', 'no-store');
    type RangeFailure = { cause?: unknown; status?: number; response?: { status?: number; headers?: CloudMediaResponseInput['upstreamHeaders'] } };
    let unsatisfiedRange = false;
    for (let current = error; current && typeof current === 'object'; current = (current as RangeFailure).cause) {
        const failure = current as RangeFailure;
        if ((failure.response?.status ?? failure.status) !== 416) continue;
        unsatisfiedRange = true;
        const contentRange = firstHeader(failure.response?.headers, 'content-range');
        if (contentRange && /^bytes \*\/\d+$/.test(contentRange)) res.set('Content-Range', contentRange);
    }
    if (unsatisfiedRange) {
        res.set('Accept-Ranges', 'bytes');
        res.status(416).end();
        return;
    }
    const response = classifyMediaProxyError(error);
    if (response.retryAfter) res.set('Retry-After', String(response.retryAfter));
    res.status(response.status).json({
        code: response.code,
        error: response.error,
        ...(response.reason ? { reason: response.reason } : {}),
    });
}

/** Unlike pipeline(source, res), preserve an uncommitted HTTP response on source failure. */
export async function streamMediaResponse(req: Request, res: Response, source: Readable): Promise<void> {
    if (req.aborted || res.destroyed || res.writableEnded) {
        source.destroy();
        return;
    }
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error) => {
            if (settled) return;
            settled = true;
            source.unpipe(res);
            req.off('aborted', onAbort);
            res.off('close', onAbort);
            res.off('finish', onFinish);
            res.off('error', onError);
            source.off('close', onSourceClose);
            // Keep the error listener through destroy/late provider errors.
            source.destroy();
            if (error) reject(error);
            else resolve();
        };
        const onError = (error: Error) => settle(error);
        const onAbort = () => { settle(); if (!res.destroyed) res.destroy(); };
        const onFinish = () => settle();
        const onSourceClose = () => {
            if (!source.readableEnded) settle(new Error('Media source closed before completion'));
        };
        source.on('error', onError);
        source.once('close', onSourceClose);
        req.once('aborted', onAbort);
        res.once('close', onAbort);
        res.once('finish', onFinish);
        res.once('error', onError);
        source.pipe(res);
    });
}
