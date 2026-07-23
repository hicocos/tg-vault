# Web URL Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stable Browser History URLs for every file category, task center, settings page, and settings subsection while preserving deep-link refresh and Back/Forward behavior.

**Architecture:** A dependency-free `appRoute.ts` module parses and generates canonical routes. `App.tsx` owns route state; `AppLayout` and `SettingsPage` become controlled navigation views. Nginx already falls back to `index.html` for deep links.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Node test runner via `tsx`, Browser History API, Docker Compose, Nginx.

## Global Constraints

- Preserve all current uncommitted responsive fixes.
- Do not add React Router or another dependency.
- Do not change backend/API/database behavior.
- Use `pushState` for page/category/folder navigation and `replaceState` for canonicalization and search query changes.
- Do not push to GitHub.

---

### Task 1: Typed route model and canonical parser

**Files:**
- Create: `frontend/src/services/appRoute.ts`
- Create: `frontend/src/services/appRoute.test.ts`

**Interfaces:**
- Produces: `AppRoute`, `FileCategory`, `parseAppRoute(location)`, `appRouteHref(route)`, `routeForCategory(category, query?)`, `routeForSettings(section)`.

- [ ] **Step 1: Write failing tests** covering `/`, all file paths, `/tasks`, every settings subsection, invalid fallback, and `folder`/`q` query round-trips.
- [ ] **Step 2: Run** `npx tsx --test src/services/appRoute.test.ts`; expect failure because `appRoute.ts` is absent.
- [ ] **Step 3: Implement** a pure path/query lookup table and canonical serializer. `/` and unknown paths parse to the `/files` route with `needsReplace: true`.
- [ ] **Step 4: Rerun focused tests** and expect all route tests to pass.

### Task 2: App-owned Browser History state

**Files:**
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/services/appRouteWiring.test.ts`

**Interfaces:**
- Consumes: route module from Task 1.
- Produces: controlled `currentCategory`, `settingsSection`, category navigation, settings navigation, folder/search URL synchronization, and `popstate` restoration.

- [ ] **Step 1: Write a source-contract test** requiring initial `parseAppRoute`, `popstate` listener, `pushState`, `replaceState`, and controlled props passed to layout/settings.
- [ ] **Step 2: Run focused test** and confirm RED because wiring is absent.
- [ ] **Step 3: Implement minimal wiring**: initialize from `window.location`, canonicalize `/`/unknown paths, listen to `popstate`, update category/folder/search from route, push page/folder transitions, replace search updates.
- [ ] **Step 4: Run focused tests** and confirm GREEN.

### Task 3: Controlled sidebar and settings tabs

**Files:**
- Modify: `frontend/src/components/layout/AppLayout.tsx`
- Modify: `frontend/src/components/pages/SettingsPage.tsx`
- Create: `frontend/src/services/controlledNavigation.test.ts`

**Interfaces:**
- `AppLayout` consumes `activeCategory: string` and `onCategoryChange(id: string)`.
- `SettingsPage` consumes `activeSection: SettingsSectionId` and `onSectionChange(section)`.

- [ ] **Step 1: Write failing contracts** asserting local active-tab/active-section state is removed and controlled props are used.
- [ ] **Step 2: Run focused tests** and confirm RED.
- [ ] **Step 3: Change components** so highlighting and clicks derive from parent route state; preserve mobile drawer closing and horizontal settings-tab scrolling.
- [ ] **Step 4: Run focused tests** and confirm GREEN.

### Task 4: Full verification and live deployment

**Files:**
- No new production files.
- Temporary browser script under `/tmp` only.

- [ ] **Step 1: Run** `npm test`, `npm run lint`, `npm run build`, and `git diff --check` from `frontend/`; expect zero failures.
- [ ] **Step 2: Build and deploy** with `docker compose build frontend && docker compose up -d --no-deps frontend`.
- [ ] **Step 3: Browser verify** `/files`, each category, `/tasks`, all settings subroutes, direct refresh, unknown fallback, and Back/Forward against `https://cloud.moyin.cc`.
- [ ] **Step 4: Verify live state** using Compose health, HTTP 200 checks, restart count 0, and recent error logs 0.
- [ ] **Step 5: Report** exact changed files and evidence; do not commit or push unless separately requested.
