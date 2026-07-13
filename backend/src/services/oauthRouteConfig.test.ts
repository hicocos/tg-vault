import assert from 'node:assert/strict';
import test from 'node:test';
import { getOAuthRouteConfig, renderOAuthSuccessPage } from './oauthRouteConfig.js';

test('OAuth redirect URI is derived only from configured API origin and ignores request override/Host', () => {
    const config = getOAuthRouteConfig('google_drive', {
        OAUTH_CALLBACK_BASE_URL: 'https://api.example.test/base/path?ignored=yes',
        OAUTH_FRONTEND_ORIGIN: 'https://cloud.example.test/some/path',
    });
    assert.equal(config.redirectUri, 'https://api.example.test/api/storage/google-drive/callback');
    assert.equal(config.frontendOrigin, 'https://cloud.example.test');
});

test('OAuth route config fails closed without exact server origins or with wildcard frontend origin', () => {
    assert.throws(() => getOAuthRouteConfig('onedrive', {}), /OAUTH_CALLBACK_BASE_URL|VITE_API_URL/);
    assert.throws(() => getOAuthRouteConfig('onedrive', {
        OAUTH_CALLBACK_BASE_URL: 'https://api.example.test',
        OAUTH_FRONTEND_ORIGIN: '*',
    }), /OAUTH_FRONTEND_ORIGIN/);
});

test('OAuth success page targets exact frontend origin and carries structured provider flow nonce', () => {
    const html = renderOAuthSuccessPage({
        provider: 'onedrive',
        providerName: 'OneDrive',
        frontendOrigin: 'https://cloud.example.test',
        flowNonce: 'flow-nonce',
        accountId: 'account-id',
        scriptNonce: 'script-nonce',
    });
    assert.match(html, /postMessage\(message, targetOrigin\)/);
    assert.match(html, /https:\/\/cloud\.example\.test/);
    assert.match(html, /"type":"oauth_success"/);
    assert.match(html, /"flowNonce":"flow-nonce"/);
    assert.doesNotMatch(html, /postMessage\([^\n]+,\s*['"]\*['"]\)/);
});
