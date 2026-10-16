export type TelegramAccessScope = 'channel' | 'comments';
export type TelegramAccessState = 'allowed' | 'denied' | 'error';
export type TelegramAccessSweepReason = 'automatic' | 'manual' | 'account_created' | 'subscription_created' | string;

export interface TelegramAccessClient {
    getEntity(source: any): Promise<any>;
    getMessages(peer: any, options: Record<string, unknown>): Promise<Array<{ id?: number } | undefined>>;
}

export interface TelegramAccessSweepAccount {
    accountId: string;
    enabled: boolean;
}

export interface TelegramAccessSweepSource {
    sourceId: string;
    source: string;
    enabled: boolean;
    scopes?: readonly TelegramAccessScope[];
}

export interface TelegramAccountRuntime {
    client: TelegramAccessClient;
}

export interface TelegramAccountSourceAccessResult {
    accountId: string;
    sourceId: string;
    source: string;
    scope: TelegramAccessScope;
    state: TelegramAccessState;
    checkedAt: string;
    latestMessageId: number | null;
    errorCode?: string;
    errorMessage?: string;
}

export interface TelegramAccountAccessSweepDependencies {
    listTelegramAccounts(): Promise<readonly TelegramAccessSweepAccount[]>;
    listTelegramChannelSubscriptions(): Promise<readonly TelegramAccessSweepSource[]>;
    getTelegramAccountRuntime(accountId: string): Promise<TelegramAccountRuntime | null>;
    markTelegramAccountSourceAccess(result: TelegramAccountSourceAccessResult): Promise<void>;
    now?: () => Date;
}

export interface TelegramAccountAccessProbeInput {
    accountId: string;
    sourceId: string;
    source: string;
    scope: TelegramAccessScope;
    client: TelegramAccessClient;
    now?: () => Date;
}

export interface TelegramAccountAccessSweepCounts {
    accounts: number;
    sources: number;
    probes: number;
    allowed: number;
    denied: number;
    error: number;
}

export interface TelegramAccountAccessSweepSummary {
    runId: string | null;
    status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
    reason: TelegramAccessSweepReason | null;
    startedAt: string | null;
    completedAt: string | null;
    counts: TelegramAccountAccessSweepCounts;
    lastError: string | null;
}

export interface TelegramAccountAccessSweepOptions {
    concurrency?: number;
    reason?: TelegramAccessSweepReason;
    accountIds?: Iterable<string>;
    sourceIds?: Iterable<string>;
}

const DENIED_ERROR_CODES = new Set([
    'CHANNEL_INVALID',
    'CHANNEL_PRIVATE',
    'CHAT_ADMIN_REQUIRED',
    'CHAT_FORBIDDEN',
    'CHAT_RESTRICTED',
    'GROUP_PRIVATE',
    'INVITE_HASH_EXPIRED',
    'INVITE_HASH_INVALID',
    'MESSAGE_ID_INVALID',
    'PEER_ID_INVALID',
    'USER_BANNED_IN_CHANNEL',
    'USER_NOT_PARTICIPANT',
]);

const EMPTY_COUNTS = (): TelegramAccountAccessSweepCounts => ({
    accounts: 0,
    sources: 0,
    probes: 0,
    allowed: 0,
    denied: 0,
    error: 0,
});

let configuredDependencies: TelegramAccountAccessSweepDependencies | null = null;
let currentSummary: TelegramAccountAccessSweepSummary = {
    runId: null,
    status: 'idle',
    reason: null,
    startedAt: null,
    completedAt: null,
    counts: EMPTY_COUNTS(),
    lastError: null,
};
let triggerTail: Promise<void> = Promise.resolve();
let nextRunSequence = 0;

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try { return JSON.stringify(error); } catch { return String(error); }
}

export function getTelegramAccessErrorCode(error: unknown): string {
    const candidate = error as { errorMessage?: unknown; code?: unknown; message?: unknown } | null;
    const raw = [candidate?.errorMessage, candidate?.code, candidate?.message, error]
        .find(value => typeof value === 'string' && value.trim()) as string | undefined;
    if (!raw) return 'UNKNOWN_ERROR';
    const normalized = raw.toUpperCase().trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(normalized)) return normalized;
    const tokens = normalized.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g);
    return tokens?.at(-1) || 'UNKNOWN_ERROR';
}

export function classifyTelegramAccessError(error: unknown): 'denied' | 'error' {
    const code = getTelegramAccessErrorCode(error);
    return DENIED_ERROR_CODES.has(code) || /(?:PRIVATE|FORBIDDEN|NOT_PARTICIPANT|BANNED)/.test(code)
        ? 'denied'
        : 'error';
}

function failureResult(
    input: Pick<TelegramAccountAccessProbeInput, 'accountId' | 'sourceId' | 'source' | 'scope'>,
    error: unknown,
    now: () => Date,
): TelegramAccountSourceAccessResult {
    return {
        accountId: input.accountId,
        sourceId: input.sourceId,
        source: input.source,
        scope: input.scope,
        state: classifyTelegramAccessError(error),
        checkedAt: now().toISOString(),
        latestMessageId: null,
        errorCode: getTelegramAccessErrorCode(error),
        errorMessage: errorText(error),
    };
}

/**
 * Read-only permission probe. It deliberately uses only entity resolution and
 * message reads; it never invokes ImportChatInvite/JoinChannel or similar RPCs.
 */
export async function probeTelegramAccountSource(
    input: TelegramAccountAccessProbeInput,
): Promise<TelegramAccountSourceAccessResult> {
    const now = input.now || (() => new Date());
    try {
        const entity = await input.client.getEntity(input.source);
        const [latest] = await input.client.getMessages(entity, { limit: 1 });
        const latestMessageId = typeof latest?.id === 'number' ? latest.id : null;
        if (latestMessageId === null) {
            return failureResult(input, new Error('TELEGRAM_HISTORY_UNVERIFIED'), now);
        }
        if (input.scope === 'comments') {
            // GramJS's replyTo history lookup accepts the original source;
            // this mirrors telegramChannelJobs and resolves linked discussions.
            await input.client.getMessages(input.source, { limit: 1, replyTo: latestMessageId });
        }
        return {
            accountId: input.accountId,
            sourceId: input.sourceId,
            source: input.source,
            scope: input.scope,
            state: 'allowed',
            checkedAt: now().toISOString(),
            latestMessageId,
        };
    } catch (error) {
        return failureResult(input, error, now);
    }
}

async function mapWithConcurrency<T>(
    values: readonly T[],
    concurrency: number,
    worker: (value: T) => Promise<void>,
): Promise<void> {
    let cursor = 0;
    const workerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency)));
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (cursor < values.length) {
            const index = cursor;
            cursor += 1;
            await worker(values[index]);
        }
    }));
}

function normalizeScopes(source: TelegramAccessSweepSource): TelegramAccessScope[] {
    const requested = source.scopes?.length ? source.scopes : ['channel'];
    return Array.from(new Set(requested.filter(scope => scope === 'channel' || scope === 'comments')));
}

function selected<T extends { accountId?: string; sourceId?: string }>(
    values: readonly T[],
    key: 'accountId' | 'sourceId',
    identifiers: Iterable<string> | undefined,
): T[] {
    if (!identifiers) return [...values];
    const wanted = new Set(identifiers);
    return values.filter(value => wanted.has(String(value[key])));
}

function runId(now: Date): string {
    nextRunSequence += 1;
    return `${now.getTime()}-${nextRunSequence}`;
}

/**
 * Probe enabled account x enabled subscription scopes at bounded concurrency.
 * Runtime lookup is once per account; persistence is once per structured probe
 * result, including denied/error outcomes.
 */
export async function runTelegramAccountAccessSweep(
    dependencies: TelegramAccountAccessSweepDependencies,
    options: TelegramAccountAccessSweepOptions = {},
): Promise<TelegramAccountAccessSweepSummary> {
    const now = dependencies.now || (() => new Date());
    const startedAt = now();
    const reason = options.reason || 'automatic';
    const summary: TelegramAccountAccessSweepSummary = {
        runId: runId(startedAt),
        status: 'running',
        reason,
        startedAt: startedAt.toISOString(),
        completedAt: null,
        counts: EMPTY_COUNTS(),
        lastError: null,
    };
    currentSummary = summary;

    try {
        const [accountRows, sourceRows] = await Promise.all([
            dependencies.listTelegramAccounts(),
            dependencies.listTelegramChannelSubscriptions(),
        ]);
        const accounts = selected(accountRows.filter(account => account.enabled), 'accountId', options.accountIds);
        const sources = selected(sourceRows.filter(source => source.enabled), 'sourceId', options.sourceIds);
        summary.counts.accounts = accounts.length;
        summary.counts.sources = sources.length;

        const work: Array<{
            account: TelegramAccessSweepAccount;
            source: TelegramAccessSweepSource;
            scope: TelegramAccessScope;
        }> = [];
        for (const account of accounts) {
            for (const source of sources) {
                for (const scope of normalizeScopes(source)) work.push({ account, source, scope });
            }
        }
        summary.counts.probes = work.length;

        const runtimePromises = new Map<string, Promise<TelegramAccountRuntime | null>>();
        const getRuntime = (accountId: string): Promise<TelegramAccountRuntime | null> => {
            let runtime = runtimePromises.get(accountId);
            if (!runtime) {
                runtime = dependencies.getTelegramAccountRuntime(accountId);
                runtimePromises.set(accountId, runtime);
            }
            return runtime;
        };

        await mapWithConcurrency(work, options.concurrency ?? 2, async item => {
            let result: TelegramAccountSourceAccessResult;
            try {
                const runtime = await getRuntime(item.account.accountId);
                if (!runtime?.client) throw new Error('TELEGRAM_ACCOUNT_RUNTIME_UNAVAILABLE');
                result = await probeTelegramAccountSource({
                    accountId: item.account.accountId,
                    sourceId: item.source.sourceId,
                    source: item.source.source,
                    scope: item.scope,
                    client: runtime.client,
                    now,
                });
            } catch (error) {
                result = failureResult({
                    accountId: item.account.accountId,
                    sourceId: item.source.sourceId,
                    source: item.source.source,
                    scope: item.scope,
                }, error, now);
            }
            summary.counts[result.state] += 1;
            await dependencies.markTelegramAccountSourceAccess(result);
        });

        summary.status = 'completed';
        summary.completedAt = now().toISOString();
        currentSummary = summary;
        return summary;
    } catch (error) {
        summary.status = 'failed';
        summary.completedAt = now().toISOString();
        summary.lastError = errorText(error);
        currentSummary = summary;
        throw error;
    }
}

export function configureTelegramAccountAccessSweep(dependencies: TelegramAccountAccessSweepDependencies): void {
    configuredDependencies = dependencies;
}

/** Queue a manual/new-account/new-subscription trigger to avoid overlapping sweeps. */
export function triggerTelegramAccountAccessSweep(
    options: TelegramAccountAccessSweepOptions = {},
): Promise<TelegramAccountAccessSweepSummary> {
    if (!configuredDependencies) {
        return Promise.reject(new Error('TELEGRAM_ACCOUNT_ACCESS_SWEEP_NOT_CONFIGURED'));
    }
    const dependencies = configuredDependencies;
    currentSummary = {
        ...currentSummary,
        status: 'queued',
        reason: options.reason || 'manual',
        completedAt: null,
        lastError: null,
    };
    const run = triggerTail.then(() => runTelegramAccountAccessSweep(dependencies, {
        ...options,
        reason: options.reason || 'manual',
    }));
    triggerTail = run.then(() => undefined, () => undefined);
    return run;
}

export function getTelegramAccountAccessSweepSummary(): TelegramAccountAccessSweepSummary {
    return {
        ...currentSummary,
        counts: { ...currentSummary.counts },
    };
}

export function resetTelegramAccountAccessSweepForTests(): void {
    configuredDependencies = null;
    triggerTail = Promise.resolve();
    nextRunSequence = 0;
    currentSummary = {
        runId: null,
        status: 'idle',
        reason: null,
        startedAt: null,
        completedAt: null,
        counts: EMPTY_COUNTS(),
        lastError: null,
    };
}
