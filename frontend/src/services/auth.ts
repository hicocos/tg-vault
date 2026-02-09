const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:51947';

const TOKEN_KEY = 'foomclous_token';
const TOKEN_EXPIRY_KEY = 'foomclous_token_expiry';

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
            const data = await response.json();
            return data.passwordRequired;
        } catch {
            return false;
        }
    }

    // 登录
    async login(password: string): Promise<{ success: boolean; error?: string }> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });

            const data = await response.json();

            if (!response.ok) {
                return { success: false, error: data.error || '登录失败' };
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
                method: 'POST',
                headers: this.getAuthHeaders(),
            });
        } catch {
            // 忽略错误
        }
        this.clearToken();
    }
}

export const authService = new AuthService();
export default authService;
