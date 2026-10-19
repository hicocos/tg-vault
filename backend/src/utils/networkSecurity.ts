import dns from 'dns/promises';
import net from 'net';
import { Agent, fetch as undiciFetch } from 'undici';

interface ResolvedPublicAddress {
    address: string;
    family: 4 | 6;
}

interface ResolvedPublicUrl {
    url: URL;
    addresses: ResolvedPublicAddress[];
}

function ipv4ToInt(ip: string): number {
    return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function isPrivateIPv4(ip: string): boolean {
    const n = ipv4ToInt(ip);
    const ranges: Array<[string, string]> = [
        ['0.0.0.0', '0.255.255.255'],
        ['10.0.0.0', '10.255.255.255'],
        ['100.64.0.0', '100.127.255.255'],
        ['127.0.0.0', '127.255.255.255'],
        ['169.254.0.0', '169.254.255.255'],
        ['172.16.0.0', '172.31.255.255'],
        ['192.0.0.0', '192.0.0.255'],
        ['192.0.2.0', '192.0.2.255'],
        ['192.88.99.0', '192.88.99.255'],
        ['192.168.0.0', '192.168.255.255'],
        ['198.18.0.0', '198.19.255.255'],
        ['198.51.100.0', '198.51.100.255'],
        ['203.0.113.0', '203.0.113.255'],
        ['224.0.0.0', '239.255.255.255'],
        ['240.0.0.0', '255.255.255.255'],
    ];
    return ranges.some(([start, end]) => n >= ipv4ToInt(start) && n <= ipv4ToInt(end));
}

function ipv6ToBigInt(ip: string): bigint | null {
    let normalized = ip.toLowerCase().split('%', 1)[0];
    if (net.isIP(normalized) !== 6) return null;
    if (normalized.includes('.')) {
        const lastColon = normalized.lastIndexOf(':');
        const dotted = normalized.slice(lastColon + 1);
        const octets = dotted.split('.').map(Number);
        if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
        normalized = `${normalized.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const halves = normalized.split('::');
    if (halves.length > 2) return null;
    const parseHalf = (half: string) => half ? half.split(':').map(part => Number.parseInt(part, 16)) : [];
    const left = parseHalf(halves[0]);
    const right = parseHalf(halves[1] || '');
    const parts = halves.length === 2
        ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
        : left;
    if (parts.length !== 8 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
    return parts.reduce((value, part) => (value << 16n) | BigInt(part), 0n);
}

function isInIpv6Cidr(ip: bigint, base: string, prefix: number): boolean {
    const baseValue = ipv6ToBigInt(base);
    if (baseValue === null) return false;
    const shift = 128n - BigInt(prefix);
    return (ip >> shift) === (baseValue >> shift);
}

function isPrivateIPv6(ip: string): boolean {
    const numeric = ipv6ToBigInt(ip);
    if (numeric === null) return true;

    // Only globally routable unicast literals are eligible for outbound fetches.
    if (!isInIpv6Cidr(numeric, '2000::', 3)) return true;
    for (const [base, prefix] of [
        ['2001::', 32],
        ['2001:2::', 48],
        ['2001:10::', 28],
        ['2001:20::', 28],
        ['2001:db8::', 32],
    ] as const) {
        if (isInIpv6Cidr(numeric, base, prefix)) return true;
    }

    // 6to4 can otherwise tunnel an IPv4 special-use destination.
    if (isInIpv6Cidr(numeric, '2002::', 16)) {
        const embedded = Number((numeric >> 80n) & 0xffffffffn);
        const dotted = `${embedded >>> 24}.${(embedded >>> 16) & 0xff}.${(embedded >>> 8) & 0xff}.${embedded & 0xff}`;
        return isPrivateIPv4(dotted);
    }
    return false;
}

export function isPrivateAddress(ip: string): boolean {
    const version = net.isIP(ip);
    if (version === 4) return isPrivateIPv4(ip);
    if (version === 6) return isPrivateIPv6(ip);
    return true;
}

export async function resolvePublicHttpUrl(rawUrl: string): Promise<ResolvedPublicUrl> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('链接格式无效');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅允许 http/https 链接');
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!hostname || ['localhost', 'localhost.localdomain'].includes(hostname.toLowerCase())) throw new Error('不允许访问本机地址');
    const directIpVersion = net.isIP(hostname);
    const resolved = directIpVersion
        ? [{ address: hostname, family: directIpVersion as 4 | 6 }]
        : await dns.lookup(hostname, { all: true, verbatim: true });
    const addresses = resolved.map(item => ({ address: item.address, family: item.family as 4 | 6 }));
    if (addresses.length === 0 || addresses.some(item => isPrivateAddress(item.address))) {
        throw new Error('不允许访问内网、回环或保留地址');
    }
    return { url: parsed, addresses };
}

function pinnedLookup(addresses: ResolvedPublicAddress[]) {
    let cursor = 0;
    return (_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
        if (options?.all) {
            callback(null, addresses.map(item => ({ ...item })));
            return;
        }
        const selected = addresses[cursor++ % addresses.length];
        callback(null, selected.address, selected.family);
    };
}

async function fetchPinnedPublicUrl(rawUrl: string, init: RequestInit): Promise<Response> {
    const resolved = await resolvePublicHttpUrl(rawUrl);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(resolved.addresses) } });
    try {
        const response = await undiciFetch(resolved.url, {
            ...(init as any),
            redirect: 'manual',
            dispatcher,
        });
        if (!response.body) {
            await dispatcher.close();
            return response as unknown as Response;
        }
        const reader = response.body.getReader();
        let closed = false;
        const close = async () => {
            if (closed) return;
            closed = true;
            await dispatcher.close().catch(() => undefined);
        };
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const chunk = await reader.read();
                    if (chunk.done) {
                        controller.close();
                        await close();
                    } else controller.enqueue(chunk.value);
                } catch (error) {
                    controller.error(error);
                    await close();
                }
            },
            async cancel(reason) {
                await reader.cancel(reason).catch(() => undefined);
                await close();
            },
        });
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    } catch (error) {
        await dispatcher.close().catch(() => undefined);
        throw error;
    }
}

export async function fetchPublicHttpUrl(rawUrl: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
    let current = new URL(rawUrl);
    const method = String(init.method || 'GET').toUpperCase();
    for (let redirectCount = 0; ; redirectCount += 1) {
        const response = await fetchPinnedPublicUrl(current.toString(), init);
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new Error('远端重定向缺少 Location');
        if (!['GET', 'HEAD'].includes(method)) throw new Error('存储写入请求不允许重定向');
        if (redirectCount >= maxRedirects) throw new Error('远端重定向次数过多');
        current = new URL(location, current);
    }
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
    return (await resolvePublicHttpUrl(rawUrl)).url;
}

export async function assertPublicHttpsUrl(rawUrl: string): Promise<URL> {
    const parsed = await assertPublicHttpUrl(rawUrl);
    if (parsed.protocol !== 'https:') {
        throw new Error('生产存储端点仅允许 https 链接');
    }
    return parsed;
}

export interface StorageEndpointPolicy {
    allowPrivateAddresses?: boolean;
    allowInsecureHttp?: boolean;
}

export async function assertStorageEndpoint(rawUrl: string, policy: StorageEndpointPolicy = {}): Promise<URL> {
    if (!policy.allowPrivateAddresses) {
        const parsed = await assertPublicHttpUrl(rawUrl);
        if (parsed.protocol !== 'https:' && !policy.allowInsecureHttp && process.env.ALLOW_INSECURE_STORAGE_ENDPOINTS !== 'true') {
            throw new Error('存储端点仅允许 https；如确需 http，请显式设置 ALLOW_INSECURE_STORAGE_ENDPOINTS=true');
        }
        return parsed;
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('链接格式无效');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('仅允许 http/https 链接');
    }
    if (parsed.protocol !== 'https:' && !policy.allowInsecureHttp && process.env.ALLOW_INSECURE_STORAGE_ENDPOINTS !== 'true') {
        throw new Error('存储端点仅允许 https；如确需 http，请显式设置 ALLOW_INSECURE_STORAGE_ENDPOINTS=true');
    }
    return parsed;
}

export async function assertPublicStorageEndpoint(rawUrl: string): Promise<URL> {
    return assertStorageEndpoint(rawUrl);
}
