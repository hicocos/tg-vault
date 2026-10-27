export interface QbConnection {
    apiUrl: string;
    username: string;
    password: string;
}

export interface QbTorrent {
    hash: string;
    name: string;
    state: string;
    progress: number;
    dlspeed: number;
    size: number;
    save_path: string;
    content_path: string;
}

export interface QbFile {
    index: number;
    name: string;
    size: number;
    progress: number;
    priority: number;
}

export class QbittorrentClient {
    private cookie = '';
    private loginFlight: Promise<void> | null = null;
    constructor(private readonly config: QbConnection) {}

    private async request(method: string, body?: URLSearchParams | FormData, authenticated = true): Promise<Response> {
        const base = this.config.apiUrl.replace(/\/+$/, '');
        const response = await fetch(`${base}/api/v2/${method}`, {
            method: body ? 'POST' : 'GET',
            body,
            redirect: 'error',
            headers: { Referer: `${base}/`, ...(this.cookie ? { Cookie: this.cookie } : {}) },
            signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 403 && authenticated) {
            this.cookie = '';
            await this.login();
            return this.request(method, body, false);
        }
        if (!response.ok) throw new Error(`qBittorrent API ${method}: HTTP ${response.status}`);
        return response;
    }

    private async login(): Promise<void> {
        if (!this.loginFlight) {
            this.loginFlight = (async () => {
                const response = await this.request('auth/login', new URLSearchParams({ username: this.config.username, password: this.config.password }), false);
                if ((await response.text()).trim() !== 'Ok.') throw new Error('qBittorrent 登录失败，请检查用户名和密码');
                const cookie = response.headers.get('set-cookie')?.match(/(?:^|[,;]\s*)SID=([^;]+)/);
                if (cookie) this.cookie = `SID=${cookie[1]}`;
            })().finally(() => { this.loginFlight = null; });
        }
        await this.loginFlight;
    }

    async version(): Promise<string> {
        if (!this.cookie) await this.login();
        return (await this.request('app/version')).text();
    }

    async torrents(hash?: string): Promise<QbTorrent[]> {
        if (!this.cookie) await this.login();
        return (await this.request(`torrents/info${hash ? `?hashes=${encodeURIComponent(hash)}` : ''}`)).json() as Promise<QbTorrent[]>;
    }

    async files(hash: string): Promise<QbFile[]> {
        return (await this.request(`torrents/files?hash=${encodeURIComponent(hash)}`)).json() as Promise<QbFile[]>;
    }

    async add(input: { magnet?: string; torrent?: Buffer; savePath: string }): Promise<void> {
        if (!this.cookie) await this.login();
        const form = new FormData();
        if (input.magnet) form.set('urls', input.magnet);
        if (input.torrent) form.set('torrents', new Blob([new Uint8Array(input.torrent)]), 'download.torrent');
        form.set('savepath', input.savePath);
        form.set('autoTMM', 'false');
        form.set('contentLayout', 'Original');
        const response = await this.request('torrents/add', form);
        if ((await response.text()).trim() !== 'Ok.') throw new Error('qBittorrent 拒绝添加种子');
    }

    async control(hash: string, action: 'pause' | 'resume' | 'delete'): Promise<void> {
        if (!this.cookie) await this.login();
        const method = action === 'delete' ? 'delete' : (await this.version()).startsWith('v4.') ? action : action === 'pause' ? 'stop' : 'start';
        await this.request(`torrents/${method}`, new URLSearchParams({ hashes: hash, ...(action === 'delete' ? { deleteFiles: 'true' } : {}) }));
    }

    async select(hash: string, files: QbFile[], indexes: number[]): Promise<void> {
        const wanted = new Set(indexes);
        for (const [priority, selected] of [['0', files.filter(file => !wanted.has(file.index))], ['1', files.filter(file => wanted.has(file.index))]] as const) {
            if (selected.length) await this.request('torrents/filePrio', new URLSearchParams({ hash, id: selected.map(file => file.index).join('|'), priority }));
        }
    }
}
