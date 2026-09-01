import assert from 'node:assert/strict';
import test from 'node:test';

function installBrowserGlobals() {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            addEventListener: (type: string, listener: (event: Event) => void) => {
                const set = listeners.get(type) ?? new Set();
                set.add(listener);
                listeners.set(type, set);
            },
            removeEventListener: (type: string, listener: (event: Event) => void) => listeners.get(type)?.delete(listener),
            dispatchEvent: (event: Event) => {
                listeners.get(event.type)?.forEach(listener => listener(event));
                return true;
            },
        },
    });
}

test('wrong current password keeps the valid browser session active', async () => {
    installBrowserGlobals();
    const { authService } = await import('./auth.js');
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: '当前密码不正确' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    let invalidated = 0;
    const unsubscribe = authService.onSessionInvalidated(() => { invalidated += 1; });
    const result = await authService.changePassword('wrong-current-password', 'new-password-123');
    unsubscribe();

    assert.deepEqual(result, { success: false, error: '当前密码不正确' });
    assert.equal(invalidated, 0);
});
