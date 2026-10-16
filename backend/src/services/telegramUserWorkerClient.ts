import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TelegramClient, Api, utils } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import bigInt from 'big-integer';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { DirectDownloadIter, type IterDownloadFunction, type DownloadMediaInterface } from 'telegram/client/downloads.js';
import { encodeTelegramValue, decodeTelegramValue, parseWorkerResponse, type TelegramTransportRuntimeEvent } from './telegramWorkerProtocol.js';
import { telegramOperationSignal } from './telegramOperationContext.js';

interface PendingCall {
    resolve(value: unknown): void;
    reject(error: Error): void;
    cleanup(): void;
    setWaiting(waiting: boolean): void;
    cancelTimer?: NodeJS.Timeout;
    cancellation?: Error;
    progress?: (downloaded: number, total: number) => void | Promise<void>;
}

class RemoteDownloadIterator extends DirectDownloadIter {
    constructor(client: TelegramUserWorkerClient, private readonly owner: TelegramUserWorkerClient, private readonly params: IterDownloadFunction) { super(client); }
    override [Symbol.asyncIterator](): AsyncIterator<Buffer> {
        let handle: number | undefined;
        let finished = false;
        return {
            next: async () => {
                if (finished) return { done: true, value: undefined };
                handle ??= await this.owner.call<number>('open', [this.params]);
                const result = await this.owner.call<IteratorResult<Buffer>>('next', [handle]);
                if (result.done) finished = true;
                return result;
            },
            return: async () => {
                finished = true;
                if (handle !== undefined && this.owner.connected) await this.owner.call('return', [handle], undefined, null);
                return { done: true, value: undefined };
            },
        };
    }
}

/** SDK-facing facade: no MTProto sockets or sender loops run in the HTTP process. */
export class TelegramUserWorkerClient extends TelegramClient {
    private child?: ChildProcess;
    private live = false;
    private closing = false;
    private sequence = 0;
    private heartbeatAt = 0;
    private watchdog?: NodeJS.Timeout;
    private readonly pending = new Map<number, PendingCall>();
    private connectFlight?: Promise<boolean>;
    private closeFlight?: Promise<void>;
    private exitFlight?: Promise<void>;
    private runtimeEventHandler?: (event: TelegramTransportRuntimeEvent) => void;

    constructor(session: string, private readonly credentials: { apiId: number; apiHash: string }, private readonly accountId: string) {
        super(new StringSession(session), credentials.apiId, credentials.apiHash, { connectionRetries: 1, useWSS: false });
        this.setLogLevel(LogLevel.NONE);
    }
    override get connected() { return this.live && !this.closing; }
    get runtimeProcessId() { return this.child?.pid; }
    setRuntimeEventHandler(handler: ((event: TelegramTransportRuntimeEvent) => void) | undefined): void { this.runtimeEventHandler = handler; }

    override connect(): Promise<boolean> {
        if (this.closing) return Promise.reject(new Error('TELEGRAM_WORKER_CLOSED'));
        if (this.connectFlight) return this.connectFlight;
        this.connectFlight = this.spawnWorker();
        return this.connectFlight;
    }
    private async spawnWorker() {
        // StringSession.save() is empty until load installs its serialized auth key.
        await this.session.load();
        if (this.closing) throw new Error('TELEGRAM_WORKER_CLOSED');
        const sourceMode = import.meta.url.endsWith('.ts');
        const worker = fileURLToPath(new URL(sourceMode ? './telegramUserWorker.ts' : './telegramUserWorker.js', import.meta.url));
        const child = fork(worker, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            execArgv: sourceMode ? ['--import', 'tsx'] : [], env: { ...process.env, TELEGRAM_WORKER_ACCOUNT_ID: this.accountId } });
        this.child = child;
        this.heartbeatAt = Date.now();
        this.exitFlight = new Promise<void>(resolve => child.once('close', () => {
            this.live = false;
            clearInterval(this.watchdog);
            this.failPending(new Error('TELEGRAM_WORKER_EXITED'));
            resolve();
        }));
        child.on('error', (error: Error) => this.failPending(error));
        child.on('message', async (raw: unknown) => {
            try {
                const message = parseWorkerResponse(raw);
                if (message.runtime) {
                    if (!this.closing && this.child === child) {
                        try { this.runtimeEventHandler?.(message.runtime); }
                        catch (error) {
                            console.error(JSON.stringify({ event: 'telegram_worker_runtime_callback_failed', accountId: this.accountId,
                                error: error instanceof Error ? error.message : String(error) }));
                        }
                    }
                    return;
                }
                if (message.connected !== undefined) this.live = message.connected;
                if (message.heartbeat) { this.heartbeatAt = Date.now(); return; }
                if (message.session) {
                    const session = new StringSession(message.session);
                    await session.load();
                    this.session = session;
                }
                const call = this.pending.get(message.id);
                if (!call) return;
                if (message.waiting !== undefined) { call.setWaiting(message.waiting); return; }
                if (message.progress) {
                    void Promise.resolve(call.progress?.(...message.progress)).then(() => {
                        if (child.connected) child.send({ id: message.id, method: 'progressAck', args: [] });
                    }).catch((error: unknown) => this.cancel(message.id, error));
                    return;
                }
                this.pending.delete(message.id);
                clearTimeout(call.cancelTimer);
                call.cleanup();
                if (call.cancellation) call.reject(call.cancellation);
                else if (message.error) call.reject(Object.assign(new Error(message.error.message), message.error));
                else call.resolve(decodeTelegramValue(message.value));
            } catch { this.failPending(new Error('TELEGRAM_WORKER_INVALID_RESPONSE')); child.kill('SIGKILL'); }
        });
        this.watchdog = setInterval(() => {
            if (!this.closing && Date.now() - this.heartbeatAt > 10_000) {
                console.error(JSON.stringify({ event: 'telegram_worker_unresponsive', accountId: this.accountId }));
                this.live = false;
                child.kill('SIGKILL');
            }
        }, 1_000);
        this.watchdog.unref();
        try { return await this.call<boolean>('initialize', [this.session.save(), this.credentials.apiId, this.credentials.apiHash, this.accountId], undefined, undefined, 90_000); }
        catch (error) { await this.destroy(); throw error; }
    }
    private cancel(id: number, reason: unknown) {
        const child = this.child;
        if (!child?.connected || !this.pending.has(id)) return;
        const call = this.pending.get(id);
        if (!call || call.cancelTimer) return;
        call.cancellation = reason instanceof Error ? reason : new DOMException('Cancelled', 'AbortError');
        child.send({ id, method: 'cancel', args: [] });
        call.cancelTimer = setTimeout(() => {
            if (!this.pending.has(id)) return;
            this.live = false;
            this.failPending(reason instanceof Error ? reason : new Error('TELEGRAM_WORKER_CANCEL_TIMEOUT'));
            child.kill('SIGKILL');
        }, 5_000);
        call.cancelTimer.unref();
    }
    private failPending(error: Error) {
        for (const call of this.pending.values()) { clearTimeout(call.cancelTimer); call.cleanup(); call.reject(error); }
        this.pending.clear();
    }
    async call<T = unknown>(method: string, args: unknown[], progress?: PendingCall['progress'], signal: AbortSignal | null | undefined = telegramOperationSignal(), timeoutMs = 120_000): Promise<T> {
        signal?.throwIfAborted();
        const child = this.child;
        if (!child?.connected) throw new Error('TELEGRAM_WORKER_UNAVAILABLE');
        const id = ++this.sequence;
        const result = new Promise<unknown>((resolve, reject) => {
            const abort = () => this.cancel(id, signal?.reason);
            let remaining = timeoutMs;
            let activeSince = Date.now();
            let waiting = false;
            const expired = () => this.cancel(id, new Error('TELEGRAM_WORKER_REQUEST_TIMEOUT'));
            let timer = setTimeout(expired, remaining);
            timer.unref();
            const setWaiting = (next: boolean) => {
                if (next === waiting) return;
                waiting = next;
                clearTimeout(timer);
                if (waiting) remaining = Math.max(1, remaining - (Date.now() - activeSince));
                else { activeSince = Date.now(); timer = setTimeout(expired, remaining); timer.unref(); }
            };
            this.pending.set(id, { resolve, reject, progress, setWaiting, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } });
            signal?.addEventListener('abort', abort, { once: true });
            child.send({ id, method, args: args.map(encodeTelegramValue) }, (error: Error | null) => { if (error) this.failPending(error); });
        });
        // The private pipe parses the protocol and TL bytes; caller supplies the SDK return type.
        return await result as T;
    }
    override async invoke<R extends Api.AnyRequest>(request: R, dcId?: number): Promise<R['__response']> {
        await request.resolve(this, utils);
        const result = await this.call<R['__response']>('invoke', [request, dcId]);
        this.session.processEntities(result);
        this._entityCache.add(result);
        return result;
    }
    override async checkAuthorization() {
        try { await this.invoke(new Api.updates.GetState()); return true; }
        catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (/AUTH_KEY_(UNREGISTERED|INVALID|DUPLICATED)|SESSION_(REVOKED|EXPIRED)|USER_DEACTIVATED/.test(message)) return false;
            throw error;
        }
    }
    override iterDownload(params: IterDownloadFunction) { return new RemoteDownloadIterator(this, this, params); }
    override downloadMedia(message: Api.TypeMessage | Api.TypeMessageMedia, params: DownloadMediaInterface = {}) {
        const { progressCallback, ...options } = params;
        return this.call<Buffer | string | undefined>('downloadMedia', [message, options], progressCallback ? (downloaded, total) => progressCallback(bigInt(downloaded), bigInt(total)) : undefined, telegramOperationSignal(), 24 * 60 * 60_000);
    }
    override disconnect() { return this.destroy(); }
    override destroy(): Promise<void> {
        if (this.closeFlight) return this.closeFlight;
        this.closing = true;
        this.live = false;
        this.runtimeEventHandler = undefined;
        this.closeFlight = (async () => {
            const child = this.child;
            if (!child || !this.exitFlight) return;
            clearInterval(this.watchdog);
            const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
            timer.unref();
            child.kill('SIGTERM');
            await this.exitFlight;
            clearTimeout(timer);
            this.child = undefined;
        })();
        return this.closeFlight;
    }
}
