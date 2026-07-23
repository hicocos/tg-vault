export interface UploadTelemetry {
    totalBytes: number;
    loadedBytes: number;
    bytesPerSecond: number;
    etaSeconds: number | null;
    lastSampleAt: number;
}

export function createUploadTelemetry(totalBytes: number, now = Date.now()): UploadTelemetry {
    return {
        totalBytes: Math.max(0, Number.isFinite(totalBytes) ? totalBytes : 0),
        loadedBytes: 0,
        bytesPerSecond: 0,
        etaSeconds: null,
        lastSampleAt: now,
    };
}

export function updateUploadTelemetry(previous: UploadTelemetry, loadedBytes: number, now = Date.now()): UploadTelemetry {
    const loaded = Math.max(previous.loadedBytes, Math.min(previous.totalBytes, Number.isFinite(loadedBytes) ? loadedBytes : previous.loadedBytes));
    const elapsedSeconds = Math.max(0, now - previous.lastSampleAt) / 1000;
    const deltaBytes = Math.max(0, loaded - previous.loadedBytes);
    const instantaneous = elapsedSeconds > 0 ? deltaBytes / elapsedSeconds : 0;
    const bytesPerSecond = instantaneous > 0
        ? (previous.bytesPerSecond > 0 ? previous.bytesPerSecond * 0.7 + instantaneous * 0.3 : instantaneous)
        : previous.bytesPerSecond;
    const remaining = Math.max(0, previous.totalBytes - loaded);
    const etaSeconds = remaining === 0 ? 0 : bytesPerSecond > 0 ? Math.ceil(remaining / bytesPerSecond) : null;
    return {
        ...previous,
        loadedBytes: loaded,
        bytesPerSecond: Number.isFinite(bytesPerSecond) ? bytesPerSecond : 0,
        etaSeconds,
        lastSampleAt: now,
    };
}
