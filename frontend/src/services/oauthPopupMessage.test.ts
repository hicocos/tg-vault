import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedOAuthPopupMessage } from './oauthPopupMessage';

const popup = {} as Window;
const otherWindow = {} as Window;
const expected = {
    frontendOrigin: 'https://cloud.example.test',
    popup,
    provider: 'google_drive' as const,
    flowNonce: 'flow-nonce-a',
};

function event(overrides: Partial<MessageEvent> = {}): MessageEvent {
    return {
        origin: expected.frontendOrigin,
        source: popup,
        data: {
            type: 'oauth_success',
            provider: 'google_drive',
            flowNonce: 'flow-nonce-a',
            accountId: 'account-id',
        },
        ...overrides,
    } as MessageEvent;
}

test('accepts only the expected OAuth popup success message', () => {
    assert.equal(isTrustedOAuthPopupMessage(event(), expected), true);
});

test('rejects OAuth messages from the wrong origin', () => {
    assert.equal(isTrustedOAuthPopupMessage(event({ origin: 'https://evil.example' }), expected), false);
});

test('rejects OAuth messages from a different window source', () => {
    assert.equal(isTrustedOAuthPopupMessage(event({ source: otherWindow }), expected), false);
});

test('rejects wrong provider, nonce, malformed and replay-shaped legacy strings', () => {
    assert.equal(isTrustedOAuthPopupMessage(event({ data: { type: 'oauth_success', provider: 'onedrive', flowNonce: 'flow-nonce-a' } }), expected), false);
    assert.equal(isTrustedOAuthPopupMessage(event({ data: { type: 'oauth_success', provider: 'google_drive', flowNonce: 'wrong' } }), expected), false);
    assert.equal(isTrustedOAuthPopupMessage(event({ data: 'google_drive_auth_success' }), expected), false);
    assert.equal(isTrustedOAuthPopupMessage(event({ data: null }), expected), false);
});
