const getApiBase = () => {
    // The container writes this before startup; a missing/static bootstrap falls back to Vite.
    const runtime = (globalThis as typeof globalThis & {
        __TG_VAULT_CONFIG__?: { API_URL?: string };
    }).__TG_VAULT_CONFIG__;
    if (typeof runtime?.API_URL === 'string') {
        return normalizeApiBase(runtime.API_URL);
    }

    // import.meta.env is injected by Vite; Node-based unit tests intentionally have no env object.
    const env = (import.meta as ImportMeta & { env?: { VITE_API_URL?: string; PROD?: boolean } }).env;
    const envUrl = env?.VITE_API_URL?.trim();
    if (envUrl) {
        return normalizeApiBase(envUrl);
    }

    // 如果在生产环境且没有配置，fallback 到相对路径（同域代理模式）
    if (env?.PROD) {
        return '';
    }
    return 'http://localhost:51947';
};

export function normalizeApiBase(value: string): string {
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    // API callers append /api/... themselves. Accept both an origin and a
    // mistakenly supplied origin/api without ever producing /api/api.
    return trimmed.replace(/\/api$/i, '');
}

export const API_BASE = getApiBase();
console.log('🚀 TG Vault API_BASE:', API_BASE || '(relative path)');
