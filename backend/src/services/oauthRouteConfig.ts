import type { OAuthProvider } from './oauthFlowStore.js';

const CALLBACK_PATHS: Record<OAuthProvider, string> = {
    onedrive: '/api/storage/onedrive/callback',
    google_drive: '/api/storage/google-drive/callback',
};

function exactOrigin(value: string, variable: string): string {
    if (!value || value === '*') throw new Error(`${variable} 必须配置为精确的 http(s) origin`);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${variable} 必须是有效 URL`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${variable} 必须使用 http(s)`);
    return url.origin;
}

export function getOAuthRouteConfig(
    provider: OAuthProvider,
    env: NodeJS.ProcessEnv = process.env,
): { redirectUri: string; frontendOrigin: string } {
    const callbackBase = env.OAUTH_CALLBACK_BASE_URL || env.VITE_API_URL || '';
    const frontendBase = env.OAUTH_FRONTEND_ORIGIN || env.CORS_ORIGIN?.split(',').map(value => value.trim()).find(Boolean) || '';
    if (!callbackBase) throw new Error('必须配置 OAUTH_CALLBACK_BASE_URL 或 VITE_API_URL 以固定 OAuth callback URI');
    const callbackOrigin = exactOrigin(callbackBase, 'OAUTH_CALLBACK_BASE_URL/VITE_API_URL');
    const frontendOrigin = exactOrigin(frontendBase, 'OAUTH_FRONTEND_ORIGIN/CORS_ORIGIN');
    return {
        redirectUri: `${callbackOrigin}${CALLBACK_PATHS[provider]}`,
        frontendOrigin,
    };
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char]!);
}

export function renderOAuthSuccessPage(input: {
    provider: OAuthProvider;
    providerName: string;
    frontendOrigin: string;
    flowNonce: string;
    accountId?: string;
    scriptNonce: string;
}): string {
    const message = JSON.stringify({
        type: 'oauth_success',
        provider: input.provider,
        flowNonce: input.flowNonce,
        accountId: input.accountId,
    }).replace(/</g, '\\u003c');
    const targetOrigin = JSON.stringify(input.frontendOrigin);
    const providerName = escapeHtml(input.providerName);
    const nonce = escapeHtml(input.scriptNonce);
    return `
        <!doctype html>
        <html lang="zh-CN">
            <head><meta charset="utf-8" /><title>${providerName} 授权成功</title></head>
            <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                <div style="text-align: center; padding: 40px; border-radius: 20px; background: #f0fdf4; border: 1px solid #bbf7d0;">
                    <h2 style="color: #16a34a; margin-bottom: 10px;">🎉 授权成功！</h2>
                    <p style="color: #15803d; margin-bottom: 8px;">${providerName} 已成功连接并启用。</p>
                    <p style="color: #166534; font-size: 14px; margin-bottom: 20px;">窗口将自动关闭。如果未关闭，请点击下方按钮关闭，主页面会自动刷新账户列表。</p>
                    <button id="close-window" type="button" style="padding: 10px 20px; background: #16a34a; color: white; border: none; border-radius: 8px; cursor: pointer;">关闭此窗口</button>
                    <script nonce="${nonce}">
                        const targetOrigin = ${targetOrigin};
                        const message = ${message};
                        const notifyParent = () => {
                            if (window.opener && !window.opener.closed) {
                                window.opener.postMessage(message, targetOrigin);
                            }
                        };
                        const closeWindow = () => { notifyParent(); window.close(); };
                        document.getElementById('close-window')?.addEventListener('click', closeWindow);
                        notifyParent();
                        setTimeout(closeWindow, 1200);
                    </script>
                </div>
            </body>
        </html>
    `;
}
