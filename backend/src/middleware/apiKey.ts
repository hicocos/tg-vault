import { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { query } from '../db/index.js';

export interface ApiKeyInfo {
    id: string;
    name: string;
    permissions: string[];
}

declare global {
    namespace Express {
        interface Request {
            apiKeyInfo?: ApiKeyInfo;
        }
    }
}

export function hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
    try {
        const left = Buffer.from(a, 'hex');
        const right = Buffer.from(b, 'hex');
        return left.length === right.length && timingSafeEqual(left, right);
    } catch {
        return false;
    }
}

export const validateApiKey = async (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
        return res.status(401).json({
            error: 'API Key 必需',
            message: '请在请求头中添加 X-API-Key',
        });
    }

    try {
        const apiKeyHash = hashApiKey(apiKey);
        const result = await query(
            'SELECT id, name, permissions, key, key_hash FROM api_keys WHERE (key_hash = $1 OR key = $2) AND enabled = true',
            [apiKeyHash, apiKey]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({
                error: '无效的 API Key',
                message: 'API Key 不存在或已禁用',
            });
        }

        const keyInfo = result.rows[0];
        if (keyInfo.key_hash && !safeEqualHex(keyInfo.key_hash, apiKeyHash)) {
            return res.status(403).json({ error: '无效的 API Key', message: 'API Key 不存在或已禁用' });
        }
        if (!keyInfo.key_hash && keyInfo.key === apiKey) {
            await query('UPDATE api_keys SET key_hash = $1, key = $2 WHERE id = $3', [apiKeyHash, `legacy:${keyInfo.id}`, keyInfo.id]).catch(() => undefined);
        }
        await query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [keyInfo.id]).catch(() => undefined);
        req.apiKeyInfo = {
            id: keyInfo.id,
            name: keyInfo.name,
            permissions: keyInfo.permissions || ['upload'],
        };

        next();
    } catch (error) {
        console.error('验证 API Key 失败:', error);
        res.status(500).json({ error: '验证 API Key 失败' });
    }
};

export function requireApiKeyPermission(permission: string) {
    return (req: Request, res: Response, next: NextFunction) => {
        const permissions = req.apiKeyInfo?.permissions || [];
        if (!permissions.includes(permission)) {
            return res.status(403).json({ error: 'API Key 权限不足', requiredPermission: permission });
        }
        next();
    };
}

// 生成新的 API Key
export const generateApiKey = (): string => {
    return `fc_${randomBytes(36).toString('base64url')}`;
};
