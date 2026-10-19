import { createRequire } from 'node:module';
import { TelegramClient, Api } from 'telegram';
import { LAYER } from 'telegram/tl/AllTLObjects.js';
import type { Connection } from 'telegram/network/connection/Connection.js';
import type { MTProtoSender } from 'telegram/network/MTProtoSender.js';
import type { RequestState } from 'telegram/network/RequestState.js';
import { telegramOperationSignal } from './telegramOperationContext.js';

interface BotSender extends Omit<MTProtoSender, '_connection'> {
    _connection?: Connection;
    _authKeyCallback?: TelegramClient['_authKeyCallback'];
    _autoReconnectCallback?: () => Promise<void>;
    _onConnectionBreak?: (dc: number) => void;
    _retries: number;
    _delay: number;
    _sendLoopHandle?: Promise<void>;
    _recvLoopHandle?: Promise<void>;
    _sendQueue: { _queue: Array<RequestState | undefined>; _pendingStates: RequestState[]; clear(): void };
    _pendingAck: Set<unknown>;
    _lastAcks: RequestState[];
}
interface ConnectionLoops {
    _sendArray: { push(value: undefined): Promise<void> };
    _sendTask?: Promise<void>;
    _recvTask?: Promise<void>;
}
interface BotClient extends Omit<TelegramClient, '_sender' | '_createExportedSender' | '_connectSender' | '_borrowExportedSender' | '_exportedSenderPromises'> {
    _sender?: BotSender;
    _connection: typeof Connection;
    _proxy?: ConstructorParameters<typeof Connection>[0]['proxy'];
    _initRequest: Api.InitConnection;
    _log: TelegramClient['logger'];
    _exportedSenderPromises: Map<number, Promise<BotSender>>;
    _exportedSenderReleaseTimeouts: Map<number, NodeJS.Timeout>;
    _createExportedSender(dc: number): BotSender;
    _connectSender(sender: BotSender, dc: number): Promise<BotSender>;
    _borrowExportedSender(dc: number, reconnect?: boolean, existing?: BotSender): Promise<BotSender>;
}

export interface BotTransportOptions {
    connectTimeoutMs?: number;
    cleanupTimeoutMs?: number;
    onMainConnectionLost?: (error: Error) => void;
}
interface OwnedSender {
    sender: BotSender;
    role: 'main' | 'download';
    dc: number;
    generation: number;
    error?: Error;
    causeCode?: string;
    used: boolean;
    connecting?: Promise<boolean>;
    cleanup?: Promise<void>;
    disconnect(): Promise<void>;
    cancel: Promise<never>;
    reject(error: Error): void;
}
interface DcSlot {
    record?: OwnedSender;
    promise?: Promise<BotSender>;
    connecting: boolean;
    authError?: Error;
}
const require = createRequire(import.meta.url);
const SUPPORTED_VERSION = '2.26.22';
const authCode = (error: unknown): string | undefined => {
    const value = error as { errorMessage?: string; message?: string } | undefined;
    return ['AUTH_KEY_UNREGISTERED', 'AUTH_KEY_INVALID', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'AUTH_KEY_DUPLICATED']
        .find(code => value?.errorMessage === code || value?.message === code);
};
const socketCode = (error: unknown): string => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return typeof code === 'string' &&
        ['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED'].includes(code)
        ? code : 'UNKNOWN_SOCKET_CLOSE';
};

/** Instance-only compatibility boundary for the pinned SDK; never use on user clients. */
export function ownBotTransport<T extends TelegramClient>(client: T, options: BotTransportOptions = {}): T {
    const c = client as unknown as BotClient;
    if (require('telegram/package.json').version !== SUPPORTED_VERSION || c._sender !== undefined ||
        !(c._exportedSenderPromises instanceof Map) || !(c._exportedSenderReleaseTimeouts instanceof Map) ||
        !['connect', 'destroy', '_createExportedSender', '_connectSender', '_borrowExportedSender', '_switchDC', 'invoke', 'invokeWithSender'].every(k => typeof c[k as keyof BotClient] === 'function')) {
        throw new Error('BOT_SDK_OWNERSHIP_UNSUPPORTED');
    }
    const connectTimeout = options.connectTimeoutMs ?? 30_000;
    const cleanupTimeout = options.cleanupTimeoutMs ?? 10_000;
    let closed = false, startup = true, connectAllowed = true;
    let failure: Error | undefined, main: BotSender | undefined, generation = 0;
    let destruction: Promise<void> | undefined;
    const records = new WeakMap<BotSender, OwnedSender>();
    const owned = new Set<OwnedSender>();
    const slots = new Map<number, DcSlot>();
    const pending = new Set<Promise<unknown>>();
    const track = <R>(work: () => Promise<R>): Promise<R> => {
        const p = Promise.resolve().then(work);
        pending.add(p);
        void p.finally(() => pending.delete(p)).catch(() => undefined);
        return p;
    };
    const bounded = async <R>(work: Promise<R>, ms: number, code: string, cancel?: Promise<never>): Promise<R> => {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([work, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(code)), ms);
            }), ...(cancel ? [cancel] : [])]);
        } finally { clearTimeout(timer); }
    };
    const assertActive = () => {
        if (closed) throw new Error('BOT_CANCELLED');
        if (failure) throw failure;
    };
    const assertSender = (record: OwnedSender) => {
        assertActive();
        if (record.error) throw record.error;
    };
    const rejectRequests = (record: OwnedSender, error: Error) => {
        const sender = record.sender;
        // SDK disconnect does not settle either pending or queued requests.
        for (const state of [...sender._pendingState.values(), ...sender._sendQueue._pendingStates]) {
            state.reject(error);
            state.finished.resolve();
        }
        sender._pendingState.clear();
        sender._sendQueue._pendingStates.length = 0;
        sender._sendQueue.clear();
        sender._pendingAck.clear();
        sender._lastAcks.length = 0;
    };
    const cleanup = (record: OwnedSender): Promise<void> => {
        if (record.cleanup) return record.cleanup;
        record.sender.userDisconnected = true;
        record.sender._userConnected = false;
        record.sender.isReconnecting = true;
        rejectRequests(record, record.error ?? new Error('BOT_CANCELLED'));
        record.cleanup = track(() => bounded((async () => {
            // Closing the socket also interrupts auth-key generation. Connection.disconnect
            // alone is insufficient if _connect has not set _connected yet.
            const connection = record.sender._connection;
            const loops = connection as unknown as ConnectionLoops | undefined;
            if (loops?._sendArray) void loops._sendArray.push(undefined);
            const results = await Promise.allSettled([
                record.disconnect(),
                ...(connection ? [connection.socket.close()] : []),
            ]);
            if (results.some(result => result.status === 'rejected')) throw new Error('BOT_TRANSPORT_CLEANUP_FAILED');
            if (record.connecting) await record.connecting.catch(() => undefined);
            await record.disconnect();
            // Capture handles before awaiting: SDK loops clear their own handle on exit.
            await Promise.all([record.sender._sendLoopHandle, record.sender._recvLoopHandle]);
            await Promise.all([loops?._sendTask, loops?._recvTask]);
            if (connection?.isConnected() || record.sender._userConnected) throw new Error('BOT_TRANSPORT_CLEANUP_FAILED');
            rejectRequests(record, record.error ?? new Error('BOT_CANCELLED'));
        })(), cleanupTimeout, 'BOT_TRANSPORT_CLEANUP_FAILED'));
        void record.cleanup.then(() => owned.delete(record), () => undefined);
        return record.cleanup;
    };
    const retire = (record: OwnedSender, error: Error) => {
        if (record.error) return;
        record.error = error;
        record.reject(error);
        rejectRequests(record, error);
        void cleanup(record);
    };
    const lost = (record: OwnedSender, error = new Error(record.role === 'main' ? 'BOT_CONNECTION_LOST' : 'BOT_DC_CONNECTION_LOST')) => {
        if (closed || record.error) return;
        // Late callbacks belong to their sender, not whichever generation is current.
        if (record.role === 'main' && main !== record.sender) return;
        if (record.role === 'download' && slots.get(record.dc)?.record !== record) return;
        const code = authCode(error) ?? record.causeCode ?? 'UNKNOWN_SOCKET_CLOSE';
        c._log.warn(`[Bot transport] role=${record.role} dc=${record.dc} generation=${record.generation} code=${code}`);
        if (record.role === 'download') {
            if (authCode(error)) slots.get(record.dc)!.authError = error;
            retire(record, error);
            return;
        }
        if (failure) return;
        failure = error;
        for (const record of owned) retire(record, error);
        try { options.onMainConnectionLost?.(error); } catch { /* Observer cannot interrupt settlement. */ }
    };
    const protect = (sender: BotSender, role: OwnedSender['role'], dc: number): OwnedSender => {
        assertActive();
        const previous = records.get(sender);
        if (previous) return previous;
        if (!['connect', '_connect', 'disconnect', 'reconnect', '_reconnect', 'isConnected', 'send', 'addStateToQueue'].every(k => typeof sender[k as keyof BotSender] === 'function') ||
            !Array.isArray(sender._sendQueue?._pendingStates) || !Array.isArray(sender._sendQueue?._queue) || !sender._pendingState ||
            typeof sender._pendingState.values !== 'function' || typeof sender._pendingState.clear !== 'function' ||
            typeof sender._sendQueue.clear !== 'function' || !(sender._pendingAck instanceof Set) || !Array.isArray(sender._lastAcks)) {
            failure = new Error('BOT_SDK_OWNERSHIP_UNSUPPORTED');
            throw failure;
        }
        let reject!: (error: Error) => void;
        const cancel = new Promise<never>((_, fail) => { reject = fail; });
        void cancel.catch(() => undefined);
        const record: OwnedSender = { sender, role, dc, generation: ++generation, used: false,
            disconnect: sender.disconnect.bind(sender), cancel, reject };
        records.set(sender, record);
        owned.add(record);
        const connect = sender.connect.bind(sender);
        const authKey = sender._authKeyCallback;
        const openSender = sender._connect.bind(sender);
        sender._connect = async () => {
            try { await openSender(); } catch (error) {
                if (authCode(error)) lost(record, error as Error);
                throw error;
            }
        };
        sender._authKeyCallback = async (...args) => {
            assertSender(record);
            if (authKey) await authKey(...args);
            assertSender(record);
        };
        sender._handleBadAuthKey = (skipMain = false) => {
            // Main unauthorized during initial Bot login is expected SDK behavior.
            if (skipMain && role === 'main') return;
            lost(record, new Error('AUTH_KEY_UNREGISTERED'));
        };
        sender._onConnectionBreak = () => { lost(record, new Error('AUTH_KEY_UNREGISTERED')); };
        sender._autoReconnectCallback = async () => { lost(record); };
        sender.reconnect = () => { lost(record); };
        sender._reconnect = async () => { lost(record); };
        sender.isConnected = () => !closed && !failure && !record.error && !sender.isConnecting &&
            !sender.isReconnecting && !!sender._userConnected && !!sender._connection?.isConnected();
        sender.connect = (connection, force) => track(async () => {
            assertSender(record);
            if (record.used || force) { lost(record); assertSender(record); }
            record.used = true;
            const recv = connection.recv.bind(connection);
            connection.recv = async () => {
                try { return await recv(); } catch (error) {
                    record.causeCode ??= socketCode(error);
                    throw error;
                }
            };
            if (typeof connection._connect === 'function') {
                const openSocket = connection._connect.bind(connection);
                connection._connect = async (...args) => {
                    assertSender(record);
                    try { await openSocket(...args); } catch (error) {
                        record.causeCode ??= socketCode(error);
                        throw error;
                    }
                    try { assertSender(record); } catch (error) { await connection.socket.close(); throw error; }
                };
            }
            const open = connection.connect.bind(connection);
            connection.connect = async () => {
                assertSender(record);
                try { await open(); } catch (error) {
                    record.causeCode ??= socketCode(error);
                    throw error;
                }
                try { assertSender(record); } catch (error) { await connection.disconnect(); throw error; }
            };
            sender._retries = 1;
            sender._delay = 0;
            record.connecting = connect(connection, false);
            try {
                const ok = await bounded(record.connecting, connectTimeout, role === 'main' ? 'BOT_CONNECTION_LOST' : 'BOT_DC_CONNECTION_LOST', cancel);
                assertSender(record);
                if (!ok) throw new Error(role === 'main' ? 'BOT_CONNECTION_LOST' : 'BOT_DC_CONNECTION_LOST');
                return ok;
            } catch (error) {
                lost(record, authCode(error) ? error as Error : new Error(role === 'main' ? 'BOT_CONNECTION_LOST' : 'BOT_DC_CONNECTION_LOST'));
                throw record.error ?? error;
            }
        });
        sender.disconnect = () => {
            retire(record, new Error('BOT_CANCELLED'));
            return cleanup(record);
        };
        const send = sender.send.bind(sender);
        sender.send = request => { try { assertSender(record); return send(request); } catch (error) { return Promise.reject(error); } };
        const enqueue = sender.addStateToQueue.bind(sender);
        const aborted = new WeakSet<RequestState>();
        const remember = sender._pendingState.set.bind(sender._pendingState);
        sender._pendingState.set = (id, state) => { if (!aborted.has(state)) remember(id, state); };
        sender.addStateToQueue = state => {
            assertSender(record);
            const signal = state.request instanceof Api.upload.GetFile ? telegramOperationSignal() : undefined;
            signal?.throwIfAborted();
            if (signal) {
                const abort = () => {
                    state.reject(signal.reason ?? new Error('BOT_CANCELLED'));
                    aborted.add(state);
                    state.finished.resolve();
                    if (state.msgId) sender._pendingState.delete(state.msgId);
                    const queue = sender._sendQueue;
                    queue._queue = queue._queue.filter(item => item !== state);
                    queue._pendingStates = queue._pendingStates.filter(item => item !== state);
                };
                signal.addEventListener('abort', abort, { once: true });
                void state.promise?.then(() => signal.removeEventListener('abort', abort), () => signal.removeEventListener('abort', abort));
            }
            return enqueue(state);
        };
        return record;
    };
    Object.defineProperty(c, '_sender', { configurable: false, get: () => main,
        set: value => { main = value === undefined ? undefined : protect(value, 'main', value.dcId).sender; } });
    const createSender = c._createExportedSender.bind(c);
    c._createExportedSender = dc => protect(createSender(dc), 'download', dc).sender;
    const connect = c.connect.bind(c);
    c.connect = () => track(async () => {
        assertActive();
        if (!connectAllowed) {
            if (main) lost(records.get(main)!);
            throw failure ?? new Error('BOT_CONNECTION_LOST');
        }
        connectAllowed = false;
        return connect();
    });
    const switchDC = c._switchDC.bind(c);
    c._switchDC = dc => track(async () => {
        assertActive();
        if (!startup) {
            if (main) lost(records.get(main)!);
            throw failure ?? new Error('BOT_CONNECTION_LOST');
        }
        connectAllowed = true;
        return switchDC(dc);
    });
    const start = c.start.bind(c);
    c.start = (...args) => track(async () => {
        assertActive();
        try { return await start(...args); } finally { startup = false; }
    });
    const invoke = c.invoke.bind(c);
    c.invoke = (request, dcId) => { assertActive(); return invoke(request, dcId); };
    const invokeWithSender = c.invokeWithSender.bind(c);
    c.invokeWithSender = (request, sender) => {
        assertActive();
        if (sender) {
            // SDK private declarations differ from the validated instance-owned layout.
            const ownedSender = sender as unknown as BotSender;
            const record = records.get(ownedSender);
            if (!record) throw new Error('BOT_SDK_OWNERSHIP_UNSUPPORTED');
            assertSender(record);
        }
        // Never replay here: callers may be issuing a mutating RPC. Native download
        // iterators call getSender(dc) before every GetFile, including after reopen.
        return invokeWithSender(request, sender);
    };
    c._connectSender = (sender, dcId) => track(async () => {
        const record = records.get(sender) ?? protect(sender, 'download', dcId);
        const work = (async () => {
            assertSender(record);
            const dc = await c.getDC(dcId, !!sender.authKey.getKey());
            assertSender(record);
            await sender.connect(new c._connection({ ip: dc.ipAddress, port: dc.port, dcId,
                loggers: c._log, proxy: c._proxy, testServers: c.testServers, socket: c.networkSocket }), false);
            assertSender(record);
            if (c.session.dcId !== dcId && !sender._authenticated) {
                const auth = await c.invoke(new Api.auth.ExportAuthorization({ dcId }));
                assertSender(record);
                const init = new Api.InitConnection({ ...c._initRequest,
                    query: new Api.auth.ImportAuthorization({ id: auth.id, bytes: auth.bytes }) });
                await sender.send(new Api.InvokeWithLayer({ layer: LAYER, query: init }));
                sender._authenticated = true;
            }
            assertSender(record);
            sender.dcId = dcId;
            return sender;
        })();
        try {
            return await bounded(work, connectTimeout, 'BOT_DC_CONNECTION_LOST', record.cancel);
        } catch (error) {
            lost(record, authCode(error) ? error as Error : new Error('BOT_DC_CONNECTION_LOST'));
            throw record.error ?? error;
        }
    });
    c._borrowExportedSender = (dc, reconnect = false, existing) => {
        assertActive();
        let slot = slots.get(dc);
        if (slot?.authError) return Promise.reject(slot.authError);
        if (slot?.connecting) return slot.promise!;
        if (slot?.record && !slot.record.error) {
            if (slot.record.sender.isConnected() && (!reconnect || (existing && existing !== slot.record.sender))) return slot.promise!;
            lost(slot.record);
        }
        const previous = slot?.record;
        slot = { record: previous, connecting: true };
        slots.set(dc, slot);
        const current = slot;
        current.promise = track(async () => {
            if (previous) await cleanup(previous);
            assertActive();
            const sender = c._createExportedSender(dc);
            current.record = records.get(sender)!;
            return c._connectSender(sender, dc);
        }).finally(() => { current.connecting = false; });
        c._exportedSenderPromises.set(dc, current.promise);
        void current.promise.catch(() => undefined);
        return current.promise;
    };
    c._cleanupExportedSender = async dc => {
        // SDK auth-key callbacks are rebound above to capture the exact generation.
        const record = slots.get(dc)?.record;
        if (!record || closed) return;
        lost(record, new Error('AUTH_KEY_UNREGISTERED'));
        await cleanup(record);
    };
    const destroy = c.destroy.bind(c);
    c.disconnect = async () => {
        // SDK startup migration uses _disconnect directly; public disconnect is a
        // terminal user stop and must never leave a borrow path able to reconnect.
        closed = true;
        for (const record of owned) retire(record, new Error('BOT_CANCELLED'));
        const results = await Promise.allSettled([...owned].map(cleanup));
        while (pending.size) await Promise.allSettled([...pending]);
        c._exportedSenderPromises.clear();
        for (const result of results) if (result.status === 'rejected') throw result.reason;
    };
    c.destroy = () => {
        if (destruction) return destruction;
        closed = true;
        c._destroyed = true;
        for (const timer of c._exportedSenderReleaseTimeouts.values()) clearTimeout(timer);
        c._exportedSenderReleaseTimeouts.clear();
        for (const record of owned) retire(record, new Error('BOT_CANCELLED'));
        destruction = (async () => {
            const results = await Promise.allSettled([destroy(), ...[...owned].map(cleanup)]);
            while (pending.size) await Promise.allSettled([...pending]);
            c._exportedSenderPromises.clear();
            for (const result of results) if (result.status === 'rejected') throw result.reason;
        })();
        return destruction;
    };
    return client;
}
