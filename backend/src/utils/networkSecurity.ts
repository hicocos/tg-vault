import dns from 'dns/promises';
import net from 'net';

function ipv4ToInt(ip: string): number {
    return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function isPrivateIPv4(ip: string): boolean {
    const n = ipv4ToInt(ip);
    const ranges: Array<[string, string]> = [
        ['0.0.0.0', '0.255.255.255'],
        ['10.0.0.0', '10.255.255.255'],
        ['127.0.0.0', '127.255.255.255'],
        ['169.254.0.0', '169.254.255.255'],
        ['172.16.0.0', '172.31.255.255'],
        ['192.168.0.0', '192.168.255.255'],
        ['224.0.0.0', '239.255.255.255'],
        ['240.0.0.0', '255.255.255.255'],
    ];
    return ranges.some(([start, end]) => n >= ipv4ToInt(start) && n <= ipv4ToInt(end));
}

function isPrivateIPv6(ip: string): boolean {
    const normalized = ip.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

export function isPrivateAddress(ip: string): boolean {
    const version = net.isIP(ip);
    if (version === 4) return isPrivateIPv4(ip);
    if (version === 6) return isPrivateIPv6(ip);
    return true;
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('链接格式无效');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('仅允许 http/https 链接');
    }
    const hostname = parsed.hostname;
    if (!hostname || ['localhost', 'localhost.localdomain'].includes(hostname.toLowerCase())) {
        throw new Error('不允许访问本机地址');
    }
    const directIpVersion = net.isIP(hostname);
    const addresses = directIpVersion ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(item => isPrivateAddress(item.address))) {
        throw new Error('不允许访问内网、回环或保留地址');
    }
    return parsed;
}
