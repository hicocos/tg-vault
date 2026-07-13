import crypto from 'node:crypto';

export interface WebSessionRepository {
    insert(tokenHash: string, expiresAt: Date): Promise<void>;
    find(tokenHash: string): Promise<{ expiresAt: Date } | null>;
    remove(tokenHash: string): Promise<void>;
}

function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

export function createWebSessionStore(repository: WebSessionRepository) {
    return {
        async issue(expiresAt: Date, randomBytes: (size: number) => Buffer = crypto.randomBytes) {
            const token = randomBytes(32).toString('hex');
            await repository.insert(hashToken(token), expiresAt);
            return { token, expiresAt };
        },
        async verify(token: string, now = new Date()): Promise<boolean> {
            const session = await repository.find(hashToken(token));
            if (!session) return false;
            if (now >= new Date(session.expiresAt)) {
                await repository.remove(hashToken(token));
                return false;
            }
            return true;
        },
        revoke(token: string): Promise<void> {
            return repository.remove(hashToken(token));
        },
    };
}

export const hashWebSessionToken = hashToken;
