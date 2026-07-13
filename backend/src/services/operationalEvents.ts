const REDACT_KEYS = /token|secret|password|cookie|authorization|path|filename|storedname|credential/i;

export function normalizeRequestId(value: unknown): string | null {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128) return null;
    return /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

function redact(value: unknown, key = ''): unknown {
    if (REDACT_KEYS.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map(item => redact(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey)]));
    }
    return value;
}

export function buildOperationalEvent(event: string, requestId: string | null, data: Record<string, unknown>) {
    return {
        timestamp: new Date().toISOString(),
        event,
        requestId,
        data: redact(data) as Record<string, unknown>,
    };
}

export function logOperationalEvent(event: string, requestId: string | null, data: Record<string, unknown>): void {
    console.log(JSON.stringify(buildOperationalEvent(event, requestId, data)));
}
