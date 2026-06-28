import { API_BASE } from './config';

const TOKEN_KEY = 'flclouds_token';
const TOKEN_EXPIRY_KEY = 'flclouds_token_expiry';

class AuthService {
    private token: string | null = null;

    constructor() {
        // 从 localStorage 恢复 token
        this.token = localStorage.getItem(TOKEN_KEY);
        const expiry = localStorage.getItem(TOKEN_EXPIRY_KEY);

        // 检查是否过期
        if (expiry && new Date() > new Date(expiry)) {
            this.clearToken();
        }
    }

    getToken(): string | null {
        return this.token;
    }

    setToken(token: string, expiresAt: string) {
        this.token = token;
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(TOKEN_EXPIRY_KEY, expiresAt);
    }

    clearToken() {
        this.token = null;
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_EXPIRY_KEY);
    }

    isAuthenticated(): boolean {
        if (!this.token) return false;

        const expiry = localStorage.getItem(TOKEN_EXPIRY_KEY);
        if (expiry && new Date() > new Date(expiry)) {
            this.clearToken();
            return false;
        }

        return true;
    }

    // 获取认证头
    getAuthHeaders(): HeadersInit {
        if (this.token) {
            return { 'Authorization': `Bearer ${this.token}` };
        }
        return {};
    }

    // 检查是否需要密码
    async checkPasswordRequired(): Promise<boolean> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/status`);
            if (!response.ok) return true;
            const data = await response.json();
            return data.passwordRequired !== false;
        } catch {
            return true;
        }
    }

    // 登录
    async login(password: string): Promise<{ success: boolean; error?: string; requiresTOTP?: boolean }> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/login`, {
                credentials: 'include',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });

            const data = await response.json();

            if (!response.ok) {
                return { success: false, error: data.error || '登录失败' };
            }

            if (data.requiresTOTP) {
                return { success: true, requiresTOTP: true };
            }

            this.setToken(data.token, data.expiresAt);
            return { success: true };
        } catch (error) {
            return { success: false, error: '网络错误' };
        }
    }

    // 验证 TOTP
    async verifyTOTP(password: string, totpToken: string): Promise<{ success: boolean; error?: string }> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/verify-totp`, {
                credentials: 'include',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password, totpToken }),
            });

            const data = await response.json();

            if (!response.ok) {
                return { success: false, error: data.error || '验证失败' };
            }

            this.setToken(data.token, data.expiresAt);
            return { success: true };
        } catch (error) {
            return { success: false, error: '网络错误' };
        }
    }

    // 验证 Token
    async verify(): Promise<boolean> {
        if (!this.token) return false;

        try {
            const response = await fetch(`${API_BASE}/api/auth/verify`, {
                credentials: 'include',
                headers: this.getAuthHeaders(),
            });

            if (!response.ok) {
                this.clearToken();
                return false;
            }

            return true;
        } catch {
            return false;
        }
    }

    // 登出
    async logout(): Promise<void> {
        try {
            await fetch(`${API_BASE}/api/auth/logout`, {
                credentials: 'include',
                method: 'POST',
                headers: this.getAuthHeaders(),
            });
        } catch {
            // 忽略错误
        }
        this.clearToken();
    }

    // 获取 2FA 设置信息
    async get2FASetupInfo(): Promise<{ qrDataUrl: string; enabled: boolean }> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/2fa-setup`, {
                credentials: 'include',
                headers: this.getAuthHeaders(),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || '获取 2FA 信息失败');
            }

            return await response.json();
        } catch (error: any) {
            throw new Error(error.message || '网络错误');
        }
    }

    // 激活 2FA
    async activate2FA(totpToken: string): Promise<{ success: boolean; error?: string }> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/2fa-activate`, {
                credentials: 'include',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this.getAuthHeaders()
                },
                body: JSON.stringify({ totpToken }),
            });

            const data = await response.json();
            if (!response.ok) {
                return { success: false, error: data.error || '激活失败' };
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: '网络错误' };
        }
    }

    // 禁用 2FA
    async disable2FA(password: string): Promise<{ success: boolean; error?: string }> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/2fa-disable`, {
                credentials: 'include',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this.getAuthHeaders()
                },
                body: JSON.stringify({ password }),
            });

            const data = await response.json();
            if (!response.ok) {
                return { success: false, error: data.error || '禁用失败' };
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: '网络错误' };
        }
    }
}

export const authService = new AuthService();
export default authService;
