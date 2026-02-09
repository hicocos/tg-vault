import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { SESSION_SECRET } from '../utils/config.js';
import { requireAuth } from '../routes/auth.js';

// 生成签名
export function generateSignature(fileId: string, expires: number): string {
    const data = `${fileId}:${expires}:${SESSION_SECRET}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

// 验证签名中间件
export function verifySignedUrl(req: Request): boolean {
    const sign = req.query.sign;
    const expires = req.query.expires;
    let id = req.params.id;

    // 如果 middleware 挂载在 /api/files，req.params 可能为空，需要从 path 解析 ID
    if (!id) {
        // req.path 类似于 "/<id>/preview" 或 "/<id>"
        // 匹配第一个路径段作为 ID
        const match = req.path.match(/^\/?([^\/]+)/);
        if (match) {
            id = match[1];
        } else {
            console.log('[SignedURL] Failed to extract ID from path:', req.path);
        }
    }

    if (typeof sign !== 'string' || typeof expires !== 'string' || typeof id !== 'string') {
        console.log('[SignedURL] Missing or invalid params:', { sign, expires, id });
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
    const expectedSign = generateSignature(id, expiresTimestamp);
    if (sign !== expectedSign) {
        console.log('[SignedURL] Signature mismatch:', { id, received: sign, expected: expectedSign });
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
