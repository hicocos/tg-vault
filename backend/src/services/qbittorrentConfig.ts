import path from 'node:path';
import fs from 'node:fs/promises';
import { getSettingStrict, setSettings } from '../utils/settings.js';
import { normalizeFolderPath } from '../utils/folderPath.js';
import { storageManager } from './storage.js';
import { QbittorrentClient, type QbConnection } from './qbittorrentClient.js';

export const QB_DEFAULT_DIRECTORY = '/qBittorrent/download';
export const QB_DEFAULT_PORT = 8080;
export interface QbConfig extends QbConnection {
    enabled: boolean;
    downloadDir: string;
    targetFolder: string;
    targetAccountId: string;
    preserveLocalFiles: boolean;
}

export async function qbEnabled(): Promise<boolean> {
    return (await getSettingStrict('qbittorrent_enabled')).value === 'true';
}

function validateQbPort(port: unknown): number {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WebUI 端口必须是 1 到 65535 之间的整数');
    return port;
}

export async function getQbConfig(): Promise<QbConfig> {
    const keys = ['port', 'username', 'password', 'download_dir', 'target_folder', 'target_account_id', 'preserve_local_files'];
    const values = await Promise.all(keys.map(key => getSettingStrict(`qbittorrent_${key}`)));
    const setting = Object.fromEntries(keys.map((key, index) => [key, values[index].value]));
    return {
        enabled: await qbEnabled(), port: validateQbPort(setting.port === null ? QB_DEFAULT_PORT : Number(setting.port)), username: setting.username || '', password: setting.password || '',
        downloadDir: setting.download_dir || QB_DEFAULT_DIRECTORY,
        targetFolder: setting.target_folder || QB_DEFAULT_DIRECTORY,
        targetAccountId: setting.target_account_id || storageManager.getActiveAccountId() || 'local',
        preserveLocalFiles: setting.preserve_local_files === 'true',
    };
}

export function publicQbConfig(config: QbConfig) {
    if (!config.enabled) return { enabled: false as const };
    const { password, ...visible } = config;
    return { ...visible, hasPassword: Boolean(password) };
}

export function mergeQbConfig(current: QbConfig, patch: Record<string, unknown>): QbConfig {
    if ('apiUrl' in patch) throw new Error('仅支持本机 qBittorrent，请填写 WebUI 端口');
    const next = { ...current };
    if ('port' in patch) next.port = validateQbPort(patch.port);
    for (const key of ['enabled', 'preserveLocalFiles'] as const) {
        if (key in patch) {
            if (typeof patch[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`);
            next[key] = patch[key];
        }
    }
    for (const key of ['username', 'password', 'downloadDir', 'targetFolder', 'targetAccountId'] as const) {
        if (key in patch) {
            if (typeof patch[key] !== 'string') throw new Error(`${key} 格式无效`);
            if (key !== 'password' || patch[key]) next[key] = key === 'password' ? patch[key] : patch[key].trim();
        }
    }
    if (!path.isAbsolute(next.downloadDir) || next.downloadDir === '/' || next.downloadDir.includes('\0')) throw new Error('下载目录必须为非根目录的绝对路径');
    next.downloadDir = path.resolve(next.downloadDir);
    next.targetFolder = `/${normalizeFolderPath(next.targetFolder)}`;
    if (next.targetAccountId !== 'local' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(next.targetAccountId)) throw new Error('存储账户无效');
    return next;
}

export async function saveQbConfig(patch: Record<string, unknown>): Promise<QbConfig> {
    const next = mergeQbConfig(await getQbConfig(), patch);
    const fields: Record<keyof QbConfig, string> = { enabled: 'enabled', port: 'port', username: 'username', password: 'password', downloadDir: 'download_dir', targetFolder: 'target_folder', targetAccountId: 'target_account_id', preserveLocalFiles: 'preserve_local_files' };
    await setSettings(Object.entries(fields).map(([field, key]) => [`qbittorrent_${key}`, String(next[field as keyof QbConfig])]));
    return next;
}

export async function probeQbConfig(config: QbConfig) {
    const [api, directory] = await Promise.all([
        new QbittorrentClient(config).version().then(version => ({ ok: true, version })).catch((error: Error) => ({ ok: false, error: error.message })),
        fs.stat(config.downloadDir).then(async stat => {
            if (!stat.isDirectory()) throw new Error('下载路径不是目录');
            await fs.access(config.downloadDir, fs.constants.R_OK | fs.constants.X_OK);
            return { ok: true };
        }).catch((error: Error) => ({ ok: false, error: error.message })),
    ]);
    return { api, directory };
}
