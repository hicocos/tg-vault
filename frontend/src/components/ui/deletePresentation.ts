export function formatDeleteSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const kib = 1024;
    const mib = kib * 1024;
    const gib = mib * 1024;
    if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GiB`;
    if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MiB`;
    if (bytes >= kib) return `${(bytes / kib).toFixed(1)} KiB`;
    return `${Math.round(bytes)} B`;
}
