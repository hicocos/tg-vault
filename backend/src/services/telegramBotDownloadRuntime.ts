import type { TelegramClient } from 'telegram';

interface DownloadClient { readonly connected: boolean | undefined }

/** A transfer may follow reconnects of its Bot identity, never a credential cutover. */
export class BotDownloadRuntime<T extends DownloadClient> {
    private readonly identities = new WeakMap<T, string>();
    private current?: T;
    private identity?: string;
    private failure: Error = new Error('BOT_NOT_READY');
    private recovering = false;
    private readonly waiters = new Set<() => void>();

    register(client: T, identity: string): void {
        this.identities.set(client, identity);
        if (this.identity !== identity) {
            this.current = undefined;
            this.identity = identity;
            for (const wake of this.waiters) wake();
        }
    }

    ready(client: T): void {
        const identity = this.identities.get(client);
        if (!identity || identity !== this.identity) throw new Error('BOT_IDENTITY_CHANGED');
        this.current = client;
        this.recovering = false;
        for (const wake of this.waiters) wake();
    }

    unavailable(recovering: boolean, error = new Error('BOT_CANCELLED')): void {
        this.current = undefined;
        this.failure = error;
        this.recovering = recovering;
        for (const wake of this.waiters) wake();
    }

    isManaged(client: T): boolean { return this.identities.has(client); }

    active(client: T): T {
        return this.identities.get(client) === this.identity && this.current?.connected ? this.current : client;
    }

    async acquire(previous: T, signal?: AbortSignal): Promise<T> {
        const identity = this.identities.get(previous);
        if (!identity) return previous;
        signal?.throwIfAborted();
        if (identity !== this.identity) throw new Error('BOT_IDENTITY_CHANGED');
        if (this.current?.connected) return this.current;
        if (!this.recovering) throw this.failure;
        const deadline = AbortSignal.timeout(180_000);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        while (true) {
            combined.throwIfAborted();
            if (identity !== this.identity) throw new Error('BOT_IDENTITY_CHANGED');
            if (this.current?.connected) return this.current;
            if (!this.recovering) throw this.failure;
            await new Promise<void>((resolve, reject) => {
                const wake = () => { cleanup(); resolve(); };
                const abort = () => { cleanup(); reject(combined.reason); };
                const cleanup = () => { this.waiters.delete(wake); combined.removeEventListener('abort', abort); };
                this.waiters.add(wake);
                combined.addEventListener('abort', abort, { once: true });
                if (combined.aborted) abort();
            });
        }
    }
}

export const botDownloadRuntime = new BotDownloadRuntime<TelegramClient>();
