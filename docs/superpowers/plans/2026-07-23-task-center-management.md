# Task Center Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe terminal-task removal, multi-select removal, filter-scoped cleanup, and improved mobile task management without deleting files or underlying business records.

**Architecture:** Persist exact-version task-center dismissals separately from task state. Reuse one unified task snapshot builder for listing and frozen prepare/confirm removal. The frontend consumes explicit `dismissible` capability and typed preview/result contracts.

**Tech Stack:** Express, PostgreSQL 16, TypeScript, React 19, Node test runner, Docker Compose.

## Global Constraints

- Preserve all current dirty routing and responsive work.
- Never delete files, cloud objects, subscriptions, source task rows, or reconciliation journals.
- Only terminal task versions may be dismissed.
- Every removal requires server-side prepare/confirm with an immutable snapshot.
- Do not push to GitHub.

---

### Task 1: Persistent exact-version dismissal repository

**Files:**
- Modify: `backend/src/db/schema.sql`
- Modify: `backend/src/db/index.ts`
- Create: `backend/src/services/taskCenterDismissals.ts`
- Create: `backend/src/services/taskCenterDismissals.test.ts`

**Interfaces:**
- `isTaskDismissible(task): boolean`
- `filterDismissedTasks(tasks, dismissals): task[]`
- `saveDismissals(snapshot[]): Promise<void>`

- [ ] Write tests proving only terminal states are eligible and an `updatedAt` change makes a dismissed task visible again.
- [ ] Run focused test and confirm RED.
- [ ] Add the table/index and pure/repository helpers.
- [ ] Run focused test and confirm GREEN.

### Task 2: Frozen prepare/confirm backend protocol

**Files:**
- Modify: `backend/src/services/webDestructiveConfirmation.ts`
- Modify: `backend/src/routes/tasks.ts`
- Create: `backend/src/routes/taskDismissalContract.test.ts`

**Interfaces:**
- `POST /api/tasks/dismissals/prepare`
- `POST /api/tasks/dismissals/confirm`

- [ ] Add RED tests for direct-confirm rejection, terminal filtering, immutable snapshot, replay, changed-version rejection, and no-file-deletion contract.
- [ ] Extract unified task collection so list and prepare inspect identical truth.
- [ ] Extend confirmation action binding for `dismiss_tasks` with frozen snapshot context.
- [ ] Implement preview counts and complete/207 confirm results.
- [ ] Run focused and backend full tests.

### Task 3: Typed frontend API

**Files:**
- Modify: `frontend/src/services/api.ts`
- Create: `frontend/src/services/taskDismissalExperience.test.ts`

**Interfaces:**
- `UnifiedTask.dismissible`
- `prepareTaskDismissal(input)`
- `confirmTaskDismissal(token)`

- [ ] Write RED source/contract tests.
- [ ] Add types and API methods with typed partial outcomes.
- [ ] Run focused test GREEN.

### Task 4: Mobile management UX

**Files:**
- Modify: `frontend/src/components/pages/TasksPage.tsx`
- Add/modify focused tests under `frontend/src/components/pages/` and `frontend/src/services/`.

- [ ] Write RED tests for terminal-only delete, selection mode, filter-scoped cleanup, impact confirmation, and compact mobile controls.
- [ ] Add single-record removal and confirmation.
- [ ] Add multi-select, eligible select-all, and bulk removal.
- [ ] Add filter-scoped cleanup preview.
- [ ] Compress filters, remove duplicate state text, and improve mobile metadata/title layout.
- [ ] Run focused and frontend full tests, lint, and build.

### Task 5: Deploy and production verification

**Files:**
- Generated backend bundle: `backend/dist/index.js`

- [ ] Run `git diff --check`, backend tests/typecheck/build, frontend tests/lint/build.
- [ ] Rebuild backend and frontend images and recreate both services once.
- [ ] Verify `task_center_dismissals` schema and production row counts.
- [ ] Use a short-lived authenticated test session or local safe harness to prove preview/confirm hides only a terminal test-version and changed versions reappear; delete test dismissal/session afterward.
- [ ] Verify mobile Chromium at 320/360/390/412px, health 200, zero restarts, and zero recent severe errors.
