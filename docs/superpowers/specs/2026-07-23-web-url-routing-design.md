# Web URL Routing Design

## Goal

Give every TG Vault Web page a stable URL so navigation changes the address bar, direct links survive refresh, and browser Back/Forward restores the selected page.

## Route Map

- `/` redirects with `history.replaceState` to `/files`.
- `/files`: all files.
- `/files/media`: all media.
- `/files/images`: images.
- `/files/videos`: videos.
- `/files/audio`: audio.
- `/files/documents`: documents.
- `/files/ytdlp`: YT-DLP files.
- `/files/favorites`: favorites.
- `/tasks`: task center.
- `/settings/general`: general settings.
- `/settings/security`: security settings.
- `/settings/telegram`: Telegram settings.
- `/settings/storage`: storage settings.
- `/settings/maintenance`: maintenance settings.

Unknown paths are replaced with `/files`. File routes may preserve `folder` and `q` query parameters. Query changes use `replaceState` to avoid filling browser history on every keystroke; page/category/folder navigation uses `pushState`.

## Architecture

Create a dependency-free routing module in `frontend/src/services/appRoute.ts`. It owns route parsing, canonical path generation, category/section mapping, and query normalization. React components consume typed route state rather than duplicating pathname logic.

`App.tsx` owns current route state and listens for `popstate`. `AppLayout` becomes controlled by the active category and delegates navigation to `App`. `SettingsPage` becomes controlled by the active settings section and delegates section changes to `App`.

The existing Nginx `try_files $uri $uri/ /index.html` fallback already supports Browser History deep links, so no server configuration change is required.

## Navigation Behavior

- Sidebar navigation updates content and URL together.
- Settings tabs update the settings subpath.
- Reloading a valid deep link restores that page.
- Browser Back/Forward restores content, active sidebar item, and active settings tab.
- Folder navigation writes a `folder` query parameter.
- Search writes a `q` query parameter without adding one history entry per keystroke.
- Authentication does not discard the requested path; after authentication the same route renders.

## Compatibility and Scope

- Keep the existing SPA and do not add React Router.
- Preserve current API, authentication, mobile toolbar, and horizontally scrollable settings tabs.
- Do not change backend routes or database state.
- Do not push to GitHub.

## Verification

Use pure route tests for every path, invalid paths, query round-trips, and canonicalization. Use a real Chromium browser against the rebuilt public site to verify click navigation, direct deep-link refresh, unknown-path fallback, settings subroutes, and Back/Forward. Run the full frontend test suite, ESLint, production build, Docker rebuild/recreate, health checks, and recent-log inspection.
