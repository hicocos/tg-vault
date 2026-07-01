import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ACCESS_PASSWORD_HASH, SESSION_SECRET, TOKEN_EXPIRY } from '../utils/config.js';
import { generateSignature, type SignedUrlType } from '../middleware/signedUrl.js';
import { rateLimit } from 'express-rate-limit';
import { is2FAEnabled, verifyTOTP, generateOTPAuthUrl, activate2FA, disable2FA, getClientIP } from '../utils/security.js';
import { UAParser } from 'ua-parser-js';
import axios from 'axios';
import { sendSecurityNotification } from '../services/telegramBot.js';

// 导入可能需要的辅助函数
async function getIPLocation(ip: string) {
    try {
        if (ip === '::1' || ip === '127.0.0.1') return '本地回环';
        const response = await axios.get(`http://ip-api.com/json/${ip}?lang=zh-CN`);
        if (response.data.status === 'success') {
            return `${response.data.country} ${response.data.regionName} ${response.data.city} (${response.data.isp})`;
        }
    } catch (e) {
        console.error('获取 IP 位置失败:', e);
    }
    return '未知位置';
}

async function sendLoginNotification(req: Request) {
    const ip = getClientIP(req);
    const ua = new UAParser(req.headers['user-agent']).getResult();
    const location = await getIPLocation(ip);
    const beijingTime = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    }).replace(/\//g, '-') + ' (中国/上海)';

    const message = `🔔 **安全登录提示**\n\n` +
        `👤 **账号**: 管理员\n` +
        `⏰ **时间**: ${beijingTime}\n` +
        `🌐 **地区**: ${location}\n` +
        `💻 **设备**: ${ua.browser.name || '未知'} ${ua.browser.version || ''} on ${ua.os.name || '未知'} ${ua.os.version || ''}\n` +
        `🔌 **IP地址**: ${ip}\n\n` +
        `💡 如果这不是您的操作，请立即检查服务器安全设置。`;

    // 发送安全通知
    await sendSecurityNotification(message);
}

const router = Router();
const SIGNED_URL_TYPES = new Set<SignedUrlType>(['preview', 'thumbnail', 'download']);

function normalizeSignedUrlType(value: unknown): SignedUrlType | null {
    if (typeof value !== 'string') return null;
    return SIGNED_URL_TYPES.has(value as SignedUrlType) ? value as SignedUrlType : null;
}

function getAuthToken(req: Request): string | undefined {
    const headerToken = req.headers['authorization']?.replace('Bearer ', '');
    if (headerToken) return headerToken;
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.split(';').map(v => v.trim()).find(v => v.startsWith('flclouds_token='));
    return match ? decodeURIComponent(match.slice('flclouds_token='.length)) : undefined;
}

function setAuthCookie(res: Response, token: string, expiresAt: Date) {
    res.cookie('flclouds_token', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        expires: expiresAt,
        path: '/',
    });
}

function clearAuthCookie(res: Response) {
    res.clearCookie('flclouds_token', { path: '/' });
}


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
    try {
        const input = Buffer.from(inputHash, 'hex');
        const expected = Buffer.from(ACCESS_PASSWORD_HASH, 'hex');
        return input.length === expected.length && crypto.timingSafeEqual(input, expected);
    } catch {
        return false;
    }
}

// 登录频率限制：15分钟内最多5次尝试
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: '尝试次数过多，请 15 分钟后再试' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => getClientIP(req),
});

// 登录接口
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ error: '请输入密码' });
    }

    if (!verifyPassword(password)) {
        return res.status(401).json({ error: '认证失败' });
    }

    // 检查是否启用了 2FA
    if (await is2FAEnabled()) {
        return res.json({
            success: true,
            requiresTOTP: true,
            // 暂时不生成完整 token，只在 TOTP 验证后返回
            message: '请输入二次验证码'
        });
    }

    const token = generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_EXPIRY);

    sessions.set(token, { createdAt: now, expiresAt });

    // 异步发送通知
    sendLoginNotification(req);

    setAuthCookie(res, token, expiresAt);
    res.json({
        success: true,
        token,
        expiresAt: expiresAt.toISOString(),
    });
});

// TOTP 验证接口
router.post('/verify-totp', loginLimiter, async (req: Request, res: Response) => {
    const { password, totpToken } = req.body;

    if (!password || !totpToken) {
        return res.status(400).json({ error: '参数不完整' });
    }

    // 再次验证密码（确保安全性）
    if (!verifyPassword(password)) {
        return res.status(401).json({ error: '认证失败' });
    }

    // 验证 TOTP
    if (!(await verifyTOTP(totpToken))) {
        return res.status(401).json({ error: '认证失败' });
    }

    const token = generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_EXPIRY);

    sessions.set(token, { createdAt: now, expiresAt });

    // 异步发送通知
    sendLoginNotification(req);

    setAuthCookie(res, token, expiresAt);
    res.json({
        success: true,
        token,
        expiresAt: expiresAt.toISOString(),
    });
});

// 获取 2FA 设置二维码 (需要认证)
router.get('/2fa-setup', requireAuth, async (req: Request, res: Response) => {
    try {
        const qrDataUrl = await generateOTPAuthUrl();
        const enabled = await is2FAEnabled();
        res.json({ qrDataUrl, enabled });
    } catch (e) {
        console.error('生成 2FA 二维码失败:', e);
        res.status(500).json({ error: '生成二维码失败' });
    }
});

// 激活 2FA (需要认证)
router.post('/2fa-activate', requireAuth, async (req: Request, res: Response) => {
    const { totpToken } = req.body;
    if (!totpToken) return res.status(400).json({ error: '请输入验证码' });

    try {
        if (await verifyTOTP(totpToken)) {
            await activate2FA();
            return res.json({ success: true, message: '2FA 已成功激活' });
        }
        res.status(401).json({ error: '验证码错误' });
    } catch (e) {
        console.error('激活 2FA 失败:', e);
        res.status(500).json({ error: '激活失败' });
    }
});

// 禁用 2FA (需要认证)
router.post('/2fa-disable', requireAuth, async (req: Request, res: Response) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: '请输入密码验证' });

    if (!verifyPassword(password)) {
        return res.status(401).json({ error: '认证失败' });
    }

    try {
        await disable2FA();
        res.json({ success: true, message: '2FA 已禁用' });
    } catch (e) {
        console.error('禁用 2FA 失败:', e);
        res.status(500).json({ error: '禁用失败' });
    }
});

// 验证 Token
router.get('/verify', (req: Request, res: Response) => {
    const token = getAuthToken(req);

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
    const token = getAuthToken(req);
    if (token) {
        sessions.delete(token);
    }
    clearAuthCookie(res);
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
    const { fileId, expiresIn = 300, type = 'preview' } = req.body; // 默认 5 分钟有效期

    if (!fileId) {
        return res.status(400).json({ error: '缺少 fileId' });
    }

    const signedType = normalizeSignedUrlType(type);
    if (!signedType) {
        return res.status(400).json({ error: '签名类型无效' });
    }

    const expiresInSeconds = Number(expiresIn);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
        return res.status(400).json({ error: '过期时间无效' });
    }

    const expires = Date.now() + (expiresInSeconds * 1000);
    const sign = generateSignature(fileId, signedType, expires);

    res.json({
        sign,
        expires,
        expiresIn: expiresInSeconds,
        type: signedType,
    });
});

// 认证中间件
export function requireAuth(req: Request, res: Response, next: NextFunction) {
    // 如果没有设置密码，跳过认证
    if (!ACCESS_PASSWORD_HASH) {
        return next();
    }

    // 优先从 Authorization header 获取 token
    let token = getAuthToken(req);

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
