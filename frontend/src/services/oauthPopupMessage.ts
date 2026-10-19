export type OAuthPopupProvider = 'onedrive' | 'google_drive';

export interface OAuthPopupMessage {
    type: 'oauth_success' | 'oauth_failure';
    provider: OAuthPopupProvider;
    flowNonce: string;
    accountId?: string;
    error?: string;
}

export interface ExpectedOAuthPopupMessage {
    callbackOrigin: string;
    popup: Window;
    provider: OAuthPopupProvider;
    flowNonce: string;
}

export function isTrustedOAuthPopupMessage(
    event: MessageEvent,
    expected: ExpectedOAuthPopupMessage,
): event is MessageEvent<OAuthPopupMessage> {
    if (event.origin !== expected.callbackOrigin || event.source !== expected.popup) return false;
    const data = event.data;
    if (!data || typeof data !== 'object') return false;
    return (data.type === 'oauth_success' || data.type === 'oauth_failure')
        && data.provider === expected.provider
        && data.flowNonce === expected.flowNonce
        && (data.accountId === undefined || typeof data.accountId === 'string')
        && (data.error === undefined || typeof data.error === 'string');
}
