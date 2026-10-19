import fs from 'node:fs/promises';

export class TelegramDiskReservations {
    private readonly reservations = new Map<string, { device: bigint; remaining: number }>();
    private updates: Promise<unknown> = Promise.resolve();

    async reserve(id: string, directory: string, bytes: number, reserveBytes: number): Promise<{ ok: boolean; availableBytes: number; requiredBytes: number }> {
        const operation = this.updates.then(async () => {
            const [disk, stat] = await Promise.all([fs.statfs(directory), fs.stat(directory, { bigint: true })]);
            const availableBytes = Number(disk.bavail) * Number(disk.bsize);
            const otherBytes = Array.from(this.reservations.entries()).reduce((sum, [key, entry]) => sum + (key !== id && entry.device === stat.dev ? entry.remaining : 0), 0);
            const requiredBytes = Math.max(0, bytes) + otherBytes;
            const ok = availableBytes - requiredBytes >= reserveBytes;
            if (ok) this.reservations.set(id, { device: stat.dev, remaining: Math.max(0, bytes) });
            return { ok, availableBytes, requiredBytes };
        });
        this.updates = operation.catch(() => undefined);
        return operation;
    }

    commit(id: string, bytes: number): void {
        this.updates = this.updates.then(() => {
            const entry = this.reservations.get(id);
            if (entry) entry.remaining = Math.max(0, entry.remaining - bytes);
        });
    }

    release(id: string): void {
        this.updates = this.updates.then(() => { this.reservations.delete(id); });
    }
}
