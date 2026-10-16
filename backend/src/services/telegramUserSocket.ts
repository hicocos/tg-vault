import { Socket } from 'node:net';
import { createRequire } from 'node:module';
import type { SocksClient as SocksClientClass } from 'socks';
import type { ProxyInterface, SocksProxyType } from 'telegram/network/connection/TCPMTProxy.js';

const require = createRequire(import.meta.url);
const { SocksClient } = require('telegram/extensions/socks.js') as { SocksClient: typeof SocksClientClass };

export interface UserSocketOwner {
    assertOpen(): void;
    beforeConnect?(): void;
    socketError(error: unknown): void;
}
const socketClosed = () => Object.assign(new Error('USER_SOCKET_CLOSED'), { code: 'USER_SOCKET_CLOSED' });

/** Net socket ownership starts before TCP/SOCKS opening, not after it succeeds. */
export class UserNetSocket {
    private client?: Socket;
    private generation = 0;
    private closed = true;
    private chunks: Buffer[] = [];
    private headOffset = 0;
    private available = 0;
    private readers = new Set<() => void>();
    private openingReject?: (error: unknown) => void;
    private closing: Promise<void> = Promise.resolve();
    private readonly proxy?: SocksProxyType;
    constructor(proxy?: ProxyInterface, private readonly owner?: UserSocketOwner) {
        if (proxy && !('MTProxy' in proxy)) {
            if (!proxy.ip || !proxy.port || ![4, 5].includes(proxy.socksType)) {
                throw new Error('USER_INVALID_SOCKS_PROXY');
            }
            this.proxy = proxy;
        }
    }

    private wake() {
        for (const wake of this.readers) wake();
        this.readers.clear();
    }

    private teardown(error: unknown): Promise<void> {
        this.closed = true;
        this.openingReject?.(error);
        this.openingReject = undefined;
        this.wake();
        this.chunks = [];
        this.headOffset = this.available = 0;
        const socket = this.client;
        this.client = undefined;
        if (!socket) return this.closing;
        const done = Promise.withResolvers<void>();
        if (socket.closed) done.resolve();
        else socket.once('close', () => done.resolve());
        socket.destroy();
        socket.unref();
        this.closing = Promise.all([this.closing, done.promise]).then(() => undefined);
        return this.closing;
    }

    async connect(port: number, ip: string): Promise<void> {
        const generation = ++this.generation;
        await this.teardown(socketClosed());
        if (generation !== this.generation) throw socketClosed();
        this.owner?.assertOpen();
        this.owner?.beforeConnect?.();
        const socket = new Socket();
        this.client = socket;
        this.closed = false;
        socket.setNoDelay(true);
        let receiving = false;
        const current = () => generation === this.generation && this.client === socket && !this.closed;
        const fail = (error: unknown) => {
            if (!current()) return;
            this.owner?.socketError(error);
            void this.teardown(error);
        };
        socket.on('error', fail);
        socket.on('end', () => fail(socketClosed()));
        socket.on('close', () => fail(socketClosed()));
        socket.on('data', (chunk: Buffer) => {
            if (!receiving || !current()) return;
            this.chunks.push(chunk);
            this.available += chunk.length;
            this.wake();
        });
        const timeout = setTimeout(() => fail(Object.assign(new Error('USER_SOCKET_CONNECT_TIMEOUT'),
            { code: 'USER_SOCKET_CONNECT_TIMEOUT' })), 8000);
        try {
            const opening = Promise.withResolvers<void>();
            this.openingReject = opening.reject;
            const ready = () => {
                if (!current()) { opening.reject(socketClosed()); return; }
                this.openingReject = undefined;
                receiving = true;
                opening.resolve();
            };
            socket.once('connect', () => {
                if (!current()) return;
                if (!this.proxy) { ready(); return; }
                // Existing socket avoids the SOCKS library's unowned opening socket.
                void SocksClient.createConnection({
                    existing_socket: socket,
                    command: 'connect',
                    timeout: Math.min((this.proxy.timeout || 5) * 1000, 8000),
                    proxy: { host: this.proxy.ip, port: this.proxy.port, type: this.proxy.socksType,
                        userId: this.proxy.username, password: this.proxy.password },
                    destination: { host: ip, port },
                }).then(ready, fail);
            });
            socket.connect(this.proxy ? this.proxy.port : port, this.proxy ? this.proxy.ip : ip);
            await opening.promise;
            this.owner?.assertOpen();
            if (!current()) throw socketClosed();
        } catch (error) {
            if (generation === this.generation) await this.teardown(error);
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async read(number: number): Promise<Buffer> {
        const generation = this.generation;
        while (!this.available) {
            if (this.closed || generation !== this.generation) throw socketClosed();
            const pending = Promise.withResolvers<void>();
            this.readers.add(pending.resolve);
            await pending.promise;
        }
        if (this.closed || generation !== this.generation) throw socketClosed();
        const count = Math.min(number, this.available);
        if (count <= 0) return Buffer.alloc(0);
        const first = this.chunks[0];
        let result: Buffer;
        if (first.length - this.headOffset >= count) {
            result = first.subarray(this.headOffset, this.headOffset + count);
            this.headOffset += count;
            if (this.headOffset === first.length) { this.chunks.shift(); this.headOffset = 0; }
        } else {
            result = Buffer.allocUnsafe(count);
            let offset = 0;
            while (offset < count) {
                const chunk = this.chunks[0];
                const n = Math.min(count - offset, chunk.length - this.headOffset);
                chunk.copy(result, offset, this.headOffset, this.headOffset + n);
                offset += n;
                this.headOffset += n;
                if (this.headOffset === chunk.length) { this.chunks.shift(); this.headOffset = 0; }
            }
        }
        this.available -= count;
        return result;
    }

    async readExactly(number: number): Promise<Buffer> {
        if (number <= 0) return Buffer.alloc(0);
        const first = await this.read(number);
        if (first.length === number) return first;
        const result = Buffer.allocUnsafe(number);
        first.copy(result);
        let offset = first.length;
        while (offset < number) {
            const chunk = await this.read(number - offset);
            chunk.copy(result, offset);
            offset += chunk.length;
        }
        return result;
    }

    readAll(): Promise<Buffer> { return this.read(this.available || Number.MAX_SAFE_INTEGER); }
    write(data: Buffer): void {
        this.owner?.assertOpen();
        if (this.closed || !this.client) throw socketClosed();
        this.client.write(data);
    }
    close(): Promise<void> { ++this.generation; return this.teardown(socketClosed()); }
    async receive(): Promise<void> { /* Data listeners are installed before opening. */ }
    toString(): string { return 'OwnedUserNetSocket'; }
}
