import crypto from 'crypto';

export type DestructiveAction = 'delete_file' | 'clear_local_storage' | 'cancel_task_scope';

export interface DestructiveConfirmationBinding {
    actorId: number;
    chatId: string;
    messageId: number;
    action: DestructiveAction;
    objectId?: string;
}

export interface DestructiveConfirmation extends DestructiveConfirmationBinding {
    expiresAt: number;
}

export interface DestructiveConfirmationStoreOptions {
    ttlMs?: number;
    now?: () => number;
    tokenFactory?: () => string;
}

export class DestructiveConfirmationStore {
    private readonly confirmations = new Map<string, DestructiveConfirmation>();
    private readonly ttlMs: number;
    private readonly now: () => number;
    private readonly tokenFactory: () => string;

    constructor(options: DestructiveConfirmationStoreOptions = {}) {
        this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
        this.now = options.now ?? (() => Date.now());
        this.tokenFactory = options.tokenFactory ?? (() => crypto.randomBytes(18).toString('base64url'));
    }

    issue(binding: DestructiveConfirmationBinding): string {
        const token = this.tokenFactory();
        this.confirmations.set(token, { ...binding, expiresAt: this.now() + this.ttlMs });
        return token;
    }

    consume(token: string, binding: DestructiveConfirmationBinding): {
        status: 'ok' | 'missing' | 'expired' | 'mismatch';
        confirmation?: DestructiveConfirmation;
    } {
        const confirmation = this.confirmations.get(token);
        if (!confirmation) return { status: 'missing' };
        if (confirmation.expiresAt < this.now()) {
            this.confirmations.delete(token);
            return { status: 'expired' };
        }
        if (!this.matches(confirmation, binding)) return { status: 'mismatch' };
        this.confirmations.delete(token);
        return { status: 'ok', confirmation };
    }

    cancel(token: string, binding: DestructiveConfirmationBinding): boolean {
        const confirmation = this.confirmations.get(token);
        if (!confirmation) return false;
        if (confirmation.expiresAt < this.now()) {
            this.confirmations.delete(token);
            return false;
        }
        if (!this.matches(confirmation, binding)) return false;
        this.confirmations.delete(token);
        return true;
    }

    private matches(left: DestructiveConfirmationBinding, right: DestructiveConfirmationBinding): boolean {
        return left.actorId === right.actorId
            && left.chatId === right.chatId
            && left.messageId === right.messageId
            && left.action === right.action
            && left.objectId === right.objectId;
    }
}
