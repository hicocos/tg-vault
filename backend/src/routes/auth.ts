import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ACCESS_PASSWORD_HASH, SESSION_SECRET, TOKEN_EXPIRY } from '../utils/config.js';
import { generateSignature } from '../middleware/signedUrl.js';

const router = Router();

// 简单的会话存储（生产环境建议用 Redis）
const sessions = new Map<string, { createdAt: Date; expiresAt: Date }>();

// 清理过期会话
setInterval(() => {
    const now = new Date();
    sessions.forEach((session, token) => {
        if (now > session.expiresAt) {
            sessions.delete(token);
        }
    });
}, 60 * 60 * 1000); // 每小时清理一次

// 生成密码哈希（用于配置）
export function hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// 生成会话 Token
function generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
}

// 验证密码
function verifyPassword(password: string): boolean {
    if (!ACCESS_PASSWORD_HASH) {
        // 如果没有设置密码，允许访问
        return true;
    }
    const inputHash = hashPassword(password);
    return inputHash === ACCESS_PASSWORD_HASH;
}

// 登录接口
router.post('/login', (req: Request, res: Response) => {
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ error: '请输入密码' });
    }

    if (!verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

    const token = generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_EXPIRY);

    sessions.set(token, { createdAt: now, expiresAt });

    res.json({
        success: true,
        token,
        expiresAt: expiresAt.toISOString(),
    });
});

// 验证 Token
router.get('/verify', (req: Request, res: Response) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ valid: false, error: '未提供 Token' });
    }

    const session = sessions.get(token);
    if (!session || new Date() > session.expiresAt) {
        sessions.delete(token || '');
        return res.status(401).json({ valid: false, error: 'Token 已过期' });
    }

    res.json({ valid: true });
});

// 登出接口
router.post('/logout', (req: Request, res: Response) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (token) {
        sessions.delete(token);
    }
    res.json({ success: true });
});

// 检查是否需要密码
router.get('/status', (_req: Request, res: Response) => {
    res.json({
        passwordRequired: !!ACCESS_PASSWORD_HASH,
    });
});

// 生成签名 URL (需要认证)
router.post('/sign-url', requireAuth, (req: Request, res: Response) => {
    const { fileId, expiresIn = 300 } = req.body; // 默认 5 分钟有效期

    if (!fileId) {
        return res.status(400).json({ error: '缺少 fileId' });
    }

    const expires = Date.now() + (expiresIn * 1000);
    const sign = generateSignature(fileId, expires);

    res.json({
        sign,
        expires,
        expiresIn
    });
});

// 认证中间件
export function requireAuth(req: Request, res: Response, next: NextFunction) {
    // 如果没有设置密码，跳过认证
    if (!ACCESS_PASSWORD_HASH) {
        return next();
    }

    // 优先从 Authorization header 获取 token
    let token = req.headers['authorization']?.replace('Bearer ', '');

    // [SECURITY] 移除从 URL 查询参数获取 Token 的逻辑
    // if (!token && req.query.token) {
    //     token = req.query.token as string;
    // }

    if (!token) {
        return res.status(401).json({ error: '未授权访问' });
    }

    const session = sessions.get(token);
    if (!session || new Date() > session.expiresAt) {
        sessions.delete(token);
        return res.status(401).json({ error: 'Token 已过期，请重新登录' });
    }

    next();
}

export default router;
