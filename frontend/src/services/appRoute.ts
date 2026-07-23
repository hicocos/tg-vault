import type { SettingsSectionId } from '../components/pages/settingsSections';

export type FileCategory = 'all' | 'media' | 'image' | 'video' | 'audio' | 'document' | 'ytdlp' | 'favorites';

export type AppRoute =
    | { kind: 'files'; category: FileCategory; folder: string | null; query: string; needsReplace: boolean }
    | { kind: 'tasks'; needsReplace: boolean }
    | { kind: 'settings'; section: SettingsSectionId; needsReplace: boolean };

const CATEGORY_PATHS: Record<FileCategory, string> = {
    all: '/files',
    media: '/files/media',
    image: '/files/images',
    video: '/files/videos',
    audio: '/files/audio',
    document: '/files/documents',
    ytdlp: '/files/ytdlp',
    favorites: '/files/favorites',
};

const PATH_CATEGORIES = new Map(Object.entries(CATEGORY_PATHS).map(([category, path]) => [path, category as FileCategory]));
const SETTINGS_SECTIONS = new Set<SettingsSectionId>(['general', 'security', 'telegram', 'storage', 'maintenance']);

function filesRoute(category: FileCategory = 'all', folder: string | null = null, query = '', needsReplace = false): AppRoute {
    return { kind: 'files', category, folder, query, needsReplace };
}

export function parseAppRoute(location: Pick<Location, 'pathname' | 'search'>): AppRoute {
    const pathname = location.pathname.replace(/\/+$/, '') || '/';
    const category = PATH_CATEGORIES.get(pathname);
    if (category) {
        const params = new URLSearchParams(location.search);
        return filesRoute(category, params.get('folder'), params.get('q') || '');
    }
    if (pathname === '/tasks') return { kind: 'tasks', needsReplace: false };
    if (pathname.startsWith('/settings/')) {
        const section = pathname.slice('/settings/'.length) as SettingsSectionId;
        if (SETTINGS_SECTIONS.has(section)) return { kind: 'settings', section, needsReplace: false };
    }
    return filesRoute('all', null, '', true);
}

export function appRouteHref(route: AppRoute): string {
    if (route.kind === 'tasks') return '/tasks';
    if (route.kind === 'settings') return `/settings/${route.section}`;
    const params = new URLSearchParams();
    if (route.folder) params.set('folder', route.folder);
    if (route.query) params.set('q', route.query);
    const search = params.toString();
    return `${CATEGORY_PATHS[route.category]}${search ? `?${search}` : ''}`;
}

export function routeForCategory(category: string, options: { folder?: string | null; query?: string } = {}): AppRoute {
    if (category === 'tasks') return { kind: 'tasks', needsReplace: false };
    if (category === 'settings') return routeForSettings('general');
    const safeCategory = Object.hasOwn(CATEGORY_PATHS, category) ? category as FileCategory : 'all';
    return filesRoute(safeCategory, options.folder ?? null, options.query ?? '');
}

export function routeForSettings(section: SettingsSectionId): AppRoute {
    return { kind: 'settings', section, needsReplace: false };
}
