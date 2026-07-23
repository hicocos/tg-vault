export interface FolderBreadcrumb {
    label: string;
    path: string;
}

function segments(path: string | null | undefined): string[] {
    return (path || '').split('/').map(segment => segment.trim()).filter(Boolean);
}

export function buildFolderBreadcrumbs(path: string | null | undefined): FolderBreadcrumb[] {
    const parts = segments(path);
    return parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join('/') }));
}

export function parentFolder(path: string | null | undefined): string | null {
    const parts = segments(path);
    return parts.length > 1 ? parts.slice(0, -1).join('/') : null;
}

export function folderLeafName(path: string | null | undefined): string {
    return segments(path).at(-1) || '';
}

export function directChildFolders(paths: string[], current: string | null): FolderBreadcrumb[] {
    const prefix = current ? `${segments(current).join('/')}/` : '';
    const children = new Map<string, FolderBreadcrumb>();
    for (const path of paths) {
        const normalized = segments(path).join('/');
        if (!normalized.startsWith(prefix)) continue;
        const remainder = normalized.slice(prefix.length);
        const label = remainder.split('/')[0];
        if (!label) continue;
        const childPath = `${prefix}${label}`;
        children.set(childPath, { label, path: childPath });
    }
    return [...children.values()].sort((a, b) => a.label.localeCompare(b.label));
}
