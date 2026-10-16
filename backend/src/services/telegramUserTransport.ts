import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Api, errors, utils } from 'telegram';
import type { TelegramClient } from 'telegram';
import { RequestState } from 'telegram/network/RequestState.js';
import { Logger } from 'telegram/extensions/Logger.js';
import { LAYER } from 'telegram/tl/AllTLObjects.js';
import type { AuthKey } from 'telegram/crypto/AuthKey.js';
import type { Connection } from 'telegram/network/connection/Connection.js';
import type { MTProtoSender } from 'telegram/network/MTProtoSender.js';
import type { MTProtoState } from 'telegram/network/MTProtoState.js';
import type { ProxyInterface } from 'telegram/network/connection/TCPMTProxy.js';
import { UserNetSocket } from './telegramUserSocket.js';
import { TELEGRAM_EXTREME_FLOOD_WAIT_SECONDS, type TelegramTransportRuntimeEvent } from './telegramWorkerProtocol.js';
import type { BigInteger } from 'big-integer';
import { doAuthentication } from 'telegram/network/Authenticator.js';
import { MTProtoPlainSender } from 'telegram/network/MTProtoPlainSender.js';
import { UpdateConnectionState } from 'telegram/network/index.js';

const require = createRequire(import.meta.url);
const signals = new AsyncLocalStorage<{ signal?: AbortSignal; onWait?: (waiting: boolean) => void }>();
const VERSION = '2.26.22';
const EXHAUSTED: Record<string, true> = { EADDRNOTAVAIL: true, EMFILE: true, ENFILE: true, ENOBUFS: true };

export async function withUserTransportSignal<T>(signal: AbortSignal | undefined, operation: () => Promise<T>, onWait?: (waiting: boolean) => void): Promise<T> {
    signal?.throwIfAborted();
    return signals.run({ signal, onWait }, operation);
}

interface OwnedState extends Omit<RequestState, 'request' | 'promise' | 'after' | 'resolve' | 'reject' | 'isReady'> {
    request: Api.AnyRequest | Api.MsgsAck | Api.MsgsStateInfo;
    promise: Promise<unknown>;
    after?: OwnedState;
    resolve(value?: unknown): void;
    reject(error?: unknown): void;
    isReady(): boolean | Promise<void>;
}
interface Packer {
    _queue: (OwnedState | undefined)[];
    _pendingStates: OwnedState[];
    append(state?: OwnedState, ready?: boolean, atStart?: boolean): void;
    clear(): void;
    wait(): Promise<void>;
    get(): Promise<{ batch: OwnedState[]; data: Buffer } | null | undefined>;
}
interface OwnedConnection extends Omit<Connection, 'socket' | 'recv' | '_recv' | '_sendTask' | '_recvTask' | '_sendArray' | '_recvArray'> {
    socket: UserNetSocket;
    _sendTask?: Promise<void>;
    _recvTask?: Promise<void>;
    recv(): Promise<Buffer>;
    _recv(): Promise<Buffer>;
    _sendArray: TransportQueue<Buffer | undefined>;
    _recvArray: TransportQueue<Buffer | undefined>;
}
interface OwnedSender {
    dcId: number;
    authKey: AuthKey;
    _connection?: OwnedConnection;
    _state: MTProtoState;
    _sendQueue: Packer;
    _pendingState: {
        set(id: BigInteger, state: OwnedState): void;
        delete(id: BigInteger): void;
        values(): OwnedState[];
        clear(): void;
    };
    _pendingAck: Set<BigInteger>;
    _lastAcks: OwnedState[];
    _userConnected: boolean;
    _authenticated: boolean;
    _finishedConnecting: boolean;
    _disconnected: boolean;
    _reconnecting: boolean;
    userDisconnected: boolean;
    isConnecting: boolean;
    isReconnecting: boolean;
    _sendLoopHandle?: Promise<void>;
    _updateCallback?: (client: TelegramClient, update: UpdateConnectionState) => void;
    _recvLoopHandle?: Promise<void>;
    _authKeyCallback?: (key: AuthKey, dc: number) => Promise<void>;
    _autoReconnectCallback?: () => Promise<void>;
    _handleBadAuthKey(skip?: boolean): void;
    _connect(): Promise<void>;
    _disconnect(): Promise<void>;
    _sendLoop(): Promise<void>;
    _recvLoop(): Promise<void>;
    connect(connection: OwnedConnection, force?: boolean): Promise<boolean>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    reconnect(): Promise<void>;
    _reconnect(): Promise<void>;
    send(request: Api.AnyRequest): Promise<unknown>;
    addStateToQueue(state: OwnedState): void;
}
interface OwnedClient extends Omit<TelegramClient, '_sender' | '_connection' | 'networkSocket' | '_createExportedSender' | '_connectSender' | '_borrowExportedSender' | '_exportedSenderPromises' | '_borrowedSenderPromises' | '_eventBuilders' | '_entityCache'> {
    _sender?: OwnedSender;
    _connection: new (options: { ip: string; port: number; dcId: number; loggers: Logger; proxy?: ProxyInterface;
        testServers: boolean; socket: new (proxy?: ProxyInterface) => UserNetSocket }) => OwnedConnection;
    networkSocket: new (proxy?: ProxyInterface) => UserNetSocket;
    _log: Logger;
    _proxy?: ProxyInterface;
    _initRequest: Api.InitConnection;
    _entityCache: { add(value: unknown): void };
    _lastRequest: number;
    _eventBuilders: unknown[];
    _exportedSenderReleaseTimeouts: Map<number, NodeJS.Timeout>;
    _exportedSenderPromises: Map<number, Promise<OwnedSender>>;
    _borrowedSenderPromises: Record<string, Promise<OwnedSender>>;
    _createExportedSender(dc: number): OwnedSender;
    _connectSender(sender: OwnedSender, dc: number): Promise<OwnedSender>;
    _borrowExportedSender(dc: number, reconnect?: boolean, existing?: OwnedSender): Promise<OwnedSender>;
}
interface SenderOwner {
    id: number;
    generation: number;
    failed?: unknown;
    retryAt?: number;
    flight?: Promise<boolean>;
    closed: boolean;
    authorized: boolean;
    states: Set<OwnedState>;
    connections: Set<OwnedConnection>;
}

class TransportQueue<T> {
    private values: T[] = [];
    private waiters: ((value: T) => void)[] = [];
    async push(value: T): Promise<void> {
        const waiter = this.waiters.shift();
        if (waiter) waiter(value);
        else this.values.push(value);
    }
    pop(): Promise<T> {
        if (this.values.length) return Promise.resolve(this.values.shift()!);
        const { promise, resolve } = Promise.withResolvers<T>();
        this.waiters.push(resolve);
        return promise;
    }
}

function transportError(code: string): Error & { code: string } {
    return Object.assign(new Error(code), { code });
}
function errorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
        return /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'USER_TRANSPORT_ERROR';
    }
    return 'USER_TRANSPORT_ERROR';
}

/** Instance-only ownership boundary for the pinned GramJS release. */
export function ownUserTransport<T extends TelegramClient>(client: T, options: { accountId?: string; onRuntimeEvent?: (event: TelegramTransportRuntimeEvent) => void } = {}): T {
    // SDK private fields have no usable public type; keep their fixed-version layout here.
    const c = client as unknown as OwnedClient;
    const packageInfo: unknown = require('telegram/package.json');
    if (!packageInfo || typeof packageInfo !== 'object' || !('version' in packageInfo) || packageInfo.version !== VERSION ||
        c._sender !== undefined || !(c._exportedSenderPromises instanceof Map) ||
        !['connect', 'destroy', '_createExportedSender', '_connectSender', '_borrowExportedSender', '_switchDC', 'invoke'].every(
            key => typeof Reflect.get(c, key) === 'function')) throw transportError('USER_SDK_OWNERSHIP_UNSUPPORTED');

    const account = options.accountId ? createHash('sha256').update(options.accountId).digest('hex').slice(0, 16) : 'login';
    const owners = new Map<OwnedSender, SenderOwner>();
    const sockets = new Set<UserNetSocket>();
    const work = new Set<Promise<unknown>>();
    const terminal = new AbortController();
    let main: OwnedSender | undefined;
    let closing: Promise<void> | undefined;
    let clientFlight: Promise<boolean> | undefined;
    let initialized = false;
    let migrationFlight: Promise<boolean> | undefined;
    let circuitUntil = 0;
    let accountFailure: unknown;
    let floodUntil = 0;
    let fragmentLimit = 12;
    let floodEpisode = 0;
    let reducedFloodEpisode = 0;
    let successfulReads = 0;
    let recoverySince: number | undefined;
    let recoveryReads = 0;
    let lastFileSuccess = 0;
    let lastSuccessEvent = 0;
    let fileActive = 0;
    const dcFailures = new Map<number, { retryAt: number; error: Error }>();
    const dcClosures = new Map<number, Promise<void>>();
    const exportedSenders = new Map<number, OwnedSender>();
    const gateWake = new Set<() => void>();
    let nextSender = 0;
    let lastDiagnostic = 0;
    let suppressed = 0;
    const log = new Logger();
    log.canSend = () => false;
    c._log = log;
    const assertOpen = () => {
        if (terminal.signal.aborted) throw transportError('USER_TRANSPORT_CLOSED');
        if (accountFailure) throw accountFailure;
    };
    const diagnostic = (event: string, sender?: OwnedSender, error?: unknown, cooldown?: { seconds: number; until: number }) => {
        const now = Date.now();
        if (now - lastDiagnostic < 5000) { suppressed++; return; }
        lastDiagnostic = now;
        const owner = sender ? owners.get(sender) : undefined;
        console.warn(JSON.stringify({ event, account, dc: sender?.dcId, sender: owner?.id,
            generation: owner?.generation, code: error === undefined ? undefined : errorCode(error), suppressed,
            seconds: cooldown?.seconds, until: cooldown?.until, fragmentLimit, activeFragments: fileActive }));
        suppressed = 0;
    };
    const onSocketError = (error: unknown) => {
        const code = errorCode(error);
        if (EXHAUSTED[code]) { circuitUntil = Math.max(circuitUntil, Date.now() + 60_000); diagnostic('user_socket_circuit', undefined, error); }
    };
    const track = <R>(promise: Promise<R>): Promise<R> => {
        work.add(promise);
        void promise.then(() => work.delete(promise), () => work.delete(promise));
        return promise;
    };
    const signalForCall = () => {
        const signal = signals.getStore()?.signal;
        return signal ? AbortSignal.any([signal, terminal.signal]) : terminal.signal;
    };
    const waitFor = <R>(promise: Promise<R>, signal: AbortSignal): Promise<R> => {
        signal.throwIfAborted();
        const pending = Promise.withResolvers<R>();
        const abort = () => { signal.removeEventListener('abort', abort); pending.reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        void promise.then(pending.resolve, pending.reject).finally(() => signal.removeEventListener('abort', abort));
        return pending.promise;
    };
    const delay = (ms: number, signal: AbortSignal): Promise<void> => {
        const pending = Promise.withResolvers<void>();
        if (signal.aborted) { pending.reject(signal.reason); return pending.promise; }
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); pending.reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); pending.resolve(); }, Math.max(0, ms));
        signal.addEventListener('abort', abort, { once: true });
        return pending.promise;
    };
    const waiting = async <R>(operation: () => Promise<R>): Promise<R> => {
        const notify = signals.getStore()?.onWait;
        notify?.(true);
        try { return await operation(); } finally { notify?.(false); }
    };
    const wakeGate = () => { for (const wake of gateWake) wake(); gateWake.clear(); };
    const acquire = async (file: boolean, signal: AbortSignal, liveness: boolean): Promise<() => void> => {
        for (;;) {
            signal.throwIfAborted();
            // Heartbeats keep the socket alive during server-mandated business cooldowns.
            if (!liveness && floodUntil > Date.now()) { await waiting(() => delay(floodUntil - Date.now(), signal)); continue; }
            if (!file || fileActive < fragmentLimit) {
                if (file) fileActive++;
                return () => { if (file) fileActive--; wakeGate(); };
            }
            const pending = Promise.withResolvers<void>();
            const abort = () => { gateWake.delete(wake); signal.removeEventListener('abort', abort); pending.reject(signal.reason); };
            const wake = () => { signal.removeEventListener('abort', abort); pending.resolve(); };
            gateWake.add(wake);
            signal.addEventListener('abort', abort, { once: true });
            await waiting(() => pending.promise);
        }
    };
    class AccountSocket extends UserNetSocket {
        constructor(proxy?: ProxyInterface) {
            super(proxy, { assertOpen, beforeConnect: () => {
                if (Date.now() < circuitUntil) throw transportError('USER_RESOURCE_CIRCUIT_OPEN');
            }, socketError: onSocketError });
            sockets.add(this);
        }
        async connect(port: number, ip: string): Promise<void> {
            sockets.add(this);
            try { await super.connect(port, ip); }
            catch (error) { sockets.delete(this); throw error; }
        }
        async close(): Promise<void> {
            await super.close();
            sockets.delete(this);
        }
    }
    c.networkSocket = AccountSocket;

    const ownConnection = (connection: OwnedConnection, owner: SenderOwner): OwnedConnection => {
        if (owner.connections.has(connection)) return connection;
        owner.connections.add(connection);
        connection._sendArray = new TransportQueue<Buffer | undefined>();
        connection._recvArray = new TransportQueue<Buffer | undefined>();
        const open = connection._connect.bind(connection);
        connection._connect = async () => {
            assertOpen();
            if (owner.closed) throw transportError('USER_SENDER_CLOSED');
            const generation = owner.generation;
            try {
                await open();
                assertOpen();
                if (owner.closed || owner.generation !== generation) throw transportError('USER_CONNECTION_SUPERSEDED');
            } catch (error) { await connection.disconnect(); throw error; }
        };
        connection.disconnect = async () => {
            connection._connected = false;
            // Wake both SDK queues even when opening never set _connected.
            void connection._recvArray.push(undefined);
            void connection._sendArray.push(undefined);
            await connection.socket.close();
            await Promise.allSettled([connection._sendTask, connection._recvTask]);
            connection._sendTask = undefined;
            connection._recvTask = undefined;
        };
        const connected = connection.isConnected.bind(connection);
        connection.isConnected = () => !owner.closed && !terminal.signal.aborted && connected();
        return connection;
    };
    const removeState = (sender: OwnedSender, state: OwnedState) => {
        sender._sendQueue._queue = sender._sendQueue._queue.filter(s => s !== state);
        sender._sendQueue._pendingStates = sender._sendQueue._pendingStates.filter(s => s !== state);
        if (state.msgId) sender._pendingState.delete(state.msgId);
        for (const other of sender._sendQueue._pendingStates) if (other.after === state) other.after = undefined;
    };
    const rejectStates = (sender: OwnedSender, owner: SenderOwner, error: unknown) => {
        for (const state of owner.states) { removeState(sender, state); state.reject(error); state.finished.resolve(); }
        owner.states.clear();
        for (const state of sender._pendingState.values()) state.reject(error);
        for (const state of sender._sendQueue._pendingStates) {
            state.reject(error);
            state.finished.resolve();
        }
        sender._sendQueue._pendingStates = [];
        sender._pendingState.clear();
        sender._sendQueue.clear();
        sender._pendingAck.clear();
        sender._lastAcks.length = 0;
    };
    const stop = async (sender: OwnedSender, owner: SenderOwner, error: unknown) => {
        sender._userConnected = false;
        sender.isReconnecting = true;
        rejectStates(sender, owner, error);
        const connections = [...owner.connections];
        const closedConnections = await Promise.allSettled(connections.map(connection => connection.disconnect()));
        closedConnections.forEach((result, index) => {
            if (result.status === 'fulfilled') owner.connections.delete(connections[index]);
        });
        const closedLoops = await Promise.allSettled([sender._sendLoopHandle, sender._recvLoopHandle]);
        sender._sendLoopHandle = undefined;
        sender._recvLoopHandle = undefined;
        sender._disconnected = true;
        const failures = [...closedConnections, ...closedLoops].filter(result => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'USER_CONNECTION_CLOSE_FAILED');
    };
    const enqueue = async (sender: OwnedSender, owner: SenderOwner, state: OwnedState, signal: AbortSignal): Promise<unknown> => {
        let query: unknown = state.request;
        while (query && typeof query === 'object' && 'query' in query) query = query.query;
        const file = query instanceof Api.upload.GetFile;
        const liveness = query instanceof Api.Ping || query instanceof Api.PingDelayDisconnect;
        const release = await acquire(file, signal, liveness);
        const requestEpisode = floodEpisode;
        let timer: NodeJS.Timeout | undefined;
        const abort = () => { removeState(sender, state); owner.states.delete(state); state.reject(signal.reason); state.finished.resolve(); };
        try {
            assertOpen(); signal.throwIfAborted();
            if (owner.closed) throw transportError('USER_SENDER_CLOSED');
            if (!sender.isConnected()) await waiting(() => waitFor(sender._reconnect(), signal));
            signal.throwIfAborted();
            owner.states.add(state);
            signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => {
                removeState(sender, state); owner.states.delete(state);
                state.reject(transportError('USER_REQUEST_TIMEOUT')); state.finished.resolve();
            }, 30_000);
            sender._sendQueue.append(state);
            const result = await state.promise;
            if (file && result instanceof Api.upload.File && result.bytes.length > 0 && requestEpisode === floodEpisode && floodUntil <= Date.now()) {
                const now = Date.now();
                successfulReads++;
                if (!lastFileSuccess || now - lastFileSuccess > 60_000) { recoverySince = now; recoveryReads = 0; }
                lastFileSuccess = now;
                recoverySince ??= now;
                recoveryReads++;
                let recovered = false;
                if (fragmentLimit < 12 && now - recoverySince >= 60_000 && recoveryReads >= fragmentLimit * 4) {
                    fragmentLimit++;
                    recoverySince = now;
                    recoveryReads = 0;
                    recovered = true;
                    wakeGate();
                }
                if (now - lastSuccessEvent >= 1_000 || recovered) {
                    lastSuccessEvent = now;
                    options.onRuntimeEvent?.({ type: 'file_success', at: now, episode: floodEpisode, successfulReads,
                        fragmentLimit, activeFragments: fileActive });
                }
            }
            return result;
        } catch (error) {
            if (error instanceof errors.FloodWaitError || error instanceof errors.FloodTestPhoneWaitError) {
                const seconds = error.seconds;
                if (Number.isSafeInteger(seconds) && seconds >= 0) {
                    floodUntil = Math.max(floodUntil, Date.now() + seconds * 1000);
                    // Requests admitted before this flood are siblings, not new episodes.
                    if (requestEpisode === floodEpisode) {
                        floodEpisode++;
                        successfulReads = 0;
                    }
                    if (seconds >= TELEGRAM_EXTREME_FLOOD_WAIT_SECONDS && reducedFloodEpisode !== floodEpisode) {
                        fragmentLimit = Math.max(1, Math.floor(fragmentLimit / 2));
                        reducedFloodEpisode = floodEpisode;
                    }
                    recoverySince = undefined;
                    recoveryReads = 0;
                    lastFileSuccess = 0;
                    options.onRuntimeEvent?.({ type: 'cooldown', seconds, until: floodUntil,
                        reason: error instanceof errors.FloodTestPhoneWaitError ? 'FLOOD_TEST_PHONE_WAIT' : 'FLOOD_WAIT',
                        file, episode: floodEpisode, fragmentLimit, activeFragments: fileActive });
                    diagnostic('user_flood_cooldown', sender, undefined, { seconds, until: floodUntil });
                    wakeGate();
                }
            }
            throw error;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            owner.states.delete(state);
            removeState(sender, state);
            state.finished.resolve();
            release();
        }
    };
    const protect = (sender: OwnedSender): OwnedSender => {
        assertOpen();
        if (owners.has(sender)) return sender;
        if (!sender._sendQueue || !sender._pendingState || typeof sender._connect !== 'function') throw transportError('USER_SDK_OWNERSHIP_UNSUPPORTED');
        const owner: SenderOwner = { id: ++nextSender, generation: 0, closed: false,
            authorized: !!sender.authKey.getKey(), states: new Set(), connections: new Set() };
        owners.set(sender, owner);
        const connectOnce = async () => {
            const generation = owner.generation;
            const connection = sender._connection!;
            const assertGeneration = () => {
                assertOpen();
                if (owner.closed || owner.generation !== generation || !connection.isConnected()) {
                    throw transportError('USER_CONNECTION_SUPERSEDED');
                }
            };
            await connection.connect();
            assertGeneration();
            if (!sender.authKey.getKey()) {
                const plain = new MTProtoPlainSender(connection, log);
                const authenticated = await doAuthentication(plain, log);
                assertGeneration();
                await sender.authKey.setKey(authenticated.authKey);
                sender._state.timeOffset = authenticated.timeOffset;
                await sender._authKeyCallback?.(sender.authKey, sender.dcId);
                assertGeneration();
            }
            sender._userConnected = true;
            sender.isReconnecting = false;
            sender._sendLoopHandle = sender._sendLoop();
            sender._recvLoopHandle = sender._recvLoop();
            for (const loop of [sender._sendLoopHandle, sender._recvLoopHandle]) {
                void loop.catch(error => {
                    if (!owner.closed && !terminal.signal.aborted && owner.generation === generation) {
                        diagnostic('user_sender_loop_error', sender, error);
                        void sender.reconnect().catch(() => undefined);
                    }
                });
            }
            sender._updateCallback?.(client, new UpdateConnectionState(UpdateConnectionState.connected));
        };
        sender._connect = connectOnce;
        const saveKey = sender._authKeyCallback;
        sender._authKeyCallback = async (key, dc) => {
            assertOpen();
            if (owner.closed) throw transportError('USER_SENDER_CLOSED');
            await saveKey?.(key, dc);
            assertOpen();
            if (owner.closed) throw transportError('USER_SENDER_CLOSED');
        };
        sender.isConnected = () => !accountFailure && !terminal.signal.aborted && !owner.closed && !owner.failed &&
            !sender.isConnecting && !sender.isReconnecting && sender._userConnected && !!sender._connection?.isConnected();
        // Own the send loop so states canceled while packing/encrypting cannot be
        // reinserted into pending state or sent as part of a stale batch.
        sender._sendLoop = async () => {
            const generation = owner.generation;
            while (sender._userConnected && !sender.isReconnecting && owner.generation === generation) {
                if (sender._pendingAck.size) {
                    const ack = new RequestState(new Api.MsgsAck({ msgIds: Array.from(sender._pendingAck) }));
                    // GramJS RequestState declarations lose the request/result types.
                    const ownedAck = ack as unknown as OwnedState;
                    sender._sendQueue.append(ownedAck);
                    sender._pendingAck.clear();
                }
                await sender._sendQueue.wait();
                if (!sender._userConnected || sender.isReconnecting || owner.generation !== generation) return;
                const packed = await sender._sendQueue.get();
                if (!packed) continue;
                const active = (state: OwnedState) => state.request.classType !== 'request' || owner.states.has(state);
                const stale = () => !sender._userConnected || sender.isReconnecting || owner.generation !== generation;
                if (stale()) return;
                if (packed.batch.some(state => !active(state))) {
                    for (const state of packed.batch) if (active(state)) sender._sendQueue.append(state);
                    continue;
                }
                const data = await sender._state.encryptMessageData(packed.data);
                if (stale()) return;
                if (packed.batch.some(state => !active(state))) {
                    for (const state of packed.batch) if (active(state)) sender._sendQueue.append(state);
                    continue;
                }
                for (const state of packed.batch) if (state.request.classType === 'request' && state.msgId) {
                    sender._pendingState.set(state.msgId, state);
                }
                try { await sender._connection!.send(data); }
                catch { void sender.reconnect().catch(() => undefined); return; }
            }
        };
        sender.send = (request: Api.AnyRequest) => {
            const state = new RequestState(request);
            // Fixed-version RequestState has a promise immediately after construction.
            const ownedState = state as unknown as OwnedState;
            void ownedState.promise.catch(() => undefined);
            return track(enqueue(sender, owner, ownedState, signalForCall()).catch(error => {
                ownedState.reject(error);
                ownedState.finished.resolve();
                throw error;
            }));
        };
        sender.addStateToQueue = state => {
            assertOpen();
            // SDK salt/sequence repair may only requeue a still-owned request.
            if (!owner.closed && owner.states.has(state)) sender._sendQueue.append(state);
        };
        const newConnection = (old: OwnedConnection): OwnedConnection => new c._connection({
            ip: old._ip, port: old._port, dcId: old._dcId, loggers: c._log,
            proxy: old._proxy, testServers: old._testServers, socket: c.networkSocket,
        });
        const connect = (connection?: OwnedConnection, force = false): Promise<boolean> => {
            try {
                assertOpen();
                if (owner.closed) throw transportError('USER_SENDER_CLOSED');
                if (owner.failed && Date.now() >= (owner.retryAt || Infinity)) owner.failed = undefined;
                if (owner.failed) throw owner.failed;
                if (owner.flight) {
                    if (connection && connection !== sender._connection) void connection.socket.close();
                    return owner.flight;
                }
                if (sender.isConnected() && !force) {
                    if (connection && connection !== sender._connection) void connection.socket.close();
                    return Promise.resolve(true);
                }
            } catch (error) { return Promise.reject(error); }
            const flight = track((async () => {
                const start = Date.now();
                ++owner.generation;
                sender.isConnecting = true;
                sender.isReconnecting = true;
                sender.userDisconnected = false;
                sender._finishedConnecting = false;
                await stop(sender, owner, transportError('USER_CONNECTION_LOST'));
                let candidate = connection || (sender._connection && newConnection(sender._connection));
                if (!candidate) throw transportError('USER_NO_CONNECTION');
                let lastError: unknown = transportError('USER_CONNECT_FAILED');
                for (let attempt = 0; attempt < 5; attempt++) {
                    assertOpen();
                    if (owner.closed) throw transportError('USER_SENDER_CLOSED');
                    if (Date.now() < circuitUntil) throw transportError('USER_RESOURCE_CIRCUIT_OPEN');
                    if (attempt) {
                        const pause = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
                        await delay(pause, terminal.signal);
                        candidate = newConnection(candidate);
                    }
                    sender._connection = ownConnection(candidate, owner);
                    sender._state.reset();
                    const remaining = 58_000 - (Date.now() - start);
                    if (remaining <= 0) break;
                    const timeout = setTimeout(() => {
                        lastError = transportError('USER_CONNECT_TIMEOUT');
                        void candidate!.disconnect();
                    }, Math.min(8000, remaining));
                    try {
                        await connectOnce();
                        assertOpen();
                        if (owner.closed || !candidate.isConnected()) throw transportError('USER_CONNECTION_LOST');
                        sender._finishedConnecting = true;
                        sender._disconnected = false;
                        sender.isConnecting = false;
                        sender.isReconnecting = false;
                        diagnostic('user_sender_connected', sender);
                        return true;
                    } catch (error) {
                        lastError = error;
                        onSocketError(error);
                        await stop(sender, owner, error);
                        diagnostic('user_sender_connect_error', sender, error);
                        if (Date.now() < circuitUntil || terminal.signal.aborted || owner.closed) throw error;
                    } finally { clearTimeout(timeout); }
                }
                throw lastError;
            })());
            owner.flight = flight;
            void flight.then(() => { owner.flight = undefined; }, error => {
                owner.flight = undefined;
                if (!owner.closed && !terminal.signal.aborted) {
                    owner.failed = error;
                    owner.retryAt = Date.now() + 10_000;
                    if (sender === main || Date.now() < circuitUntil) accountFailure = error;
                }
                sender.isConnecting = sender.isReconnecting = false;
                sender._userConnected = false;
                rejectStates(sender, owner, error);
            });
            return flight;
        };
        sender.connect = connect;
        sender.reconnect = sender._reconnect = () => {
            const result = connect(undefined, true).then(() => undefined);
            // SDK invokes reconnect without awaiting its promise.
            void result.catch(() => undefined);
            return result;
        };
        sender._autoReconnectCallback = undefined;
        sender._handleBadAuthKey = skip => {
            if (skip && sender === main) return;
            owner.failed = transportError('USER_AUTH_KEY_INVALID');
            if (sender === main) accountFailure = owner.failed;
            diagnostic('user_auth_key_invalid', sender, owner.failed);
            void sender.disconnect().catch(() => undefined);
        };
        let disconnectFlight: Promise<void> | undefined;
        sender.disconnect = sender._disconnect = () => {
            if (disconnectFlight) return disconnectFlight;
            owner.closed = true;
            ++owner.generation;
            sender.userDisconnected = true;
            disconnectFlight = track((async () => {
                await stop(sender, owner, transportError('USER_SENDER_CLOSED'));
                await Promise.allSettled([owner.flight]);
                await stop(sender, owner, transportError('USER_SENDER_CLOSED'));
                sender.isConnecting = sender.isReconnecting = false;
            })());
            return disconnectFlight;
        };
        return sender;
    };
    Object.defineProperty(c, '_sender', { configurable: false, get: () => main,
        set: (sender: OwnedSender | undefined) => { main = sender === undefined ? undefined : protect(sender); } });
    const create = c._createExportedSender.bind(c);
    c._createExportedSender = dc => protect(create(dc));
    c._connectSender = (sender, dcId) => track(signals.run({}, async () => {
        assertOpen(); protect(sender);
        const dc = await c.getDC(dcId, !!sender.authKey.getKey());
        assertOpen();
        await sender.connect(new c._connection({ ip: dc.ipAddress, port: dc.port, dcId,
            loggers: c._log, proxy: c._proxy, testServers: c.testServers, socket: c.networkSocket }));
        if (c.session.dcId !== dcId && !owners.get(sender)!.authorized) {
            const auth = await c.invoke(new Api.auth.ExportAuthorization({ dcId }));
            const init = new Api.InitConnection({ ...c._initRequest,
                query: new Api.auth.ImportAuthorization({ id: auth.id, bytes: auth.bytes }) });
            await sender.send(new Api.InvokeWithLayer({ layer: LAYER, query: init }));
            sender._authenticated = true;
            owners.get(sender)!.authorized = true;
        }
        assertOpen(); sender.dcId = dcId;
        return sender;
    }).catch(async error => {
        if (!terminal.signal.aborted && (sender === main || Date.now() < circuitUntil)) accountFailure = error;
        await sender.disconnect();
        throw error;
    }));
    c._borrowExportedSender = async (dc, reconnect = false, existing) => {
        assertOpen();
        const signal = signalForCall();
        const closure = dcClosures.get(dc);
        if (closure) await waiting(() => waitFor(closure, signal));
        const failure = dcFailures.get(dc);
        if (failure && Date.now() < failure.retryAt) throw failure.error;
        dcFailures.delete(dc);
        let promise = c._exportedSenderPromises.get(dc);
        if (!promise) {
            const sender = existing || c._createExportedSender(dc);
            exportedSenders.set(dc, sender);
            promise = c._connectSender(sender, dc);
            c._exportedSenderPromises.set(dc, promise);
            void promise.catch(() => undefined);
        }
        try {
            const sender = await waiting(() => waitFor(promise!, signal));
            assertOpen();
            if (reconnect || !sender.isConnected()) await waiting(() => waitFor(sender._reconnect(), signal));
            return sender;
        } catch (error) {
            signal.throwIfAborted();
            assertOpen();
            const unavailable = transportError('USER_DC_UNAVAILABLE');
            const failedSender = exportedSenders.get(dc);
            if (failedSender && c._exportedSenderPromises.get(dc) === promise && !dcClosures.has(dc)) {
                dcFailures.set(dc, { retryAt: Date.now() + 10_000, error: unavailable });
                const retired = track((async () => {
                    try {
                        await failedSender.disconnect();
                        if (c._exportedSenderPromises.get(dc) === promise) {
                            c._exportedSenderPromises.delete(dc);
                            exportedSenders.delete(dc);
                        }
                        owners.delete(failedSender);
                    } catch (closeError) {
                        dcFailures.set(dc, { retryAt: Infinity, error: transportError('USER_DC_CLOSE_FAILED') });
                        throw closeError;
                    }
                })());
                dcClosures.set(dc, retired);
                void retired.then(() => dcClosures.delete(dc), () => dcClosures.delete(dc));
            }
            const retiring = dcClosures.get(dc);
            if (retiring) await waiting(() => waitFor(retiring, signal));
            diagnostic('user_dc_unavailable', failedSender, error);
            throw unavailable;
        }
    };
    c._cleanupExportedSender = async dc => {
        const sender = await c._exportedSenderPromises.get(dc);
        if (sender) await sender.disconnect();
    };
    const nativeConnect = c.connect.bind(c);
    c.connect = () => {
        try { assertOpen(); } catch (error) { return Promise.reject(error); }
        if (clientFlight) return clientFlight;
        if (initialized && main?.isConnected() && !c._isSwitchingDc) return Promise.resolve(true);
        const flight = track(nativeConnect());
        clientFlight = flight;
        void flight.then(result => { initialized = result; clientFlight = undefined; }, () => { clientFlight = undefined; });
        return flight;
    };
    const nativeSwitch = c._switchDC.bind(c);
    c._switchDC = dc => {
        assertOpen();
        if (migrationFlight) return migrationFlight;
        const flight = track(nativeSwitch(dc));
        migrationFlight = flight;
        void flight.then(() => { migrationFlight = undefined; }, () => { migrationFlight = undefined; });
        return flight;
    };
    // Replay only idempotent GetFile reads; mutations keep their original failure.
    const invoke = async <R extends Api.AnyRequest>(request: R, dc?: number, supplied?: OwnedSender): Promise<R['__response']> => {
        const signal = signalForCall();
        assertOpen(); signal.throwIfAborted();
        if (request.classType !== 'request') throw new Error('You can only invoke MTProtoRequests');
        await waitFor(c._connectedDeferred.promise, signal);
        await waitFor(request.resolve(client, utils), signal);
        c._lastRequest = Date.now();
        for (let attempt = 0; attempt < 5; attempt++) {
            const sender = supplied || (dc ? await waitFor(c._borrowExportedSender(dc), signal) : main);
            if (!sender) throw transportError('USER_DISCONNECTED');
            try {
                let result: unknown;
                for (let retry = 0; ; retry++) {
                    try { result = await sender.send(request); break; }
                    catch (error) {
                        const message = error && typeof error === 'object' && 'errorMessage' in error && typeof error.errorMessage === 'string'
                            ? error.errorMessage : error instanceof Error ? error.message : '';
                        const transient = error instanceof errors.ServerError || /^(USER_CONNECTION_LOST|USER_REQUEST_TIMEOUT|ECONNRESET|ETIMEDOUT|RPC_CALL_FAIL|RPC_MCGET_FAIL|TIMEOUT|Timeout)$/.test(message);
                        if (!(request instanceof Api.upload.GetFile) || retry >= 2 || !transient) throw error;
                        signal.throwIfAborted();
                        await waiting(() => delay(300 * 2 ** retry + Math.floor(Math.random() * 200), signal));
                    }
                }
                c.session.processEntities(result);
                c._entityCache.add(result);
                // The response is decoded by this TL request's readResult in GramJS.
                const response = result as unknown as R['__response'];
                return response;
            } catch (error) {
                if (error instanceof errors.PhoneMigrateError || error instanceof errors.NetworkMigrateError || error instanceof errors.UserMigrateError) {
                    if (!(error instanceof errors.UserMigrateError) && await c.isUserAuthorized()) throw error;
                    if (supplied || attempt === 4) throw error;
                    await waitFor(c._switchDC(error.newDc), signal);
                } else throw error;
            }
        }
        throw transportError('USER_MIGRATION_LIMIT');
    };
    c.invoke = (request, dc) => track(invoke(request, dc));
    c.invokeWithSender = (request, sender?: MTProtoSender) => {
        if (!sender) return track(invoke(request));
        // Consumer receives actual GramJS senders; their private layout is pinned above.
        const ownedSender = sender as unknown as OwnedSender;
        if (!owners.has(ownedSender)) return Promise.reject(transportError('USER_UNOWNED_SENDER'));
        return track(invoke(request, undefined, ownedSender));
    };
    const close = (): Promise<void> => {
        if (closing) return closing;
        terminal.abort(transportError('USER_TRANSPORT_CLOSED'));
        c._destroyed = true;
        wakeGate();
        for (const timer of c._exportedSenderReleaseTimeouts.values()) clearTimeout(timer);
        c._exportedSenderReleaseTimeouts.clear();
        const promise = (async () => {
            const failures: unknown[] = [];
            const collect = (results: PromiseSettledResult<unknown>[]) => {
                for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
            };
            collect(await Promise.allSettled([...sockets].map(socket => socket.close())));
            collect(await Promise.allSettled([...owners.keys()].map(sender => sender.disconnect())));
            while (work.size) await Promise.allSettled([...work]);
            await Promise.allSettled([...c._exportedSenderPromises.values(), ...Object.values(c._borrowedSenderPromises)]);
            collect(await Promise.allSettled([...owners.keys()].map(sender => sender.disconnect())));
            collect(await Promise.allSettled([...sockets].map(socket => socket.close())));
            c._exportedSenderPromises.clear();
            c._borrowedSenderPromises = {};
            c._eventBuilders = [];
            sockets.clear();
            dcFailures.clear();
            dcClosures.clear();
            exportedSenders.clear();
            if (failures.length) throw new AggregateError(failures, 'USER_TRANSPORT_CLOSE_FAILED');
        })();
        closing = promise;
        return promise;
    };
    c.disconnect = c.destroy = close;
    return client;
}
