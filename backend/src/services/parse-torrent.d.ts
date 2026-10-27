declare module 'parse-torrent' {
    export default function parseTorrent(input: string | Uint8Array): Promise<{ infoHash: string; name?: string }>;
}
