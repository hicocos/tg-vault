import type { QbFile } from './qbittorrentClient.js';

export interface QbTransferSample {
    transferredBytes: number;
    progress: number;
    uploadSpeed: number;
}

export function qbDownloadProgress(files: QbFile[]) {
    let totalBytes = 0;
    let downloadedBytes = 0;
    for (const file of files) {
        if (file.priority <= 0) continue;
        const size = Number.isFinite(file.size) ? Math.max(0, file.size) : 0;
        const progress = Number.isFinite(file.progress) ? Math.max(0, Math.min(1, file.progress)) : 0;
        totalBytes += size;
        downloadedBytes += Math.floor(size * progress);
    }
    return { totalBytes, downloadedBytes, downloadProgress: totalBytes > 0 ? downloadedBytes * 100 / totalBytes : 0 };
}

/** Serializes byte samples; retries replace the current attempt, never add it. */
export class QbTransferProgress {
    private bytes = 0;
    private sampledBytes = 0;
    private sampledAt: number;
    private revision = 0;
    private savedRevision = 0;
    private flight: Promise<void> | undefined;
    private failure: unknown;
    private closed = false;
    private speed = 0;
    private readonly timer: NodeJS.Timeout;

    constructor(private readonly input: {
        committedBytes: number;
        fileBytes: number;
        totalBytes: number;
        persist: (sample: QbTransferSample) => Promise<void>;
        now?: () => number;
    }) {
        this.sampledAt = this.input.now?.() ?? Date.now();
        this.timer = setInterval(() => { void this.flush().catch(error => { this.failure = error; }); }, 1000);
        this.timer.unref();
    }

    readonly report = (bytes: number) => {
        if (this.closed || !Number.isFinite(bytes)) return;
        const next = Math.max(0, Math.min(this.input.fileBytes, bytes));
        if (next < this.bytes) {
            this.sampledBytes = next;
            this.sampledAt = this.input.now?.() ?? Date.now();
        }
        this.bytes = next;
        this.revision += 1;
    };

    private async persist() {
        const revision = this.revision;
        const transferredBytes = Math.min(this.input.totalBytes, this.input.committedBytes + this.bytes);
        const now = this.input.now?.() ?? Date.now();
        const elapsed = now - this.sampledAt;
        const uploadSpeed = elapsed > 0 ? Math.max(0, (this.bytes - this.sampledBytes) * 1000 / elapsed) : 0;
        this.speed = uploadSpeed;
        this.sampledBytes = this.bytes;
        this.sampledAt = now;
        await this.input.persist({ transferredBytes,
            progress: this.input.totalBytes > 0 ? Math.min(99, transferredBytes * 100 / this.input.totalBytes) : 0, uploadSpeed });
        this.savedRevision = revision;
    }

    async flush() {
        while (this.flight) await this.flight;
        if (this.failure) throw this.failure;
        if (this.closed || this.savedRevision === this.revision && this.speed === 0) return;
        const operation = this.persist();
        this.flight = operation;
        try { await operation; }
        finally { if (this.flight === operation) this.flight = undefined; }
    }

    async close() {
        this.closed = true;
        clearInterval(this.timer);
        await this.flight;
    }
}
