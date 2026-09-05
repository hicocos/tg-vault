import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { TelegramUserAccountsOverview } from '../../services/api';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const names = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
install('window', dom.window);
install('document', dom.window.document);
install('navigator', dom.window.navigator);
install('localStorage', dom.window.localStorage);
install('sessionStorage', dom.window.sessionStorage);
install('HTMLElement', dom.window.HTMLElement);
install('SVGElement', dom.window.SVGElement);
install('Node', dom.window.Node);
install('Event', dom.window.Event);
install('MouseEvent', dom.window.MouseEvent);
install('MutationObserver', dom.window.MutationObserver);
install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
install('IS_REACT_ACT_ENVIRONMENT', true);

const { cleanup, render, screen, waitFor } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { default: i18n } = await import('../../i18n');
const { fileApi } = await import('../../services/api');
const { TelegramUserAccountsPanel } = await import('./TelegramUserAccountsPanel');

const overview: TelegramUserAccountsOverview = {
    accounts: [{
        id: 'acct-a', userId: '123', username: 'archive_user', displayName: '归档账号', enabled: true,
        connected: true, health: 'ready', checkedAt: '2026-08-29T12:00:00.000Z', lastError: null, cooldownUntil: null,
        permissionSummary: { allowed: 3, denied: 1, unknown: 0, total: 4, lastCheckedAt: '2026-08-29T12:00:00.000Z' },
        scheduling: { weight: 2, activeDownloads: 1, lastSelectedAt: null },
    }],
    summary: { total: 1, enabled: 1, ready: 1, coolingDown: 0, permissions: { allowed: 3, denied: 1, unknown: 0, total: 4, lastCheckedAt: null } },
    scheduling: { strategy: 'weighted_least_connections', description: '按权限与负载智能调度' },
};

const originalMethods = {
    get: fileApi.getTelegramUserAccounts,
    qr: fileApi.startTelegramUserQrLogin,
    cancel: fileApi.cancelTelegramUserLogin,
};

afterEach(() => cleanup());
after(() => {
    fileApi.getTelegramUserAccounts = originalMethods.get;
    fileApi.startTelegramUserQrLogin = originalMethods.qr;
    fileApi.cancelTelegramUserLogin = originalMethods.cancel;
    dom.window.close();
    for (const name of names) {
        const descriptor = originals.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
    }
});

test('renders account health, permission totals and opens a QR-only secret view', async () => {
    await i18n.changeLanguage('zh-CN');
    fileApi.getTelegramUserAccounts = async () => overview;
    let qrStarts = 0;
    fileApi.startTelegramUserQrLogin = async () => ({
        ...(qrStarts++, {}),
        flowId: 'flow-a', status: 'waiting_for_scan', qrCode: 'tg://login?token=TOP_SECRET_QR',
        qrExpiresAt: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    });
    fileApi.getTelegramUserLoginStatus = async () => ({
        flowId: 'flow-a', status: 'waiting_for_scan', qrCode: 'tg://login?token=TOP_SECRET_QR',
        qrExpiresAt: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    });
    fileApi.cancelTelegramUserLogin = async () => ({ success: true });
    const user = userEvent.setup({ document: dom.window.document });

    render(<TelegramUserAccountsPanel configured onNotice={() => undefined} requestConfirmation={async () => true} />);
    await screen.findByText('归档账号');
    assert.match(screen.getByText('当前可用').parentElement?.textContent || '', /1/);
    const accountCard = screen.getByText('归档账号').closest('article');
    assert.ok(accountCard);
    assert.match(accountCard.textContent || '', /权限.*可访问 3/);

    await user.click(screen.getByRole('button', { name: /添加账号/ }));
    await screen.findByText('选择登录方式');
    assert.equal(qrStarts, 0);
    await user.click(screen.getByRole('button', { name: /二维码登录/ }));
    assert.equal(qrStarts, 0);
    await user.click(screen.getByRole('button', { name: '下一步' }));
    const qr = await screen.findByLabelText('Telegram 登录二维码');
    assert.equal(qr.tagName.toLowerCase(), 'svg');
    assert.equal(qrStarts, 1);
    assert.equal(document.body.textContent?.includes('TOP_SECRET_QR'), false);

    await user.click(screen.getByRole('button', { name: '关闭添加账号' }));
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
});
