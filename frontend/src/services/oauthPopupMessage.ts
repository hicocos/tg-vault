export type OAuthPopupProvider = 'onedrive' | 'google_drive';

export interface OAuthSuccessMessage {
    type: 'oauth_success';
    provider: OAuthPopupProvider;
    flowNonce: string;
    accountId?: string;
}

export interface ExpectedOAuthPopupMessage {
    frontendOrigin: string;
    popup: Window;
    provider: OAuthPopupProvider;
    flowNonce: string;
}

export function isTrustedOAuthPopupMessage(
    event: MessageEvent,
    expected: ExpectedOAuthPopupMessage,
): event is MessageEvent<OAuthSuccessMessage> {
    if (event.origin !== expected.frontendOrigin || event.source !== expected.popup) return false;
    const data = event.data;
    if (!data || typeof data !== 'object') return false;
    return data.type === 'oauth_success'
        && data.provider === expected.provider
        && data.flowNonce === expected.flowNonce
        && (data.accountId === undefined || typeof data.accountId === 'string');
}
