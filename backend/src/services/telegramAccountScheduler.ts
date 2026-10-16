export type TelegramAccountHealthState = 'healthy' | 'degraded' | 'session_expired';
export type TelegramSourceAccessState = 'unknown' | 'allowed' | 'denied';

export interface TelegramAccountSchedulingCandidate {
    accountId: string;
    enabled: boolean;
    healthState: TelegramAccountHealthState;
    cooldownUntil: Date | string | null;
    weight: number;
    priority?: number;
    activeConnections: number;
    maxConnections: number;
    sourceAccessState: TelegramSourceAccessState;
    lastSelected?: number;
}

export interface TelegramAccountSchedulingOptions {
    now?: Date;
    excludeAccountIds?: Iterable<string>;
}

/**
 * Pure permission-aware weighted least-connections selection.
 * Known source access is preferred over an unprobed account. Within the same
 * access class, the lowest active/weight score wins. Equal-load accounts rotate
 * by last selection, with priority and account id resolving initial ties.
 */
export function selectWeightedLeastConnectedTelegramAccount<T extends TelegramAccountSchedulingCandidate>(
    candidates: readonly T[],
    options: TelegramAccountSchedulingOptions = {},
): T | null {
    const now = (options.now || new Date()).getTime();
    const excluded = new Set(options.excludeAccountIds || []);
    const runnable = candidates.filter(candidate => {
        const cooldownUntil = candidate.cooldownUntil ? new Date(candidate.cooldownUntil).getTime() : 0;
        return candidate.enabled
            && candidate.healthState !== 'session_expired'
            && candidate.sourceAccessState !== 'denied'
            && !excluded.has(candidate.accountId)
            && candidate.activeConnections < Math.max(1, candidate.maxConnections)
            && (!Number.isFinite(cooldownUntil) || cooldownUntil <= now);
    });

    runnable.sort((left, right) => {
        const accessDifference = Number(right.sourceAccessState === 'allowed') - Number(left.sourceAccessState === 'allowed');
        if (accessDifference) return accessDifference;
        const leftLoad = (left.activeConnections + 1) / Math.max(Number.EPSILON, left.weight);
        const rightLoad = (right.activeConnections + 1) / Math.max(Number.EPSILON, right.weight);
        if (leftLoad !== rightLoad) return leftLoad - rightLoad;
        const rotationDifference = (left.lastSelected || 0) - (right.lastSelected || 0);
        if (rotationDifference) return rotationDifference;
        const priorityDifference = (right.priority || 0) - (left.priority || 0);
        if (priorityDifference) return priorityDifference;
        return left.accountId.localeCompare(right.accountId);
    });
    return runnable[0] || null;
}

export function normalizeTelegramAccountSourceKey(sourceKey: string): string {
    const key = sourceKey.trim();
    if (/^-100\d+$/.test(key)) return key.slice(4);
    const peerLink = key.match(/^(?:https?:\/\/)?t\.me\/c\/([0-9]+)(?:\/[0-9]+)?\/?$/i);
    if (peerLink) return peerLink[1];
    const publicLink = key.match(/^(?:https?:\/\/)?t\.me\/(?:s\/)?(?!joinchat(?:\/|$))([a-z][a-z0-9_]*)(?:\/[0-9]+)?\/?$/i);
    if (publicLink) return publicLink[1].toLowerCase();
    return /^@?[a-z\d_]+$/i.test(key) ? key.replace(/^@/, '').toLowerCase() : key;
}
