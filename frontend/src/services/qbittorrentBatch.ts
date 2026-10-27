export function parseMagnetLinks(input: string): string[] {
    return [...new Set(input.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}
