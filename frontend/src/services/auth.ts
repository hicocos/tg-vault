import { API_BASE } from './config';
import { tr } from '../i18n/runtime';

export interface AuthStatus {
    setupRequired: boolean;
    passwordRequired: boolean;
    telegramPinRequired: boolean;
}

export const AUTH_SESSION_INVALIDATED_EVENT = 'tgvault:auth-session-invalidated';

export interface AuthSessionInvalidatedDetail {
    status: number;
}

class AuthService {
    private invalidateForAuthStatus(response: Response): boolean {
        if (response.status !== 401 && response.status !== 428) return false;
        this.invalidateSession(response.status);
        return true;
    }

    constructor() {
        // Cookie-only auth: clear legacy localStorage tokens if present.
        this.clearToken();
    }

    getToken(): string | null {
        return null;
    }

    setToken() {
        // Authentication is stored only in the HttpOnly tg_vault_token cookie.
    }

    clearToken() {
        localStorage.removeItem('tg_vault_token');
        localStorage.removeItem('tg_vault_token_expiry');
    }

    invalidateSession(status: number) {
        this.clearToken();
        window.dispatchEvent(new CustomEvent<AuthSessionInvalidatedDetail>(AUTH_SESSION_INVALIDATED_EVENT, { detail: { status } }));
    }

    onSessionInvalidated(listener: (detail: AuthSessionInvalidatedDetail) => void): () => void {
        const handle = (event: Event) => listener((event as CustomEvent<AuthSessionInvalidatedDetail>).detail);
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, handle);
        return () => window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, handle);
    }

    isAuthenticated(): boolean {
        // The backend /verify endpoint is the source of truth for the HttpOnly cookie.
        return true;
    }
    // 获取认证头
    getAuthHeaders(): HeadersInit {
        return {};
    }

    // 获取认证初始化状态
    async getAuthStatus(): Promise<AuthStatus> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/status`);
            if (!response.ok) return { setupRequired: false, passwordRequired: true, telegramPinRequired: false };
            const data = await response.json();
            return {
                setupRequired: data.setupRequired === true,
                passwordRequired: data.passwordRequired !== false,
                telegramPinRequired: data.telegramPinRequired === true,
            };
        } catch {
            return { setupRequired: false, passwordRequired: true, telegramPinRequired: false };
        }
    }

    // 兼容旧调用：检查是否需要密码
    async checkPasswordRequired(): Promise<boolean> {
        const status = await this.getAuthStatus();
        return status.passwordRequired;
    }

    // 首次启动创建唯一管理员凭证
    async setup(webPassword: string, telegramPin?: string): Promise<{ success: boolean; error?: string }> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/setup`, {
                credentials: 'include',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ webPassword, telegramPin }),
            });

            const data = await response.json();
            if (!response.ok) {
                return { success: false, error: data.error || tr('errors.services.auth.setupFailed') };
            }

            this.setToken();
            return { success: true };
        } catch {
            return { success: false, error: tr('errors.services.generic.network') };
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
                return { success: false, error: data.error || tr('errors.services.auth.loginFailed') };
            }

            if (data.requiresTOTP) {
                return { success: true, requiresTOTP: true };
            }

            this.setToken();
            return { success: true };
        } catch {
            return { success: false, error: tr('errors.services.generic.network') };
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
                return { success: false, error: data.error || tr('errors.services.auth.verificationFailed') };
            }

            this.setToken();
            return { success: true };
        } catch {
            return { success: false, error: tr('errors.services.generic.network') };
        }
    }

    // 验证 Token
    async verify(): Promise<boolean> {
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

    async changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/change-password`, {
                credentials: 'include',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
                body: JSON.stringify({ currentPassword, newPassword }),
            });
            const data = await response.json().catch(() => ({}));
            if (this.invalidateForAuthStatus(response)) return { success: false, error: tr('errors.services.generic.sessionExpired') };
            if (!response.ok) return { success: false, error: data.error || tr('errors.services.auth.changePasswordFailed') };
            this.clearToken();
            return { success: true };
        } catch {
            return { success: false, error: tr('errors.services.generic.network') };
        }
    }

    async revokeAllSessions(): Promise<{ success: boolean; error?: string }> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/revoke-all`, {
                credentials: 'include',
                method: 'POST',
                headers: this.getAuthHeaders(),
            });
            const data = await response.json().catch(() => ({}));
            if (this.invalidateForAuthStatus(response)) return { success: false, error: tr('errors.services.generic.sessionExpired') };
            if (!response.ok) return { success: false, error: data.error || tr('errors.services.auth.revokeSessionsFailed') };
            this.clearToken();
            return { success: true };
        } catch {
            return { success: false, error: tr('errors.services.generic.network') };
        }
    }

    // 获取 2FA 设置信息
    async get2FASetupInfo(): Promise<{ qrDataUrl: string; enabled: boolean }> {
        try {
            const response = await fetch(`${API_BASE}/api/auth/2fa-setup`, {
                credentials: 'include',
                headers: this.getAuthHeaders(),
            });

            if (!response.ok) {
                if (this.invalidateForAuthStatus(response)) throw new Error(tr('errors.services.generic.sessionExpired'));
                const data = await response.json();
                throw new Error(data.error || tr('errors.services.auth.getTwoFactorInfoFailed'));
            }

            return await response.json();
        } catch (error: any) {
            throw new Error(error.message || tr('errors.services.generic.network'));
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
            if (this.invalidateForAuthStatus(response)) return { success: false, error: tr('errors.services.generic.sessionExpired') };
            if (!response.ok) {
                return { success: false, error: data.error || tr('errors.services.auth.activateTwoFactorFailed') };
            }

            return { success: true };
        } catch {
            return { success: false, error: tr('errors.services.generic.network') };
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
            if (this.invalidateForAuthStatus(response)) return { success: false, error: tr('errors.services.generic.sessionExpired') };
            if (!response.ok) {
                return { success: false, error: data.error || tr('errors.services.auth.disableTwoFactorFailed') };
            }

            return { success: true };
        } catch {
            return { success: false, error: tr('errors.services.generic.network') };
        }
    }
}

export const authService = new AuthService();
export default authService;
