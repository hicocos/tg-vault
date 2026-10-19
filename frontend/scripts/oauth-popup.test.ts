import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOAuthRouteConfig } from '../../backend/src/services/oauthRouteConfig.ts';
import { isTrustedOAuthPopupMessage, type OAuthPopupMessage, type OAuthPopupProvider } from '../src/services/oauthPopupMessage.ts';
import { monitorOAuthPopup } from '../src/services/oauthPopupFlow.ts';

for (const provider of ['onedrive', 'google_drive'] as const) {
    for (const splitOrigin of [false, true]) {
        test(`${provider}: ${splitOrigin ? 'split' : 'same'}-origin callback reaches its terminal state before popup closes`, async () => {
            const config = getOAuthRouteConfig(provider, {
                VITE_API_URL: splitOrigin ? 'https://api.example.test' : 'https://web.example.test',
                CORS_ORIGIN: 'https://web.example.test',
            });
            for (const type of ['oauth_success', 'oauth_failure'] as const) {
                const popupState = { closed: false };
                const popup = popupState as Window;
                const states: string[] = [];
                let publishedAccount: string | undefined;
                let listener: (event: MessageEvent) => void = () => assert.fail('message listener missing');
                let tick: () => void = () => assert.fail('close monitor missing');
                const cleanup = monitorOAuthPopup({
                    host: {
                        addEventListener: (_type, callback) => { listener = callback; },
                        removeEventListener: () => {},
                        setInterval: callback => { tick = callback; return 1; },
                        clearInterval: () => {},
                    },
                    popup,
                    classifyMessage: event => isTrustedOAuthPopupMessage(event, {
                        callbackOrigin: config.callbackOrigin,
                        popup,
                        provider,
                        flowNonce: 'flow-nonce',
                    }) ? event.data.type === 'oauth_success' ? 'success' : 'failed' : null,
                    onSuccess: event => { publishedAccount = event.data.accountId; },
                    onStateChange: state => { states.push(state); },
                });
                const event = {
                    origin: new URL(config.redirectUri).origin,
                    source: popup,
                    data: { type, provider, flowNonce: 'flow-nonce', accountId: 'account-id', error: 'access_denied' },
                } as MessageEvent<OAuthPopupMessage>;
                listener(event);
                await Promise.resolve();
                popupState.closed = true;
                tick();
                await Promise.resolve();
                assert.deepEqual(states, ['waiting', type === 'oauth_success' ? 'success' : 'failed']);
                assert.equal(publishedAccount, type === 'oauth_success' ? 'account-id' : undefined);
                cleanup();
            }
        });
    }
}

test('callback trust rejects an unexpected origin, window, provider or flow nonce', () => {
    const popup = {} as Window;
    const expected = { callbackOrigin: 'https://api.example.test', popup, provider: 'onedrive' as OAuthPopupProvider, flowNonce: 'flow-nonce' };
    const event = {
        origin: expected.callbackOrigin,
        source: popup,
        data: { type: 'oauth_success', provider: 'onedrive', flowNonce: expected.flowNonce, accountId: 'account-id' },
    } as MessageEvent<OAuthPopupMessage>;
    assert.equal(isTrustedOAuthPopupMessage(event, expected), true);
    for (const rejected of [
        { ...event, origin: 'https://web.example.test' },
        { ...event, origin: 'https://api.example.test.attacker.test' },
        { ...event, source: {} as Window },
        { ...event, data: { ...event.data, provider: 'google_drive' } },
        { ...event, data: { ...event.data, flowNonce: 'another-flow' } },
        { ...event, data: { ...event.data, type: 'unexpected' } },
    ]) {
        assert.equal(isTrustedOAuthPopupMessage(rejected as MessageEvent, expected), false);
    }
});
