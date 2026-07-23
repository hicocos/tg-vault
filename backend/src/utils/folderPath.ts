const INVALID_SEGMENT_CHARACTERS = /[\\:*?"<>|\x00-\x1f\x7f]/;

export const MAX_FOLDER_PATH_LENGTH = 255;

export function normalizeFolderPath(value: unknown): string {
    if (typeof value !== 'string') throw new Error('文件夹路径格式错误');
    const normalized = value.trim().replace(/^\/+|\/+$/g, '');
    if (!normalized) throw new Error('文件夹路径不能为空');
    if (normalized.length > MAX_FOLDER_PATH_LENGTH) throw new Error(`文件夹路径不能超过 ${MAX_FOLDER_PATH_LENGTH} 个字符`);

    const segments = normalized.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error('文件夹路径包含空目录或相对路径');
    }
    if (segments.some(segment => segment !== segment.trim() || INVALID_SEGMENT_CHARACTERS.test(segment))) {
        throw new Error('文件夹路径包含非法字符');
    }
    return segments.join('/');
}

export function normalizeFolderName(value: unknown): string {
    const name = normalizeFolderPath(value);
    if (name.includes('/')) throw new Error('文件夹名称不能包含路径分隔符');
    return name;
}

export function folderBaseName(folder: string): string {
    const segments = folder.split('/');
    return segments[segments.length - 1];
}

export function folderParent(folder: string): string | null {
    const segments = folder.split('/');
    return segments.length > 1 ? segments.slice(0, -1).join('/') : null;
}

export function joinFolderPath(parent: string | null, name: string): string {
    return normalizeFolderPath(parent ? `${parent}/${name}` : name);
}

export function isFolderWithin(folder: string, ancestor: string): boolean {
    return folder === ancestor || folder.startsWith(`${ancestor}/`);
}
