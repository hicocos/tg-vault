import assert from 'node:assert/strict';
import test from 'node:test';
import { Api, TelegramClient } from 'telegram';
import { MemorySession } from 'telegram/sessions/Memory.js';
import { MTProtoSender } from 'telegram/network/MTProtoSender.js';
import { RequestState } from 'telegram/network/RequestState.js';
import { AuthKey } from 'telegram/crypto/AuthKey.js';
import { DirectDownloadIter } from 'telegram/client/downloads.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import type { Connection } from 'telegram/network/connection/Connection.js';
import bigInt from 'big-integer';
import { withTelegramOperationSignal } from '../src/services/telegramOperationContext.js';
import { ownBotTransport, type BotTransportOptions } from '../src/services/telegramBotTransport.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

class InjectedConnection {
    static instances: InjectedConnection[] = [];
    static gate: Promise<void> | undefined;
    static rejectCleanup = false;
    readonly dcId: number;
    connected = false;
    closed = false;
    readonly receive = deferred<Buffer>();
    readonly opened = deferred<void>();
    readonly socket = { close: async () => { this.closed = true; } };
    constructor(options: { dcId: number }) {
        this.dcId = options.dcId;
        InjectedConnection.instances.push(this);
        void this.receive.promise.catch(() => undefined);
    }
    async connect() {
        this.opened.resolve();
        await InjectedConnection.gate;
        this.connected = true;
    }
    async disconnect() {
        if (InjectedConnection.rejectCleanup) throw new Error('injected cleanup failure');
        this.connected = false;
        this.closed = true;
        this.receive.reject(new Error('socket closed'));
    }
    isConnected() { return this.connected; }
    async send(_data: Buffer) {}
    recv() { return this.receive.promise; }
    toString() { return 'injected'; }
}

type SenderInternals = Omit<MTProtoSender, '_pendingState'> & {
    _pendingState: { set(id: bigInt.BigInteger, state: RequestState): void; size: number };
    _sendQueue: { _pendingStates: RequestState[] };
    _onConnectionBreak?: (dc: number) => void;
};
type ClientInternals = Omit<TelegramClient, '_sender' | '_connection'> & {
    _sender: MTProtoSender;
    _createExportedSender(dc: number): MTProtoSender;
    _connection: typeof Connection;
    _exportedSenderReleaseTimeouts: Map<number, NodeJS.Timeout>;
    _connectedDeferred: { resolve(): void };
};

async function fixture(options: BotTransportOptions = {}) {
    InjectedConnection.instances = [];
    InjectedConnection.gate = undefined;
    InjectedConnection.rejectCleanup = false;
    const session = new MemorySession();
    session.setDC(1, '127.0.0.1', 443);
    // Real auth keys skip the handshake; real sender receive/send loops still run.
    const authKeys = new Map<number, AuthKey>();
    session.getAuthKey = dc => authKeys.get(dc ?? session.dcId);
    session.setAuthKey = (key, dc) => {
        if (key) authKeys.set(dc ?? session.dcId, key);
        else authKeys.delete(dc ?? session.dcId);
        return undefined;
    };
    for (const dc of [1, 2, 3]) {
        const key = new AuthKey();
        await key.setKey(Buffer.alloc(256, dc));
        session.setAuthKey(key, dc);
    }
    const client = new TelegramClient(session, 1, 'test-only', {
        baseLogger: new Logger(LogLevel.NONE), requestRetries: 1,
        connectionRetries: 1, retryDelay: 0, autoReconnect: false,
    }) as unknown as ClientInternals;
    client._connection = InjectedConnection as unknown as typeof Connection;
    client.getDC = async dc => ({ id: dc, ipAddress: '127.0.0.1', port: 443 });
    ownBotTransport(client as unknown as TelegramClient, { connectTimeoutMs: 100, cleanupTimeoutMs: 100, ...options });
    const mainSender = new MTProtoSender(session.getAuthKey(1), {
        ...MTProtoSender.DEFAULT_OPTIONS, logger: client.logger, dcId: 1,
        client: client as unknown as TelegramClient, _exportedSenderPromises: new Map(), isMainSender: true,
    } as ConstructorParameters<typeof MTProtoSender>[1]);
    client._sender = mainSender;
    const connection = new InjectedConnection({ dcId: 1 });
    await mainSender.connect(connection as unknown as Connection, false);
    client._connectedDeferred.resolve();
    return { client, main: mainSender as unknown as SenderInternals, connection };
}

function queued(sender: Pick<MTProtoSender, 'addStateToQueue'>) {
    const state = new RequestState(new Api.help.GetConfig());
    sender.addStateToQueue(state);
    return state;
}

function inFlight(sender: SenderInternals, id: number) {
    const state = new RequestState(new Api.help.GetConfig());
    sender._pendingState.set(bigInt(id), state);
    return state;
}

test('DC receive fault settles only its queued/in-flight requests; siblings share confirmed replacement', async () => {
    const { client, main } = await fixture();
    try {
        const old = await client.getSender(2) as SenderInternals;
        const other = await client.getSender(3) as SenderInternals;
        const mainRequest = inFlight(main, 100);
        const siblingRequest = inFlight(other, 101);
        const pending = inFlight(old, 102);
        const waiting = queued(old);
        const failures = [assert.rejects(pending.promise!, /BOT_DC_CONNECTION_LOST/), assert.rejects(waiting.promise!, /BOT_DC_CONNECTION_LOST/)];
        const oldConnection = old._connection as unknown as InjectedConnection;
        oldConnection.receive.reject(new Error('injected receive failure'));
        await Promise.all(failures);
        const [a, b] = await Promise.all([client.getSender(2), client.getSender(2)]);
        assert.equal(a, b);
        assert.notEqual(a, old);
        assert.equal(oldConnection.closed, true);
        assert.equal(oldConnection.connected, false);
        assert.equal(main.isConnected(), true);
        assert.equal(other.isConnected(), true);
        mainRequest.resolve('main usable');
        siblingRequest.resolve('other usable');
        assert.equal(await mainRequest.promise, 'main usable');
        assert.equal(await siblingRequest.promise, 'other usable');
        assert.equal(client._exportedSenderReleaseTimeouts.size, 0);
    } finally { await client.destroy(); }
});

test('stale callbacks cannot retire a replacement; explicit reconnect is single-flight', async () => {
    const { client } = await fixture();
    try {
        const old = await client.getSender(2) as SenderInternals;
        const staleAuthCallback = old._onConnectionBreak!;
        const [a, b] = await Promise.all([client._borrowExportedSender(2, true), client._borrowExportedSender(2, true)]);
        assert.equal(a, b);
        old.reconnect();
        await old._reconnect();
        staleAuthCallback(2);
        assert.equal(await client.getSender(2), a);
        assert.equal(a.isConnected(), true);
    } finally { await client.destroy(); }
});

test('main loss is global and notifies once, even when observer throws', async () => {
    let callbacks = 0;
    const { client, main, connection } = await fixture({ onMainConnectionLost: error => {
        assert.equal(error.message, 'BOT_CONNECTION_LOST');
        callbacks++;
        throw new Error('observer failure');
    } });
    try {
        const download = await client.getSender(2) as SenderInternals;
        const mainRequest = inFlight(main, 200);
        const downloadRequest = inFlight(download, 201);
        const failures = [assert.rejects(mainRequest.promise!, /BOT_CONNECTION_LOST/), assert.rejects(downloadRequest.promise!, /BOT_CONNECTION_LOST/)];
        connection.receive.reject(new Error('injected main failure'));
        await Promise.all(failures);
        main.reconnect();
        assert.equal(callbacks, 1);
        assert.throws(() => client.getSender(3), /BOT_CONNECTION_LOST/);
    } finally { await client.destroy(); }
});

test('bad exported auth is explicit and sticky, without replay or poisoning main', async () => {
    const { client, main } = await fixture();
    try {
        const download = await client.getSender(2);
        const request = queued(download);
        const rejected = assert.rejects(request.promise!, /AUTH_KEY_UNREGISTERED/);
        download._handleBadAuthKey();
        await rejected;
        await assert.rejects(client.getSender(2), /AUTH_KEY_UNREGISTERED/);
        assert.equal(main.isConnected(), true);
    } finally { await client.destroy(); }
});

test('destroy cancels pending connection and joins its late socket closure', async () => {
    let callbacks = 0;
    const { client } = await fixture({ onMainConnectionLost: () => { callbacks++; } });
    const gate = deferred<void>();
    InjectedConnection.gate = gate.promise;
    const borrow = client.getSender(2);
    const rejected = assert.rejects(borrow, /BOT_CANCELLED/);
    // Let lookup and sender.connect reach the injected open, without timers or network.
    while (!InjectedConnection.instances.some(connection => connection.dcId === 2)) await Promise.resolve();
    const connection = InjectedConnection.instances.find(item => item.dcId === 2)!;
    await connection.opened.promise;
    const destruction = client.destroy();
    const repeated = client.destroy();
    assert.equal(destruction, repeated);
    gate.resolve();
    await Promise.all([rejected, destruction]);
    assert.ok(InjectedConnection.instances.every(item => item.closed && !item.connected));
    assert.equal(client._exportedSenderReleaseTimeouts.size, 0);
    assert.equal(callbacks, 0);
});

test('failed cleanup quarantines a DC and prevents replacement creation', async () => {
    const { client, main } = await fixture();
    const download = await client.getSender(2);
    const count = InjectedConnection.instances.length;
    InjectedConnection.rejectCleanup = true;
    download.reconnect();
    await assert.rejects(client.getSender(2), /BOT_TRANSPORT_CLEANUP_FAILED/);
    await assert.rejects(client.getSender(2), /BOT_TRANSPORT_CLEANUP_FAILED/);
    assert.equal(InjectedConnection.instances.length, count);
    assert.equal(main.isConnected(), true);
    await assert.rejects(client.destroy(), /BOT_TRANSPORT_CLEANUP_FAILED/);
    InjectedConnection.rejectCleanup = false;
    // Explicit fixture teardown after verifying quarantine, never a transport retry.
    await Promise.all(InjectedConnection.instances.map(connection => connection.disconnect()));
});

test('GetFile cancellation settles only that request without disconnecting its shared sender', async () => {
    const { client, main } = await fixture();
    try {
        const sender = await client.getSender(2) as SenderInternals;
        const controller = new AbortController();
        const file = new RequestState(new Api.upload.GetFile({
            location: new Api.InputDocumentFileLocation({ id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0), thumbSize: '' }),
            offset: bigInt(0), limit: 4096,
        }));
        await withTelegramOperationSignal(controller.signal, async () => { sender.addStateToQueue(file); });
        const rejected = assert.rejects(file.promise!, /request cancelled/);
        controller.abort(new Error('request cancelled'));
        await rejected;
        assert.equal(sender._sendQueue._pendingStates.includes(file), false);
        assert.equal(sender.isConnected(), true);
        assert.equal(main.isConnected(), true);
    } finally { await client.destroy(); }
});

test('repeated unavailable DC attempts stay bounded and leave main usable', async () => {
    const { client, main } = await fixture({ connectTimeoutMs: 5 });
    const neverOpen = deferred<void>();
    InjectedConnection.gate = neverOpen.promise;
    try {
        const rejected = assert.rejects(client.getSender(2), /BOT_DC_CONNECTION_LOST/);
        while (!InjectedConnection.instances.some(connection => connection.dcId === 2)) await Promise.resolve();
        const connection = InjectedConnection.instances.find(item => item.dcId === 2)!;
        await connection.opened.promise;
        await rejected;
        neverOpen.resolve();
        InjectedConnection.gate = undefined;
        const replacement = await client.getSender(2);
        assert.equal(replacement.isConnected(), true);
        assert.equal(main.isConnected(), true);
        replacement.reconnect();
        assert.notEqual(await client.getSender(2), replacement);
        assert.equal(main.isConnected(), true);
    } finally { neverOpen.resolve(); await client.destroy(); }
});

test('unconfirmed late connect times out cleanup and cannot create a replacement', async () => {
    const { client, main } = await fixture({ connectTimeoutMs: 5, cleanupTimeoutMs: 10 });
    const gate = deferred<void>();
    InjectedConnection.gate = gate.promise;
    await assert.rejects(client.getSender(2), /BOT_DC_CONNECTION_LOST/);
    const count = InjectedConnection.instances.length;
    await assert.rejects(client.getSender(2), /BOT_TRANSPORT_CLEANUP_FAILED/);
    assert.equal(InjectedConnection.instances.length, count);
    assert.equal(main.isConnected(), true);
    gate.resolve();
    await assert.rejects(client.destroy(), /BOT_TRANSPORT_CLEANUP_FAILED/);
});

test('native DirectDownloadIter reopens at the failed GetFile offset using a new real sender', async () => {
    const { client, main } = await fixture();
    const fileLocation = new Api.InputDocumentFileLocation({ id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0), thumbSize: '' });
    const open = (offset: number) => new DirectDownloadIter(client as unknown as TelegramClient, 3, {}, {
        fileLocation, dcId: 2, offset: bigInt(offset), stride: 4096, chunkSize: 4096, requestSize: 4096, fileSize: 8192, msgData: 0,
    })[Symbol.asyncIterator]();
    try {
        const iterator = open(0);
        const first = iterator.next();
        const old = await client.getSender(2) as SenderInternals;
        while (!old._sendQueue._pendingStates.some(state => state.request instanceof Api.upload.GetFile)) await Promise.resolve();
        const request = old._sendQueue._pendingStates.find(state => state.request instanceof Api.upload.GetFile)!;
        request.resolve({ bytes: Buffer.alloc(4096, 1) });
        assert.deepEqual((await first).value, Buffer.alloc(4096, 1));
        const second = iterator.next();
        const rejected = assert.rejects(second, /BOT_DC_CONNECTION_LOST/);
        while (!old._sendQueue._pendingStates.some(state => state.request instanceof Api.upload.GetFile && state !== request)) await Promise.resolve();
        (old._connection as unknown as InjectedConnection).receive.reject(new Error('injected iterator receive failure'));
        await rejected;
        const reopened = open(4096);
        const resumed = reopened.next();
        const replacement = await client.getSender(2) as SenderInternals;
        assert.notEqual(replacement, old);
        while (!replacement._sendQueue._pendingStates.some(state => state.request instanceof Api.upload.GetFile)) await Promise.resolve();
        const retry = replacement._sendQueue._pendingStates.find(state => state.request instanceof Api.upload.GetFile)!;
        assert.equal(retry.request.offset.toJSNumber(), 4096);
        retry.resolve({ bytes: Buffer.alloc(4096, 2) });
        assert.deepEqual((await resumed).value, Buffer.alloc(4096, 2));
        assert.equal(main.isConnected(), true);
    } finally { await client.destroy(); }
});

test('explicit disconnect is terminal and does not notify or recreate senders', async () => {
    let callbacks = 0;
    const { client } = await fixture({ onMainConnectionLost: () => { callbacks++; } });
    await client.getSender(2);
    await client.disconnect();
    const count = InjectedConnection.instances.length;
    assert.throws(() => client.getSender(2), /BOT_CANCELLED/);
    assert.equal(InjectedConnection.instances.length, count);
    assert.equal(callbacks, 0);
    assert.ok(InjectedConnection.instances.every(connection => connection.closed && !connection.connected));
    await client.destroy();
});
