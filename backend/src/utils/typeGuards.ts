/** Object discriminator only; boundary parsers must validate every consumed field. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
