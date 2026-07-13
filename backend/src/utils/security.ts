import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { getSetting, setSetting } from './settings.js';
import { SESSION_SECRET } from './config.js';


function totpEncryptionKey(): Buffer {
    return crypto.createHash('sha256').update(SESSION_SECRET).digest();
}

function encryptSecret(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', totpEncryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptSecret(value: string): string {
    if (!value.startsWith('enc:v1:')) return value;
    const [, , ivText, tagText, cipherText] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', totpEncryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8');
}

async function setTOTPSecret(secret: string): Promise<void> {
    await setSetting('totp_secret', encryptSecret(secret));
}

// 初始化 TOTP 实例
const authenticator = new TOTP({
    crypto: new NobleCryptoPlugin(),
    base32: new ScureBase32Plugin(),
});

/**
 * 获取 TOTP 密钥
 * 优先级：环境变量 > 数据库
 */
async function getTOTPSecret(): Promise<string | null> {
    // 1. 检查环境变量
    if (process.env.TOTP_SECRET) {
        return process.env.TOTP_SECRET;
    }

    // 2. 检查数据库
    const stored = await getSetting('totp_secret');
    if (!stored) return null;
    try {
        const secret = decryptSecret(stored);
        if (!stored.startsWith('enc:v1:')) {
            await setTOTPSecret(secret);
        }
        return secret;
    } catch (error) {
        console.error('TOTP 密钥解密失败:', error);
        return null;
    }
}

export interface TwoFactorReadiness {
    enabled: boolean;
    ready: boolean;
    error?: 'enabled-but-unreadable';
}

export async function get2FAReadiness(): Promise<TwoFactorReadiness> {
    const enabled = await getSetting('2fa_enabled', 'false') === 'true';
    if (!enabled) return { enabled: false, ready: true };
    const secret = await getTOTPSecret();
    return secret
        ? { enabled: true, ready: true }
        : { enabled: true, ready: false, error: 'enabled-but-unreadable' };
}

/**
 * 检查是否启用了 2FA
 */
export async function is2FAEnabled(): Promise<boolean> {
    const readiness = await get2FAReadiness();
    if (!readiness.ready) throw new Error('2FA 已启用，但密钥不可读取；为防止认证降级，登录已被阻止');
    return readiness.enabled;
}

/**
 * 激活 2FA
 */
export async function activate2FA(): Promise<void> {
    await setSetting('2fa_enabled', 'true');
}

/**
 * 禁用 2FA
 */
export async function disable2FA(): Promise<void> {
    await setSetting('2fa_enabled', 'false');
}

/**
 * 验证 TOTP 令牌
 */
export async function verifyTOTP(token: string): Promise<boolean> {
    const enabled = await getSetting('2fa_enabled', 'false');
    const secret = await getTOTPSecret();
    if (enabled !== 'true') {
        // Verification is only meaningful during setup when a freshly generated secret exists.
        if (!secret) return false;
    } else if (!secret) {
        throw new Error('2FA 已启用，但密钥不可读取；拒绝降级认证');
    }

    try {
        const result = await authenticator.verify(token, {
            secret: secret
        });
        return result.valid;
    } catch (e) {
        console.error('TOTP 验证失败:', e);
        return false;
    }
}

/**
 * 生成 TOTP 设置用的二维码
 * 如果密钥不存在，或者格式不正确，则重新生成并保存到数据库
 */
export async function generateOTPAuthUrl(user: string = 'Admin'): Promise<string> {
    let secret = await getTOTPSecret();

    // 检查密钥是否存在，或者是否看起来像旧的 Hex 格式 (Hex 只有 0-9, A-F)
    // 标准 Base32 包含 A-Z, 2-7。如果密钥长度是 32 位且只包含 Hex 字符，很有可能是旧的错误格式。
    const isMalformed = secret && secret.length === 32 && /^[0-9A-F]+$/.test(secret);

    if (!secret || isMalformed) {
        // 使用 otplib 生成标准 Base32 密钥 (通常为 16 或 32 个字符)
        secret = authenticator.generateSecret();
        await setTOTPSecret(secret);
        console.log('✅ 已为系统自动生成标准 Base32 2FA 密钥并存入数据库');
    }

    const otpauth = authenticator.toURI({
        label: user,
        issuer: 'TG Vault',
        secret: secret
    });

    return await QRCode.toDataURL(otpauth);
}

/**
 * 获取客户端真实 IP 地址
 * 优先读取 Cloudflare 的真实 IP 头，其次读取标准代理头 x-forwarded-for
 */
export function getClientIP(req: any): string {
    // Only trust Express' proxy-aware req.ip. app.set('trust proxy', ...) controls which
    // proxy headers are accepted, so direct clients cannot spoof x-forwarded-for here.
    return req.ip || req.socket?.remoteAddress || '未知';
}
