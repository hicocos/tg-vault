import crypto from 'node:crypto';

interface Confirmation {
    authTokenHash: string;
    action: 'delete_file' | 'delete_storage_account' | 'cancel_task' | 'dismiss_tasks';
    objectId: string;
    context: string | null;
    expiresAt: number;
}

function hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

export class WebDestructiveConfirmationStore {
    private readonly values = new Map<string, Confirmation>();
    constructor(private readonly ttlMs = 5 * 60 * 1000, private readonly now = () => Date.now()) {}

    issue(input: Omit<Confirmation, 'authTokenHash' | 'expiresAt' | 'context'> & { authToken: string; context?: string | null }) {
        const token = crypto.randomBytes(24).toString('base64url');
        const expiresAt = this.now() + this.ttlMs;
        this.values.set(token, { action: input.action, objectId: input.objectId, context: input.context ?? null, authTokenHash: hash(input.authToken), expiresAt });
        return { confirmationToken: token, expiresAt };
    }

    consume(token: string, input: { authToken: string; action: Confirmation['action']; objectId: string; context?: string | null }) {
        const value = this.values.get(token);
        if (!value) return { status: 'missing' as const };
        if (value.expiresAt < this.now()) {
            this.values.delete(token);
            return { status: 'expired' as const };
        }
        if (value.authTokenHash !== hash(input.authToken) || value.action !== input.action || value.objectId !== input.objectId || value.context !== (input.context ?? null)) {
            return { status: 'mismatch' as const };
        }
        this.values.delete(token);
        return { status: 'ok' as const, context: value.context };
    }
}

export const webDestructiveConfirmationStore = new WebDestructiveConfirmationStore();
