# Task Center Management and Safe Record Removal Design

## Goal

Upgrade the task center from a read-only status list into a mobile-friendly management surface with single removal, multi-select removal, and one-click cleanup of terminal records.

## Removal Semantics

“Delete” means hide the exact current version of a terminal task from the task center. It never deletes uploaded/downloaded files, cloud objects, file indexes, subscription configuration, underlying worker rows, reconciliation journals, or audit data.

A dismissal is keyed by `source_type + task_id + task_updated_at`. If the underlying task later changes, retries, resumes, or is recreated with a newer `updated_at`, the dismissal no longer matches and the task appears again automatically.

## Eligible States

Dismissible states are `completed`, `failed`, `cancelled`, `disabled`, `interrupted`, and `retry_required`. Active or schedulable states such as `pending`, `running`, `paused`, `waiting`, `scheduled`, `open`, and `completing` are never dismissible.

## Persistent Model

Add `task_center_dismissals` with:

- `source_type`
- `task_id`
- `task_updated_at`
- `dismissed_at`
- primary key `(source_type, task_id)`

The unified list excludes a task only when the stored dismissal timestamp exactly matches the task’s current `updatedAt`.

## Prepare/Confirm Protocol

`POST /api/tasks/dismissals/prepare` accepts either:

- selected immutable identities (`sourceType + id`), or
- the current source/status filter scope.

The server rebuilds current task truth, keeps only dismissible tasks, freezes exact `sourceType + id + updatedAt` snapshots, and returns a session-bound one-time token plus impact counts by source/status. The response explicitly states that no files or cloud objects are affected.

`POST /api/tasks/dismissals/confirm` consumes the token once and applies only the frozen snapshot. Changed or no-longer-terminal tasks are rejected item-by-item. The response is complete or HTTP 207 partial with dismissed and failed identities.

## Task Center UX

- Compact mobile filters: source and status share a row where space permits; refresh becomes a compact icon action.
- Clickable status summaries apply filters.
- Remove duplicated stage/status wording when both labels are identical.
- Task cards show clearer vertical metadata on mobile, two-line titles, and one status badge.
- A terminal task exposes “删除记录”. Active tasks never expose it.
- Selection mode allows only dismissible tasks to be checked.
- Bulk toolbar supports select-all eligible tasks in the current result and remove selected.
- “清理终态记录” previews all dismissible tasks within the current source/status filters.
- Confirmation clearly states that files, cloud objects, subscriptions, and underlying task data remain untouched.

## Safety and Verification

- Direct confirm without prepare is rejected.
- Tokens bind session, action, snapshot ID, frozen task versions, and expiry.
- Replay, wrong snapshot, and expired token are rejected.
- Newly completed tasks after prepare are not included.
- Tasks changed after prepare fail safely and reappear.
- Verify schema migration, backend unit/contract tests, frontend tests, typecheck/build, Docker deployment, live database schema, authenticated boundary, mobile browser flow, health, and logs.
