type IngressKind = 'message' | 'file' | 'control';
interface Bucket { startedAt: number; count: number }

export class TelegramIngressLimit {
    private readonly buckets = new Map<string, Bucket>();
    constructor(private readonly options: { windowMs: number; messageMax: number; fileMax: number; controlMax: number; heavyWindowMs: number; heavyMax: number }, private readonly now = Date.now) {}

    consume(userId: number, kind: IngressKind, heavyCommand?: string): { limited: boolean; retryAfterSeconds: number } {
        const now = this.now();
        const checks = [{ key: `${userId}:${kind}`, windowMs: this.options.windowMs,
            max: kind === 'file' ? this.options.fileMax : kind === 'control' ? this.options.controlMax : this.options.messageMax }];
        if (heavyCommand) checks.push({ key: `${userId}:heavy:${heavyCommand}`, windowMs: this.options.heavyWindowMs, max: this.options.heavyMax });
        let retryAfterSeconds = 0;
        for (const check of checks) {
            const bucket = this.buckets.get(check.key);
            if (bucket && now - bucket.startedAt < check.windowMs && bucket.count >= check.max) {
                retryAfterSeconds = Math.max(retryAfterSeconds, Math.ceil((check.windowMs - now + bucket.startedAt) / 1000));
            }
        }
        if (!retryAfterSeconds) {
            for (const check of checks) {
                const bucket = this.buckets.get(check.key);
                if (!bucket || now - bucket.startedAt >= check.windowMs) this.buckets.set(check.key, { startedAt: now, count: 1 });
                else bucket.count++;
            }
        }
        for (const [key, bucket] of this.buckets) {
            if (now - bucket.startedAt >= Math.max(this.options.windowMs, this.options.heavyWindowMs) * 2) this.buckets.delete(key);
        }
        return { limited: retryAfterSeconds > 0, retryAfterSeconds };
    }
}
