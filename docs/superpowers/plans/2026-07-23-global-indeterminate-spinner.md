# Global Indeterminate Spinner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every unknown-duration frontend loading animation with one accessible SVG indeterminate spinner while retaining determinate progress indicators.

**Architecture:** A single `IndeterminateSpinner` component owns visual variants and ARIA semantics. Existing call sites provide contextual labels; reduced-motion behavior lives in global CSS.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, SVG, Node test runner, Vite, Docker Compose.

## Global Constraints

- Preserve current routing, task-management, and responsive dirty-tree changes.
- Unknown progress uses `role="progressbar"` without `aria-valuenow`.
- Known percentages continue using determinate bars.
- No new runtime dependencies.
- Do not commit or push.

---

### Task 1: Accessible spinner primitive

**Files:**
- Create: `frontend/src/components/ui/IndeterminateSpinner.tsx`
- Modify: `frontend/src/index.css`
- Create: `frontend/src/services/indeterminateSpinner.test.ts`

- [ ] Write failing contracts for SVG track/arc, required label, progressbar role, no aria-valuenow, variants, and reduced-motion CSS.
- [ ] Run focused test and confirm RED.
- [ ] Implement the component and CSS keyframes/media query.
- [ ] Run focused test and confirm GREEN.

### Task 2: Replace all unknown-duration indicators

**Files:**
- Modify all current frontend files containing loading-related `animate-spin`, `Loader2`, or rotating `RefreshCw` usage.
- Modify: `frontend/src/services/indeterminateSpinner.test.ts`

- [ ] Add RED inventory tests requiring contextual spinner labels and prohibiting legacy unknown-duration spinner patterns.
- [ ] Replace page, button, modal, preview, notification, upload, and queue indicators.
- [ ] Preserve determinate bars and percentages.
- [ ] Run focused test and production build GREEN.

### Task 3: Verify and deploy

- [ ] Run full frontend tests, ESLint, build, and `git diff --check`.
- [ ] Rebuild/recreate only the frontend container.
- [ ] Verify the public asset contains the global spinner and no legacy loading-spinner patterns.
- [ ] Inspect representative light/dark/mobile loading states, frontend health, restart count, and recent logs.
