import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { SESSION_SECRET } from '../utils/config.js';
import { requireAuth } from '../routes/auth.js';

export type SignedUrlType = 'preview' | 'thumbnail' | 'download';

const SIGNED_URL_TYPES = new Set<SignedUrlType>(['preview', 'thumbnail', 'download']);

function normalizeSignedUrlType(value: string | undefined): SignedUrlType | null {
    if (!value) return null;
    return SIGNED_URL_TYPES.has(value as SignedUrlType) ? value as SignedUrlType : null;
}

function getSignedUrlRouteParts(req: Request): { id?: string; type: SignedUrlType | null } {
    let id = req.params.id;
    let type = normalizeSignedUrlType((req.params as Record<string, string | undefined>).type);

    // Middleware is mounted on /api/files before route params are available, so parse the path.
    const match = req.path.match(/^\/?([^\/]+)\/(preview|thumbnail|download)(?:\/|$)/);
    if (match) {
        id = id || match[1];
        type = type || normalizeSignedUrlType(match[2]);
    }

    return { id, type };
}

// 生成签名
export function generateSignature(fileId: string, type: SignedUrlType, expires: number): string {
    const data = `${fileId}:${type}:${expires}`;
    return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
}

// 生成签名的 URL helper
export function getSignedUrl(fileId: string, type: SignedUrlType, expiresIn: number = 24 * 60 * 60) {
    const expires = Date.now() + (expiresIn * 1000);
    const sign = generateSignature(fileId, type, expires);
    return `/api/files/${fileId}/${type}?sign=${sign}&expires=${expires}`;
}

// 验证签名中间件
export function verifySignedUrl(req: Request): boolean {
    const sign = req.query.sign;
    const expires = req.query.expires;
    const { id, type } = getSignedUrlRouteParts(req);

    if (typeof sign !== 'string' || typeof expires !== 'string' || typeof id !== 'string' || !type) {
        console.log('[SignedURL] Missing or invalid params:', { sign, expires, id, type });
        return false;
    }

    const expiresTimestamp = parseInt(expires, 10);
    if (isNaN(expiresTimestamp)) {
        console.log('[SignedURL] Invalid timestamp:', expires);
        return false;
    }

    // 检查过期
    if (Date.now() > expiresTimestamp) {
        console.log('[SignedURL] Expired signature:', { now: Date.now(), expires: expiresTimestamp });
        return false;
    }

    // 验证签名
    const expectedSign = generateSignature(id, type, expiresTimestamp);
    try {
        const received = Buffer.from(sign, 'hex');
        const expected = Buffer.from(expectedSign, 'hex');
        if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
            console.log('[SignedURL] Signature mismatch:', { id, type });
            return false;
        }
    } catch {
        return false;
    }

    return true;
}

// 组合中间件：优先检查标准 Auth，如果失败则检查签名
export function requireAuthOrSignedUrl(req: Request, res: Response, next: NextFunction) {
    // 1. 尝试验证签名 (仅针对 GET 请求，且有签名参数的情况)
    if (req.method === 'GET' && req.query.sign && req.query.expires) {
        if (verifySignedUrl(req)) {
            return next();
        }
    }

    // 2. 如果签名无效或没有签名，回退到标准 Auth
    return requireAuth(req, res, next);
}
