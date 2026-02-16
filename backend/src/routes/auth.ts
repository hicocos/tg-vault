import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ACCESS_PASSWORD_HASH, SESSION_SECRET, TOKEN_EXPIRY } from '../utils/config.js';
import { generateSignature } from '../middleware/signedUrl.js';
import { rateLimit } from 'express-rate-limit';
import { is2FAEnabled, verifyTOTP } from '../utils/security.js';
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

async function sendLoginNotification(req: Request, ip: string) {
    const ua = new UAParser(req.headers['user-agent']).getResult();
    const location = await getIPLocation(ip);
    const now = new Date();
    // 转换为北京时间 (UTC+8)
    const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString()
        .replace(/T/, ' ')
        .replace(/\..+/, '') + ' (CST)';

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

// 登录频率限制：15分钟内最多5次尝试
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: '尝试次数过多，请 15 分钟后再试' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
});

// 登录接口
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ error: '请输入密码' });
    }

    if (!verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

    // 检查是否启用了 2FA
    if (is2FAEnabled()) {
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
    sendLoginNotification(req, req.ip || '未知');

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
        return res.status(401).json({ error: '密码错误' });
    }

    // 验证 TOTP
    if (!(await verifyTOTP(totpToken))) {
        return res.status(401).json({ error: '验证码错误' });
    }

    const token = generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_EXPIRY);

    sessions.set(token, { createdAt: now, expiresAt });

    // 异步发送通知
    sendLoginNotification(req, req.ip || '未知');

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
