import crypto from 'node:crypto';

export interface BatchDeleteStorageScope {
    provider: string;
    accountId: string | null;
}

export interface BatchDeleteConfirmation {
    authTokenHash: string;
    scope: BatchDeleteStorageScope;
    fileIds: string[];
    expiresAt: number;
}

export interface BatchDeleteConfirmationOptions {
    ttlMs?: number;
    now?: () => number;
    tokenFactory?: () => string;
}

function hashAuthToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function normalizeFileIds(fileIds: string[]): string[] {
    return [...new Set(fileIds)].sort();
}

export class BatchDeleteConfirmationStore {
    private readonly confirmations = new Map<string, BatchDeleteConfirmation>();
    private readonly ttlMs: number;
    private readonly now: () => number;
    private readonly tokenFactory: () => string;

    constructor(options: BatchDeleteConfirmationOptions = {}) {
        this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
        this.now = options.now ?? (() => Date.now());
        this.tokenFactory = options.tokenFactory ?? (() => crypto.randomBytes(24).toString('base64url'));
    }

    issue(input: { authToken: string; scope: BatchDeleteStorageScope; fileIds: string[] }): {
        confirmationToken: string;
        expiresAt: number;
    } {
        const confirmationToken = this.tokenFactory();
        const expiresAt = this.now() + this.ttlMs;
        this.confirmations.set(confirmationToken, {
            authTokenHash: hashAuthToken(input.authToken),
            scope: { ...input.scope },
            fileIds: normalizeFileIds(input.fileIds),
            expiresAt,
        });
        return { confirmationToken, expiresAt };
    }

    consume(confirmationToken: string, binding: { authToken: string; scope: BatchDeleteStorageScope }): {
        status: 'ok' | 'missing' | 'expired' | 'mismatch';
        confirmation?: BatchDeleteConfirmation;
    } {
        const confirmation = this.confirmations.get(confirmationToken);
        if (!confirmation) return { status: 'missing' };
        if (confirmation.expiresAt < this.now()) {
            this.confirmations.delete(confirmationToken);
            return { status: 'expired' };
        }
        if (confirmation.authTokenHash !== hashAuthToken(binding.authToken)
            || confirmation.scope.provider !== binding.scope.provider
            || confirmation.scope.accountId !== binding.scope.accountId) {
            return { status: 'mismatch' };
        }
        this.confirmations.delete(confirmationToken);
        return { status: 'ok', confirmation };
    }
}

export const batchDeleteConfirmationStore = new BatchDeleteConfirmationStore();
