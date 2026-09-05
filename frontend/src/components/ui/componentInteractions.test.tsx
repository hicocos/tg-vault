import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { useState } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
});

const installedGlobals = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Node',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
] as const;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

function installGlobal(name: string, value: unknown) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
    });
}

installGlobal('window', dom.window);
installGlobal('document', dom.window.document);
installGlobal('navigator', dom.window.navigator);
installGlobal('HTMLElement', dom.window.HTMLElement);
installGlobal('Node', dom.window.Node);
installGlobal('Event', dom.window.Event);
installGlobal('KeyboardEvent', dom.window.KeyboardEvent);
installGlobal('MouseEvent', dom.window.MouseEvent);
installGlobal('MutationObserver', dom.window.MutationObserver);
installGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
installGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { default: i18n } = await import('../../i18n');
const { Dialog } = await import('./Dialog');
const { Notification } = await import('./Notification');

afterEach(() => cleanup());
after(() => {
    dom.window.close();
    for (const name of installedGlobals) {
        const descriptor = originalGlobals.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
    }
});

function DialogHarness() {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
            <Dialog open={open} onClose={() => setOpen(false)} labelledBy="rendered-dialog-title">
                <h2 id="rendered-dialog-title">Delete file?</h2>
                <button type="button">Cancel</button>
                <button type="button">Delete</button>
            </Dialog>
        </>
    );
}

test('Dialog moves focus inside, traps Tab, closes on Escape, and restores trigger focus', async () => {
    const user = userEvent.setup({ document: dom.window.document });
    render(<DialogHarness />);

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    trigger.focus();
    assert.equal(document.activeElement, trigger);

    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Delete file?' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    await waitFor(() => assert.equal(document.activeElement, cancel));

    await user.tab({ shift: true });
    assert.equal(document.activeElement, confirm);
    await user.tab();
    assert.equal(document.activeElement, cancel);

    await user.keyboard('{Escape}');

    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
    assert.equal(document.activeElement, trigger);
});

test('Notification exposes an assertive live region and its rendered close control works', async () => {
    await i18n.changeLanguage('zh-CN');
    const user = userEvent.setup({ document: dom.window.document });
    let closeCalls = 0;
    render(
        <Notification
            show
            message="Upload failed"
            type="error"
            duration={0}
            onClose={() => { closeCalls += 1; }}
        />,
    );

    const liveRegion = screen.getByRole('alert');
    assert.equal(liveRegion.getAttribute('aria-live'), 'assertive');
    assert.equal(liveRegion.getAttribute('aria-atomic'), 'true');
    assert.match(liveRegion.textContent || '', /Upload failed/);

    await user.click(screen.getByRole('button', { name: '关闭通知' }));
    assert.equal(closeCalls, 1);
});
