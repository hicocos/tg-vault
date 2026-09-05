import type { SettingsSectionId } from '../components/pages/settingsSections';

export type FileCategory = 'all' | 'media' | 'image' | 'video' | 'audio' | 'document' | 'favorites';

export type AppRoute =
    | { kind: 'upload'; needsReplace: boolean }
    | { kind: 'files'; category: FileCategory; folder: string | null; query: string; needsReplace: boolean }
    | { kind: 'tasks'; accountId: string | null; needsReplace: boolean }
    | { kind: 'subscriptions'; needsReplace: boolean }
    | { kind: 'settings'; section: SettingsSectionId; needsReplace: boolean };

const CATEGORY_PATHS: Record<FileCategory, string> = {
    all: '/files',
    media: '/files/media',
    image: '/files/images',
    video: '/files/videos',
    audio: '/files/audio',
    document: '/files/documents',

    favorites: '/files/favorites',
};

const PATH_CATEGORIES = new Map(Object.entries(CATEGORY_PATHS).map(([category, path]) => [path, category as FileCategory]));
const SETTINGS_SECTIONS = new Set<SettingsSectionId>(['general', 'security', 'telegram', 'storage', 'maintenance']);

function filesRoute(category: FileCategory = 'all', folder: string | null = null, query = '', needsReplace = false): AppRoute {
    return { kind: 'files', category, folder, query, needsReplace };
}

export function parseAppRoute(location: Pick<Location, 'pathname' | 'search'>): AppRoute {
    const pathname = location.pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/') return { kind: 'upload', needsReplace: false };
    if (pathname === '/upload') return { kind: 'upload', needsReplace: true };
    const category = PATH_CATEGORIES.get(pathname);
    if (category) {
        const params = new URLSearchParams(location.search);
        return filesRoute(category, params.get('folder'), params.get('q') || '');
    }
    if (pathname === '/tasks') {
        const params = new URLSearchParams(location.search);
        return { kind: 'tasks', accountId: params.get('accountId'), needsReplace: false };
    }
    if (pathname === '/subscriptions') return { kind: 'subscriptions', needsReplace: false };
    if (pathname.startsWith('/settings/')) {
        const section = pathname.slice('/settings/'.length) as SettingsSectionId;
        if (SETTINGS_SECTIONS.has(section)) return { kind: 'settings', section, needsReplace: false };
    }
    return { kind: 'upload', needsReplace: true };
}

export function appRouteHref(route: AppRoute): string {
    if (route.kind === 'upload') return '/';
    if (route.kind === 'tasks') {
        const params = new URLSearchParams();
        if (route.accountId) params.set('accountId', route.accountId);
        const search = params.toString();
        return `/tasks${search ? `?${search}` : ''}`;
    }
    if (route.kind === 'settings') return `/settings/${route.section}`;
    if (route.kind === 'subscriptions') return '/subscriptions';
    const params = new URLSearchParams();
    if (route.folder) params.set('folder', route.folder);
    if (route.query) params.set('q', route.query);
    const search = params.toString();
    return `${CATEGORY_PATHS[route.category]}${search ? `?${search}` : ''}`;
}

export function routeForCategory(category: string, options: { folder?: string | null; query?: string } = {}): AppRoute {
    if (category === 'upload') return { kind: 'upload', needsReplace: false };
    if (category === 'tasks') return { kind: 'tasks', accountId: null, needsReplace: false };
    if (category === 'subscriptions') return { kind: 'subscriptions', needsReplace: false };
    if (category === 'settings') return routeForSettings('general');
    const safeCategory = Object.hasOwn(CATEGORY_PATHS, category) ? category as FileCategory : 'all';
    return filesRoute(safeCategory, options.folder ?? null, options.query ?? '');
}

export function routeForSettings(section: SettingsSectionId): AppRoute {
    return { kind: 'settings', section, needsReplace: false };
}
