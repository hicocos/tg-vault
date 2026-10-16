import type {
    TelegramAccountRepository,
    TelegramAccountSourceAccessRecord,
    TelegramAccountSourceScope,
    TelegramUserAccountRecord,
} from './telegramAccountRepository.js';
import { telegramAccountRepository } from './telegramAccountRepository.js';
import { TelegramClient, utils } from 'telegram';
import type { Api } from 'telegram';
import { TelegramUserWorkerClient } from './telegramUserWorkerClient.js';
import { TELEGRAM_EXTREME_FLOOD_WAIT_SECONDS, type TelegramTransportRuntimeEvent } from './telegramWorkerProtocol.js';
import { withTelegramOperationSignal } from './telegramOperationContext.js';
import { decryptCredential } from '../utils/credentialCrypto.js';
import {
    selectWeightedLeastConnectedTelegramAccount,
    normalizeTelegramAccountSourceKey,
    type TelegramAccountSchedulingOptions,
    type TelegramAccountSchedulingCandidate,
    type TelegramSourceAccessState,
} from './telegramAccountScheduler.js';

export interface TelegramPoolCredentials {
    apiId: number;
    apiHash: string;
}

export interface TelegramPooledClient {
    connected?: boolean;
    runtimeProcessId?: number;
    setRuntimeEventHandler?(handler: ((event: TelegramTransportRuntimeEvent) => void) | undefined): void;
    connect(): Promise<unknown>;
    checkAuthorization(): Promise<boolean>;
    getMe(): Promise<unknown>;
    disconnect(): Promise<unknown>;
    destroy(): Promise<unknown>;
    invoke?<R extends Api.AnyRequest>(request: R, dcId?: number): Promise<R['__response']>;
}

interface PoolRepository extends Pick<TelegramAccountRepository,
    | 'migrateLegacySystemSettings'
    | 'listEnabledAccounts'
    | 'getAccount'
    | 'listSourceAccess'
    | 'updateSession'
    | 'recordHealthy'
    | 'recordFailure'
    | 'markSessionExpired'
    | 'markCooldown'
    | 'markSourceAccess'> {}

interface PoolEntry<C extends TelegramPooledClient> {
    account: TelegramUserAccountRecord;
    client: C;
    closing?: boolean;
    active: Record<TelegramAccountSourceScope, number>;
    lastSelected: Record<TelegramAccountSourceScope, number>;
    concurrencyLimit: number;
    scanIntervalMs: number;
    lastScanStartedAt?: number;
    scanSuccessSince?: number;
    scanSuccessfulRequests: number;
    lastScanSucceededAt?: number;
    floodEpisode?: number;
    reducedFloodEpisode?: number;
    fragmentLimit?: number;
    successfulReads: number;
    recoveryReads: number;
    successSince?: number;
    lastSucceededAt?: number;
}

export interface SelectedTelegramDownloadAccount<C extends TelegramPooledClient = TelegramPooledClient> {
    accountId: string;
    client: C;
    release(): void;
}

export interface TelegramAccountFloodWait {
    accountId: string;
    retryAt: number;
    seconds: number;
}

export interface TelegramScanRequestEvent {
    accountId: string;
    method: string;
    readableAccounts: number;
    pacingMs: number;
}

export interface TelegramAccountSelectionOptions extends TelegramAccountSchedulingOptions {
    scope?: TelegramAccountSourceScope;
    signal?: AbortSignal;
    preferredAccountId?: string;
    onFloodWait?: (event: TelegramAccountFloodWait) => Promise<void> | void;
    onScanRequest?: (event: TelegramScanRequestEvent) => void;
}

export type PublicTelegramUserAccount = Omit<TelegramUserAccountRecord, 'session'> & {
    connected: boolean;
    activeConnections: number;
};

export class NoEligibleTelegramAccountError extends Error {
    constructor(sourceKey: string, scope: TelegramAccountSourceScope) {
        super(`No eligible Telegram account for ${scope}: ${sourceKey}`);
        this.name = 'NoEligibleTelegramAccountError';
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}

const ACCOUNT_RECOVERY_INTERVAL_MS = 60_000;
const ACCOUNT_WAIT_RECHECK_MS = 1_000;
const SCAN_INTERVAL_MS = 1_000;
// Adaptive spacing is separate from Telegram's mandatory cooldown: add one
// second per flood, cap at eight, and recover one second after active success.
const SCAN_MAX_INTERVAL_MS = 8_000;
const SCAN_RECOVERY_INTERVAL_MS = 60_000;
const SCAN_RECOVERY_SUCCESSES = 8;

function errorName(error: unknown): string {
    const value = error as { errorMessage?: unknown; message?: unknown } | null;
    return String(value?.errorMessage || value?.message || error || 'Telegram account connection failed');
}

export function isTelegramSessionExpiredError(error: unknown): boolean {
    return /(AUTH_KEY_(UNREGISTERED|INVALID|DUPLICATED)|SESSION_(REVOKED|EXPIRED)|USER_DEACTIVATED)/i.test(errorName(error));
}

export function classifyTelegramDownloadAccountError(error: unknown): 'session_expired' | 'permission_denied' | 'flood_wait' | 'retryable' {
    const value = error as { errorMessage?: unknown; message?: unknown; name?: unknown } | null;
    const text = `${value?.errorMessage || ''} ${value?.message || ''} ${value?.name || ''}`;
    if (isTelegramSessionExpiredError(error)) return 'session_expired';
    if (/CHANNEL_PRIVATE|USER_NOT_PARTICIPANT|USER_BANNED_IN_CHANNEL|CHAT_FORBIDDEN|CHAT_ADMIN_REQUIRED|Could not find the input entity|Cannot find any entity/i.test(text)) return 'permission_denied';
    if (/FLOOD|Too many requests/i.test(text)) return 'flood_wait';
    return 'retryable';
}

export function telegramFloodWaitSeconds(error: unknown): number {
    const value = error as { errorMessage?: unknown; message?: unknown; seconds?: unknown; value?: unknown } | null;
    const text = `${value?.errorMessage || ''} ${value?.message || ''}`;
    const seconds = Number(value?.seconds || value?.value || text.match(/FLOOD(?:_PREMIUM)?_WAIT_?(\d+)/i)?.[1] || 60);
    return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60;
}

export type TelegramUserActivationReason = 'login_complete' | 'explicit_enable';

export class TelegramUserClientPool<C extends TelegramPooledClient = TelegramPooledClient> {
    private readonly entries = new Map<string, PoolEntry<C>>();
    private credentials: TelegramPoolCredentials | null = null;
    private initializationTail: Promise<void> = Promise.resolve();
    private selectionSequence = 0;
    private readonly waiters = new Set<() => void>();
    private readonly pendingAccessDenials = new Map<string, number>();
    private readonly quarantined = new Map<string, C>();
    private readonly reconnectAfter = new Map<string, number>();
    private readonly runtimeClients = new Map<string, C>();
    private readonly cooldownWrites = new Map<string, { until: Date; error: string | null; version: number; persistedVersion: number; flight?: Promise<void> }>();

    constructor(private readonly deps: {
        repository: PoolRepository;
        decryptSession(value: string): string;
        createClient(session: string, credentials: TelegramPoolCredentials, accountId: string): C;
        saveSession?(client: C): string;
        now?(): number;
    }) {}

    async initialize(credentials: TelegramPoolCredentials): Promise<void> {
        const run = this.initializationTail.then(async () => {
            // Startup reconciliation is additive: an account explicitly enabled
            // before delayed recovery must retain its exact live client/leases.
            this.credentials = credentials;
            await this.deps.repository.migrateLegacySystemSettings();
            const accounts = await this.deps.repository.listEnabledAccounts();
            const enabledIds = new Set(accounts.filter(account => account.healthState !== 'session_expired').map(account => account.id));
            await Promise.all([...this.entries.keys()].filter(id => !enabledIds.has(id) || this.entries.get(id)?.closing).map(id => this.expireEntry(id)));
            for (const account of accounts) {
                const entry = this.entries.get(account.id);
                if (entry?.client.connected === false && !entry.closing && Object.values(entry.active).every(count => count === 0)) {
                    await this.expireEntry(account.id);
                    continue;
                }
                if (!entry) continue;
                const cooldownUntil = Math.max(entry.account.cooldownUntil?.getTime() || 0, account.cooldownUntil?.getTime() || 0);
                entry.account = { ...account, cooldownUntil: cooldownUntil ? new Date(cooldownUntil) : null,
                    healthState: cooldownUntil > this.now() ? 'degraded' : account.healthState,
                    lastError: cooldownUntil > this.now() ? entry.account.lastError || account.lastError : account.lastError };
                entry.concurrencyLimit = Math.min(entry.concurrencyLimit, Math.max(1, account.maxConnections));
            }
            const results = await Promise.allSettled(accounts.map(account => this.connectAccount(account)));
            for (let index = 0; index < results.length; index++) {
                if (results[index].status === 'rejected') console.error(JSON.stringify({ event: 'telegram_account_cleanup_quarantined', accountId: accounts[index].id }));
            }
            this.wakeWaiters();
        });
        this.initializationTail = run.catch(() => undefined);
        await run;
    }

    async refresh(): Promise<void> {
        if (!this.credentials) return;
        await this.initialize(this.credentials);
    }

    async deactivateAccount(accountId: string): Promise<void> {
        await this.runLifecycleOperation(() => this.expireEntry(accountId));
    }

    async activateAccount(
        accountId: string,
        reason: TelegramUserActivationReason,
        credentials?: TelegramPoolCredentials,
    ): Promise<void> {
        if (reason !== 'login_complete' && reason !== 'explicit_enable') throw new Error('TELEGRAM_USER_ACTIVATION_NOT_ALLOWED');
        await this.runLifecycleOperation(async () => {
            // A newly persisted session must never coexist with an older runtime
            // for the same Telegram identity. Close the old client before trying
            // the replacement so a failed reconnect cannot leave it orphaned.
            await this.expireEntry(accountId);
            if (credentials) this.credentials = credentials;
            if (!this.credentials) return;
            const account = await this.deps.repository.getAccount(accountId);
            if (!account) return;
            if (reason === 'login_complete' && (account.cooldownUntil?.getTime() || 0) <= this.now()) this.reconnectAfter.delete(accountId);
            await this.connectAccount(account);
        });
    }

    private async connectAccount(account: TelegramUserAccountRecord): Promise<void> {
        if (this.entries.has(account.id) || this.quarantined.has(account.id) || this.now() < (this.reconnectAfter.get(account.id) || 0) || !this.credentials || !account.enabled || account.healthState === 'session_expired') return;
        let client: C | null = null;
        try {
            const session = this.deps.decryptSession(account.session);
            client = this.deps.createClient(session, this.credentials, account.id);
            const entry: PoolEntry<C> = {
                account: { ...account }, client,
                active: { download: 0, scan: 0, metadata: 0 },
                lastSelected: { download: 0, scan: 0, metadata: 0 },
                concurrencyLimit: Math.max(1, account.maxConnections),
                successfulReads: 0, recoveryReads: 0,
                scanSuccessfulRequests: 0,
                scanIntervalMs: account.cooldownUntil && account.cooldownUntil.getTime() > this.now() ? SCAN_INTERVAL_MS * 2 : SCAN_INTERVAL_MS,
            };
            this.runtimeClients.set(account.id, client);
            client.setRuntimeEventHandler?.(event => {
                if (this.runtimeClients.get(account.id) !== entry.client || entry.closing) return;
                this.handleRuntimeEvent(entry, event);
            });
            await client.connect();
            if (!(await client.checkAuthorization())) throw new Error('SESSION_EXPIRED');
            await client.getMe();
            const saved = this.deps.saveSession?.(client) || session;
            if (saved && saved !== session) await this.deps.repository.updateSession(account.id, saved);
            if ((entry.account.cooldownUntil?.getTime() || 0) > this.now()) {
                entry.account = { ...entry.account, healthState: 'degraded' };
                await this.persistCooldown(account.id, entry.account.cooldownUntil!, entry.account.lastError);
            } else {
                await this.deps.repository.recordHealthy(account.id);
                if ((entry.account.cooldownUntil?.getTime() || 0) > this.now()) {
                    await this.persistCooldown(account.id, entry.account.cooldownUntil!, entry.account.lastError);
                } else entry.account = { ...entry.account, healthState: 'healthy', lastError: null };
            }
            this.entries.set(account.id, entry);
            this.wakeWaiters();
        } catch (error) {
            const observedCooldown = this.cooldownWrites.get(account.id);
            this.reconnectAfter.set(account.id, classifyTelegramDownloadAccountError(error) === 'flood_wait'
                ? observedCooldown?.until.getTime() ?? this.now() + telegramFloodWaitSeconds(error) * 1000
                : this.now() + 60_000);
            if (client) {
                try { await this.closeClient(client); }
                catch (closeError) { this.quarantined.set(account.id, client); throw closeError; }
            }
            const message = errorName(error);
            if (isTelegramSessionExpiredError(error)) await this.deps.repository.markSessionExpired(account.id, message);
            else if (classifyTelegramDownloadAccountError(error) === 'flood_wait') {
                const seconds = telegramFloodWaitSeconds(error);
                await this.persistCooldown(account.id, observedCooldown?.until || new Date(this.now() + seconds * 1000), observedCooldown?.error || message);
            } else await this.deps.repository.recordFailure(account.id, message);
        }
    }

    private now(): number { return this.deps.now?.() ?? Date.now(); }

    private handleRuntimeEvent(entry: PoolEntry<C>, event: TelegramTransportRuntimeEvent): void {
        if (event.episode < (entry.floodEpisode || 0)) return;
        entry.fragmentLimit = event.fragmentLimit;
        if (event.type === 'cooldown') {
            const distinct = event.episode > (entry.floodEpisode || 0);
            entry.floodEpisode = event.episode;
            const reason = `${event.reason}_${event.seconds}`;
            const reduceDownloads = event.file && event.seconds >= TELEGRAM_EXTREME_FLOOD_WAIT_SECONDS
                && entry.reducedFloodEpisode !== event.episode;
            if (reduceDownloads) entry.reducedFloodEpisode = event.episode;
            this.applyCooldown(entry, new Date(event.until), reason, event.file ? 'download' : 'scan', distinct, reduceDownloads);
            void this.persistCooldown(entry.account.id, entry.account.cooldownUntil!, reason).catch((error: unknown) => {
                console.error(JSON.stringify({ event: 'telegram_account_cooldown_persist_failed', accountId: entry.account.id,
                    error: errorName(error) }));
            });
            return;
        }
        if (event.episode !== (entry.floodEpisode || 0) || event.successfulReads <= entry.successfulReads ||
            event.at < (entry.account.cooldownUntil?.getTime() || 0)) return;
        const reads = event.successfulReads - entry.successfulReads;
        entry.successfulReads = event.successfulReads;
        if (entry.lastSucceededAt === undefined || event.at - entry.lastSucceededAt > ACCOUNT_RECOVERY_INTERVAL_MS) {
            entry.successSince = event.at;
            entry.recoveryReads = 0;
        }
        entry.lastSucceededAt = event.at;
        entry.successSince ??= event.at;
        entry.recoveryReads += reads;
        if (event.at - entry.successSince >= ACCOUNT_RECOVERY_INTERVAL_MS && entry.recoveryReads >= 8) {
            entry.concurrencyLimit = Math.min(Math.max(1, entry.account.maxConnections), entry.concurrencyLimit + 1);
            entry.successSince = event.at;
            entry.recoveryReads = 0;
            this.wakeWaiters();
        }
    }

    private persistCooldown(accountId: string, until: Date, error: string | null): Promise<void> {
        let pending = this.cooldownWrites.get(accountId);
        if (!pending) {
            pending = { until, error, version: 1, persistedVersion: 0 };
            this.cooldownWrites.set(accountId, pending);
        } else if (until.getTime() > pending.until.getTime() || error !== pending.error) {
            pending.until = new Date(Math.max(until.getTime(), pending.until.getTime()));
            pending.error = error;
            pending.version++;
        }
        if (!pending.flight && pending.persistedVersion !== pending.version) {
            const write = pending;
            write.flight = Promise.resolve().then(async () => {
                while (write.persistedVersion !== write.version) {
                    const version = write.version;
                    await this.deps.repository.markCooldown(accountId, Math.max(0, (write.until.getTime() - this.now()) / 1000), write.error, write.until);
                    write.persistedVersion = version;
                }
            }).finally(() => {
                write.flight = undefined;
            });
        }
        return pending.flight || Promise.resolve();
    }

    private wakeWaiters(): void {
        for (const wake of this.waiters) wake();
    }

    private waitForAvailability(signal?: AbortSignal, milliseconds = ACCOUNT_WAIT_RECHECK_MS): Promise<void> {
        throwIfAborted(signal);
        return new Promise<void>(resolve => {
            const finish = () => {
                clearTimeout(timer);
                this.waiters.delete(finish);
                signal?.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, milliseconds);
            this.waiters.add(finish);
            signal?.addEventListener('abort', finish, { once: true });
            if (signal?.aborted) finish();
        });
    }

    private async beginScanRequest(entry: PoolEntry<C>, signal?: AbortSignal, minimumIntervalMs = SCAN_INTERVAL_MS): Promise<void> {
        while (true) {
            throwIfAborted(signal);
            if (this.entries.get(entry.account.id) !== entry || !entry.account.enabled || entry.client.connected === false) {
                throw new NoEligibleTelegramAccountError(entry.account.id, 'scan');
            }
            const now = this.now();
            const readyAt = Math.max(entry.account.cooldownUntil?.getTime() || 0,
                entry.lastScanStartedAt === undefined ? 0 : entry.lastScanStartedAt + Math.max(entry.scanIntervalMs, minimumIntervalMs));
            if (now >= readyAt) {
                entry.lastScanStartedAt = now;
                return;
            }
            await this.waitForAvailability(signal, readyAt - now);
        }
    }

    private recordSuccessfulScanRequest(entry: PoolEntry<C>): void {
        const now = this.now();
        if (this.entries.get(entry.account.id) !== entry || now < (entry.account.cooldownUntil?.getTime() || 0)) return;
        // Idle time is not evidence that the reduced rate is safe.
        if (entry.lastScanSucceededAt === undefined || now - entry.lastScanSucceededAt > SCAN_RECOVERY_INTERVAL_MS) {
            entry.scanSuccessSince = now;
            entry.scanSuccessfulRequests = 0;
        }
        entry.lastScanSucceededAt = now;
        entry.scanSuccessSince ??= now;
        entry.scanSuccessfulRequests++;
        if (now - entry.scanSuccessSince >= SCAN_RECOVERY_INTERVAL_MS && entry.scanSuccessfulRequests >= SCAN_RECOVERY_SUCCESSES) {
            entry.scanIntervalMs = Math.max(SCAN_INTERVAL_MS, entry.scanIntervalMs - SCAN_INTERVAL_MS);
            entry.scanSuccessSince = now;
            entry.scanSuccessfulRequests = 0;
            this.wakeWaiters();
        }
    }

    private scanClient(entry: PoolEntry<C>, signal: AbortSignal | undefined, readableAccounts: number, onScanRequest?: TelegramAccountSelectionOptions['onScanRequest']): C {
        let invoke: C['invoke'];
        // A per-operation view keeps downloads untouched and also catches RPCs
        // made inside getMessages (entity resolution and internal pagination).
        return new Proxy(entry.client, {
            get: (target, property, receiver) => {
                const value = Reflect.get(target, property, receiver);
                if (property !== 'invoke' || typeof value !== 'function') return value;
                invoke ??= async (...args: unknown[]) => {
                    try {
                        // Resolution may send a nested RPC; reserve the outer start
                        // only after that finishes, not before its network lookup.
                        if (target instanceof TelegramClient) {
                            await (args[0] as Api.AnyRequest).resolve(receiver, utils);
                        }
                        const request = args[0];
                        const method = request && typeof request === 'object' && 'className' in request ? String(request.className) : 'unknown';
                        // Pace single-account history/search/album reads, not unrelated metadata.
                        const sourceRead = /^(?:channels\.GetMessages|messages\.(?:GetMessages|GetHistory|Search|GetReplies))$/.test(method);
                        const pacingMs = Math.max(entry.scanIntervalMs, readableAccounts <= 1 && sourceRead ? 2000 : SCAN_INTERVAL_MS);
                        await this.beginScanRequest(entry, signal, pacingMs);
                        onScanRequest?.({ accountId: entry.account.id, method, readableAccounts, pacingMs });
                        const result = await Reflect.apply(value, receiver, args);
                        this.recordSuccessfulScanRequest(entry);
                        return result;
                    } catch (error) {
                        entry.scanSuccessSince = undefined;
                        entry.lastScanSucceededAt = undefined;
                        entry.scanSuccessfulRequests = 0;
                        throw error;
                    }
                };
                return invoke;
            },
        });
    }

    async select(sourceKey: string, options: TelegramAccountSelectionOptions = {}): Promise<SelectedTelegramDownloadAccount<C> | null> {
        return (await this.selectAvailable(sourceKey, options)).lease;
    }

    private async selectAvailable(sourceKey: string, options: TelegramAccountSelectionOptions): Promise<{
        lease: SelectedTelegramDownloadAccount<C> | null; viable: boolean;
    }> {
        throwIfAborted(options.signal);
        const scope = options.scope || 'download';
        const access = await this.deps.repository.listSourceAccess(normalizeTelegramAccountSourceKey(sourceKey), scope);
        throwIfAborted(options.signal);
        const accessByAccount = new Map<string, TelegramAccountSourceAccessRecord>(access.map(row => [row.accountId, row]));
        const key = normalizeTelegramAccountSourceKey(sourceKey);
        const excluded = new Set(options.excludeAccountIds || []);
        for (const access of accessByAccount.values()) {
            if (access.lastError?.startsWith('TELEGRAM_HISTORY_UNVERIFIED') && access.checkedAt
                && this.now() - new Date(access.checkedAt).getTime() < 15 * 60_000) excluded.add(access.accountId);
        }
        const candidates = [...this.entries.values()].map<TelegramAccountSchedulingCandidate>(entry => ({
            accountId: entry.account.id,
            enabled: !entry.closing && entry.account.enabled && entry.client.connected !== false,
            healthState: entry.account.healthState,
            cooldownUntil: entry.account.cooldownUntil,
            weight: entry.account.weight,
            priority: entry.account.priority,
            activeConnections: entry.active[scope],
            maxConnections: scope === 'scan' ? 1 : entry.concurrencyLimit,
            lastSelected: entry.lastSelected[scope],
            sourceAccessState: this.pendingAccessDenials.has(JSON.stringify([entry.account.id, key, scope]))
                ? 'denied' : accessByAccount.get(entry.account.id)?.accessState || 'unknown',
        }));
        const selectionOptions = { ...options, now: options.now || new Date(this.now()), excludeAccountIds: excluded };
        const preferred = options.preferredAccountId
            ? selectWeightedLeastConnectedTelegramAccount(candidates.filter(candidate => candidate.accountId === options.preferredAccountId), selectionOptions)
            : null;
        const selected = preferred || selectWeightedLeastConnectedTelegramAccount(candidates, selectionOptions);
        const viable = candidates.some(candidate => candidate.enabled && candidate.healthState !== 'session_expired'
            && candidate.sourceAccessState !== 'denied' && !excluded.has(candidate.accountId));
        const entry = selected && this.entries.get(selected.accountId);
        if (!entry) return { lease: null, viable };
        entry.active[scope] += 1;
        entry.lastSelected[scope] = ++this.selectionSequence;
        const readableAccounts = scope === 'scan' ? Math.max(1, candidates.filter(candidate => candidate.enabled
            && candidate.healthState !== 'session_expired' && !excluded.has(candidate.accountId)
            && candidate.sourceAccessState === 'allowed'
            && (!candidate.cooldownUntil || new Date(candidate.cooldownUntil).getTime() <= this.now())).length) : 0;
        let released = false;
        return { viable, lease: {
            accountId: entry.account.id,
            client: scope === 'scan' ? this.scanClient(entry, options.signal, readableAccounts, options.onScanRequest) : entry.client,
            release: () => {
                if (released) return;
                released = true;
                entry.active[scope] = Math.max(0, entry.active[scope] - 1);
                this.wakeWaiters();
            },
        } };
    }

    async acquire(sourceKey: string, options: TelegramAccountSelectionOptions = {}): Promise<SelectedTelegramDownloadAccount<C>> {
        while (true) {
            const { lease, viable } = await this.selectAvailable(sourceKey, options);
            if (lease) return lease;
            if (!viable) throw new NoEligibleTelegramAccountError(sourceKey, options.scope || 'download');
            await this.waitForAvailability(options.signal);
            throwIfAborted(options.signal);
        }
    }

    async withAccount<T>(
        sourceKey: string,
        scope: TelegramAccountSourceScope,
        operation: (client: C, accountId: string) => Promise<T>,
        options: Pick<TelegramAccountSelectionOptions, 'signal' | 'preferredAccountId' | 'excludeAccountIds' | 'onFloodWait' | 'onScanRequest'> = {},
    ): Promise<T> {
        const key = normalizeTelegramAccountSourceKey(sourceKey);
        const excluded = new Set(options.excludeAccountIds || []);
        while (true) {
            const lease = await this.acquire(key, { ...options, scope, excludeAccountIds: excluded });
            try {
                throwIfAborted(options.signal);
                const result = await withTelegramOperationSignal(options.signal, () => operation(lease.client, lease.accountId));
                throwIfAborted(options.signal);
                return result;
            } catch (error) {
                throwIfAborted(options.signal);
                const classification = classifyTelegramDownloadAccountError(error);
                const message = errorName(error);
                if (/^TELEGRAM_HISTORY_UNVERIFIED/.test(message)) {
                    excluded.add(lease.accountId);
                    lease.release();
                    await this.deps.repository.markSourceAccess(lease.accountId, key, scope, 'unknown', message);
                    console.warn(JSON.stringify({ event: 'telegram_source_unverified', accountId: lease.accountId, source: key, scope, reason: message }));
                    continue;
                } else if (classification === 'retryable') {
                    if (/EADDRNOTAVAIL|EMFILE|ENFILE|ENOBUFS|TELEGRAM_WORKER_(EXITED|UNAVAILABLE|REQUEST_TIMEOUT|CANCEL_TIMEOUT)|USER_RESOURCE_CIRCUIT/i.test(message)) {
                        this.updateCooldown(lease.accountId, new Date(this.now() + 60_000), message, scope);
                        await this.persistCooldown(lease.accountId, this.entries.get(lease.accountId)?.account.cooldownUntil || new Date(this.now() + 60_000), message);
                    }
                    throw error;
                }
                if (classification === 'flood_wait') {
                    const seconds = telegramFloodWaitSeconds(error);
                    const entry = this.entries.get(lease.accountId);
                    const observedRuntimeFlood = entry?.floodEpisode !== undefined && (entry.account.cooldownUntil?.getTime() || 0) >= this.now();
                    if (!observedRuntimeFlood) this.updateCooldown(lease.accountId, new Date(this.now() + seconds * 1000), message, scope);
                    lease.release();
                    await this.persistCooldown(lease.accountId, entry?.account.cooldownUntil || new Date(this.now() + seconds * 1000), observedRuntimeFlood ? entry!.account.lastError : message);
                    if (options.onFloodWait) {
                        const retryAt = Math.max(entry?.account.cooldownUntil?.getTime() || 0,
                            this.cooldownWrites.get(lease.accountId)?.until.getTime() || 0);
                        try {
                            await options.onFloodWait({ accountId: lease.accountId, retryAt,
                                seconds: Math.max(0, Math.ceil((retryAt - this.now()) / 1000)) });
                        } catch (notificationError) {
                            // An observer failure must not undo cooldown persistence or account failover.
                            console.error(JSON.stringify({ event: 'telegram_account_flood_wait_notify_failed',
                                accountId: lease.accountId, error: errorName(notificationError) }));
                        }
                    }
                } else if (classification === 'permission_denied') {
                    const denialKey = JSON.stringify([lease.accountId, key, scope]);
                    this.pendingAccessDenials.set(denialKey, (this.pendingAccessDenials.get(denialKey) || 0) + 1);
                    lease.release();
                    try {
                        await this.deps.repository.markSourceAccess(lease.accountId, key, scope, 'denied', message);
                    } finally {
                        const remaining = (this.pendingAccessDenials.get(denialKey) || 1) - 1;
                        if (remaining) this.pendingAccessDenials.set(denialKey, remaining);
                        else this.pendingAccessDenials.delete(denialKey);
                    }
                } else {
                    const entry = this.entries.get(lease.accountId);
                    if (entry) entry.account = { ...entry.account, healthState: 'session_expired' };
                    lease.release();
                    await this.deps.repository.markSessionExpired(lease.accountId, message);
                    await this.expireAccount(lease.accountId);
                }
            } finally {
                lease.release();
            }
        }
    }


    getDefaultClient(): C | null {
        return [...this.entries.values()]
            .filter(entry => !entry.closing && entry.client.connected !== false)
            .sort((left, right) => right.account.priority - left.account.priority || left.account.id.localeCompare(right.account.id))[0]?.client || null;
    }

    getAccountClient(accountId: string): C | null {
        const entry = this.entries.get(accountId);
        return entry && !entry.closing && entry.client.connected !== false ? entry.client : null;
    }

    getActiveConnections(accountId: string): number {
        return this.entries.get(accountId)?.active.download || 0;
    }

    getReadyAccountIds(): string[] {
        return [...this.entries.values()].filter(entry => !entry.closing && entry.client.connected !== false).map(entry => entry.account.id);
    }

    getRuntimeState(): Array<{ accountId: string; connected: boolean; processId?: number; closing: boolean; activeConnections: number; activeScanConnections: number; activeMetadataConnections: number; concurrencyLimit: number; fragmentLimit?: number; cooldownUntil: Date | null }> {
        return [...this.entries.values()].map(entry => ({
            accountId: entry.account.id,
            connected: Boolean(entry.client.connected),
            processId: entry.client.runtimeProcessId,
            closing: Boolean(entry.closing),
            activeConnections: entry.active.download,
            activeScanConnections: entry.active.scan,
            activeMetadataConnections: entry.active.metadata,
            concurrencyLimit: entry.concurrencyLimit,
            fragmentLimit: entry.fragmentLimit,
            cooldownUntil: entry.account.cooldownUntil,
        }));
    }

    updateCooldown(accountId: string, cooldownUntil: Date, error: string | null, scope: TelegramAccountSourceScope = 'download'): void {
        const entry = this.entries.get(accountId);
        if (entry) {
            const now = this.now();
            const distinct = now >= (entry.account.cooldownUntil?.getTime() || 0);
            const seconds = error && classifyTelegramDownloadAccountError(error) === 'flood_wait'
                ? telegramFloodWaitSeconds(error) : (cooldownUntil.getTime() - now) / 1000;
            this.applyCooldown(entry, cooldownUntil, error, scope, distinct, distinct && seconds >= TELEGRAM_EXTREME_FLOOD_WAIT_SECONDS);
        }
        this.wakeWaiters();
    }

    private applyCooldown(entry: PoolEntry<C>, cooldownUntil: Date, error: string | null, scope: TelegramAccountSourceScope, distinct: boolean, reduceDownloads: boolean): void {
        const until = new Date(Math.max(entry.account.cooldownUntil?.getTime() || 0, cooldownUntil.getTime()));
        entry.account = { ...entry.account, cooldownUntil: until, healthState: 'degraded', lastError: error };
        if (scope === 'scan' && distinct) entry.scanIntervalMs = Math.min(SCAN_MAX_INTERVAL_MS, entry.scanIntervalMs + SCAN_INTERVAL_MS);
        else if (scope !== 'scan' && reduceDownloads) entry.concurrencyLimit = Math.max(1, Math.floor(entry.concurrencyLimit / 2));
        if (distinct) entry.successfulReads = 0;
        entry.scanSuccessSince = undefined;
        entry.lastScanSucceededAt = undefined;
        entry.scanSuccessfulRequests = 0;
        entry.successSince = undefined;
        entry.lastSucceededAt = undefined;
        entry.recoveryReads = 0;
        this.wakeWaiters();
    }

    updateSourceAccess(_accountId: string, _sourceKey: string, _scope: TelegramAccountSourceScope, _state: TelegramSourceAccessState): void {
        // Source access is read through the repository for each selection, so no stale in-memory cache needs invalidation.
        this.wakeWaiters();
    }

    async expireAccount(accountId: string): Promise<void> {
        await this.runLifecycleOperation(() => this.expireEntry(accountId));
    }

    private async expireEntry(accountId: string): Promise<void> {
        const entry = this.entries.get(accountId);
        const quarantined = this.quarantined.get(accountId);
        if (entry) entry.closing = true;
        this.wakeWaiters();
        if (entry) await this.closeClient(entry.client);
        if (quarantined) await this.closeClient(quarantined);
        this.entries.delete(accountId);
        this.quarantined.delete(accountId);
        this.wakeWaiters();
        const pending = this.cooldownWrites.get(accountId);
        if (pending?.flight) await pending.flight.catch(() => undefined);
        this.cooldownWrites.delete(accountId);
    }

    async shutdown(): Promise<void> {
        await this.runLifecycleOperation(() => this.shutdownEntries());
    }

    private async shutdownEntries(): Promise<void> {
        await Promise.all([...new Set([...this.entries.keys(), ...this.quarantined.keys()])].map(id => this.expireEntry(id)));
    }

    private async runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.initializationTail.then(operation);
        this.initializationTail = run.then(() => undefined, () => undefined);
        return await run;
    }

    private async closeClient(client: C): Promise<void> {
        // destroy is the terminal ownership boundary; errors retain the entry in quarantine.
        client.setRuntimeEventHandler?.(undefined);
        for (const [accountId, owner] of this.runtimeClients) if (owner === client) this.runtimeClients.delete(accountId);
        await client.destroy();
    }
}

export const telegramUserClientPool = new TelegramUserClientPool<TelegramClient>({
    repository: telegramAccountRepository,
    decryptSession: decryptCredential,
    createClient: (session, credentials, accountId) => new TelegramUserWorkerClient(session, credentials, accountId),
    saveSession: client => client.session.save() as unknown as string,
});

let currentCredentials: TelegramPoolCredentials | null = null;
let recoveryTimer: NodeJS.Timeout | undefined;
let recoveryPending = false;

export async function initializeTelegramUserClientPool(credentials: TelegramPoolCredentials): Promise<void> {
    currentCredentials = credentials;
    await telegramUserClientPool.initialize(credentials);
    recoveryTimer ??= setInterval(() => {
        if (recoveryPending) return;
        recoveryPending = true;
        void telegramUserClientPool.refresh().catch((error: unknown) => console.error('Telegram account recovery failed:', error))
            .finally(() => { recoveryPending = false; });
    }, 60_000);
    recoveryTimer.unref();
}

export async function shutdownTelegramUserClientPool(): Promise<void> {
    clearInterval(recoveryTimer);
    recoveryTimer = undefined;
    await telegramUserClientPool.shutdown();
}
export function getTelegramUserClientPoolState() { return telegramUserClientPool.getRuntimeState(); }
export async function reloadTelegramUserClientPool(): Promise<void> {
    if (currentCredentials) await telegramUserClientPool.initialize(currentCredentials);
}

export async function listTelegramUserAccounts(): Promise<PublicTelegramUserAccount[]> {
    const accounts = await telegramAccountRepository.listAccounts();
    const ready = new Set(telegramUserClientPool.getReadyAccountIds());
    return accounts.map(({ session: _session, ...account }) => ({
        ...account, connected: ready.has(account.id), activeConnections: telegramUserClientPool.getActiveConnections(account.id),
    }));
}

export async function selectTelegramDownloadAccount(sourceKey: string, options: TelegramAccountSelectionOptions = {}) {
    return telegramUserClientPool.select(sourceKey, options);
}

export async function markTelegramAccountCooldown(accountId: string, seconds: number, error: string | null = null): Promise<boolean> {
    const safeSeconds = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60;
    telegramUserClientPool.updateCooldown(accountId, new Date(Date.now() + safeSeconds * 1000), error);
    const changed = await telegramAccountRepository.markCooldown(accountId, safeSeconds, error);
    return changed;
}

export async function markTelegramAccountSourceAccess(
    accountId: string, sourceKey: string, scope: TelegramAccountSourceScope,
    state: TelegramSourceAccessState, error: string | null = null,
): Promise<TelegramAccountSourceAccessRecord> {
    return telegramAccountRepository.markSourceAccess(accountId, sourceKey, scope, state, error);
}

export async function markTelegramAccountSessionExpired(accountId: string, error: string | null = null): Promise<boolean> {
    const changed = await telegramAccountRepository.markSessionExpired(accountId, error);
    if (changed) await telegramUserClientPool.expireAccount(accountId);
    return changed;
}

export async function upsertTelegramUserAccount(input: Parameters<TelegramAccountRepository['upsertAccount']>[0]): Promise<PublicTelegramUserAccount> {
    const account = await telegramAccountRepository.upsertAccount(input);
    await reloadTelegramUserClientPool();
    const { session: _session, ...publicAccount } = account;
    return { ...publicAccount, connected: telegramUserClientPool.getReadyAccountIds().includes(account.id), activeConnections: 0 };
}

export async function upsertTelegramUserAccountWithoutRuntimeRefresh(
    input: Parameters<TelegramAccountRepository['upsertAccount']>[0],
): Promise<PublicTelegramUserAccount> {
    const account = await telegramAccountRepository.upsertAccount(input);
    const { session: _session, ...publicAccount } = account;
    return {
        ...publicAccount,
        connected: telegramUserClientPool.getReadyAccountIds().includes(account.id),
        activeConnections: telegramUserClientPool.getActiveConnections(account.id),
    };
}

export async function setTelegramUserAccountEnabled(accountId: string, enabled: boolean): Promise<boolean> {
    const changed = await telegramAccountRepository.setEnabled(accountId, enabled);
    if (changed) await reloadTelegramUserClientPool();
    return changed;
}

export async function deleteTelegramUserAccount(accountId: string): Promise<boolean> {
    await telegramUserClientPool.expireAccount(accountId);
    return telegramAccountRepository.deleteAccount(accountId);
}

export const getTelegramAccountSourceAccess = telegramAccountRepository.getSourceAccess.bind(telegramAccountRepository);
export const listTelegramAccountSourceAccess = telegramAccountRepository.listSourceAccess.bind(telegramAccountRepository);
export const probeTelegramAccountSourceAccess = telegramAccountRepository.probeSourceAccess.bind(telegramAccountRepository);
export const startTelegramDownloadAttempt = telegramAccountRepository.startDownloadAttempt.bind(telegramAccountRepository);
export const finishTelegramDownloadAttempt = telegramAccountRepository.finishDownloadAttempt.bind(telegramAccountRepository);
