# TG Vault Second-Round Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复第二轮审计确认的删除一致性、Telegram 持久任务租约/恢复、认证与存储 fail-closed、分块上传协议、OAuth 绑定、前端状态真相及部署可用性问题。

**Architecture:** 把上传、删除、后台任务 claim/settle、OAuth 和部署健康都建模为可持久化且可比较交换的协议，而不是进程内标志或 UI 约定。优先消除数据丢失、重复外部副作用和安全降级；随后统一 Web UI/API 的部分成功与认证语义；最后补齐 readiness、优雅停机、日志滚动和可执行运维文档。

**Tech Stack:** Node.js 20、TypeScript、Express、React/Vite、PostgreSQL 16、GramJS、Docker Compose、node:test/tsx。

## Global Constraints

- 不提交、不推送 GitHub。
- 每个修复先加入能失败的行为测试，再写最小实现。
- 外部对象与数据库索引不能出现“UI 成功但只删除/只创建一边”的结果。
- destructive confirmation 必须绑定 actor/session、存储 scope、不可变对象 ID 快照、TTL，并且一次消费。
- Telegram claim、heartbeat、settlement、restore 必须携带 lease token/generation；旧 worker 不得结算新 lease。
- 用户 pause 只阻止新 claim；已 active 的文件允许完成。cancel 才执行硬中断/补偿。
- 认证关键密钥或 active cloud provider 初始化失败必须 fail closed，不得自动降级为未启用 2FA/本地存储。
- `/livez` 只表示进程存活；`/readyz` 必须反映 DB/schema/storage/security initialization。
- 现有脏工作树属于用户工作；不重置、不覆盖无关改动。
- 修复完成后必须 lint、typecheck、全量测试、构建、Docker 重建部署，并用 HTTP/数据库不变量验证线上结果。

---

### Task 1: 删除与分享的一致性和确认协议

**Files:**
- Create: `backend/src/services/fileDeletion.ts`
- Create: `backend/src/services/batchDeleteConfirmation.ts`
- Modify: `backend/src/routes/files.ts`
- Modify: `backend/src/routes/folderOperations.ts`
- Modify: `backend/src/services/storage.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/ui/DeleteAlert.tsx`
- Test: `backend/src/services/fileDeletion.test.ts`
- Test: `backend/src/services/batchDeleteConfirmation.test.ts`

**Interfaces:**
- `deleteIndexedFile(file): Promise<{status:'deleted'|'not_found'|'failed'; error?:string}>`
- preview returns `{confirmationToken,fileCount,dataFileCount,placeholderCount,folderCount,totalSizeBytes,expiresAt}`.
- execute accepts `{confirmationToken}` and returns a typed complete/partial result including deleted IDs and failed files.

- [ ] Write failing tests for physical-delete failure retaining the index, not-found idempotency, DB-delete failure tombstone/result, token scope/TTL/replay, and 207 typed UI payload.
- [ ] Run focused tests and confirm RED.
- [ ] Implement shared single/batch deletion outcome service and route integration.
- [ ] Implement server-side one-time batch confirmation bound to auth token hash + storage target + immutable IDs.
- [ ] Correct GiB formatting and exclude/label `.folder` placeholders.
- [ ] Make frontend refresh after any partial deletion and preserve failed selections.
- [ ] Reject Google Drive password/expiration before creating public permission.
- [ ] Run focused backend tests, frontend lint/typecheck.

### Task 2: Telegram claim lease、恢复单 owner 与取消补偿

**Files:**
- Modify: `backend/src/db/schema.sql`
- Modify: `backend/src/db/index.ts`
- Modify: `backend/src/services/taskAbortRegistry.ts`
- Modify: `backend/src/services/telegramChannelJobs.ts`
- Modify: `backend/src/services/telegramUpload.ts`
- Modify: `backend/src/services/telegramCommands.ts`
- Test: `backend/src/services/taskAbortRegistry.test.ts`
- Test: `backend/src/services/telegramLeaseProtocol.test.ts`
- Test: `backend/src/services/telegramFinalizationCas.test.ts`

**Interfaces:**
- child claim returns immutable `{id, leaseToken}` and writes `lease_owner/lease_token/lease_expires_at`.
- heartbeat refreshes only the matching token; settle/restore require the token.
- global recovery uses a dedicated PostgreSQL advisory-lock connection.
- cancellation after indexed save removes both object and exact index row or persists reconciliation failure.

- [ ] Write RED tests for ref-counted abort registry, old-token settlement rejection, heartbeat preventing stale reclaim, two recovery instances, pause-after-active, and final CAS preventing cursor/notification.
- [ ] Add lease columns/indexes with backward-compatible migration.
- [ ] Implement ref-counted abort registry.
- [ ] Implement tokenized claim/heartbeat/settlement/restore and cross-instance recovery lock.
- [ ] Change pause so active workers complete while new claim stops.
- [ ] Couple terminal CAS and subscription cursor update; check every affected-row result before user-visible completion.
- [ ] Make subscription short-ID mutation resolve exactly one full UUID.
- [ ] Fail closed legacy `ctq_cancel_*` and remove misleading cooling resume/cause copy.
- [ ] Implement indexed-save cancellation compensation with durable failure evidence.
- [ ] Run focused tests and real PostgreSQL barrier tests.

### Task 3: Authentication/storage initialization fail-closed and readiness

**Files:**
- Modify: `backend/src/utils/security.ts`
- Modify: `backend/src/utils/secretStore.ts`
- Modify: `backend/src/services/storage.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/routes/auth.ts`
- Modify: `docker-compose.yml`
- Test: `backend/src/utils/securityReadiness.test.ts`
- Test: `backend/src/services/storageReadiness.test.ts`

**Interfaces:**
- security readiness distinguishes disabled from enabled-but-secret-unreadable.
- storage manager exposes initialized/ready/error state and never silently switches a configured cloud target to local.
- `/livez` returns process liveness; `/readyz` returns 503 until DB/schema/security/storage are ready.

- [ ] Write RED tests for wrong SESSION_SECRET with enabled 2FA and corrupt active cloud credentials.
- [ ] Make TOTP enabled+missing/decrypt-failed block login/readiness; remove `verifyTOTP` fail-open.
- [ ] Make storage initialization fail closed for configured cloud provider.
- [ ] Start listening only after initialization state is known; add readiness and graceful SIGTERM shutdown.
- [ ] Add backend/frontend Compose healthchecks, dependency ordering, stop grace periods, and Docker log rotation.
- [ ] Run typecheck/tests and health transition smoke tests.

### Task 4: Storage account deletion and OAuth flow binding

**Files:**
- Create: `backend/src/services/oauthFlowStore.ts`
- Modify: `backend/src/routes/storage.ts`
- Modify: `backend/src/services/storage.ts`
- Modify: `frontend/src/components/pages/SettingsPage.tsx`
- Modify: `frontend/src/services/api.ts`
- Test: `backend/src/services/oauthFlowStore.test.ts`
- Test: `backend/src/services/storageAccountDeletion.test.ts`

**Interfaces:**
- OAuth pending flow is a one-time DB row keyed by random state and bound to provider, auth session hash, immutable redirect URI/config, expiry.
- account delete transaction locks account, rechecks active/task/upload references, deletes indexes/account atomically, and evicts the exact provider key.

- [ ] Write RED tests for concurrent OAuth tabs, wrong session, replay/expiry, redirect override, delete-vs-switch/job-create, rollback, provider eviction.
- [ ] Replace global OAuth settings slots with per-flow records and exact callback URI.
- [ ] Restrict popup postMessage to configured frontend origin; verify origin, source and flow nonce in the frontend.
- [ ] Fix account SELECT to include type; lock/recheck/delete transactionally and evict exact provider.
- [ ] Run focused tests and typechecks.

### Task 5: Durable bounded chunk uploads and frontend upload queue

**Files:**
- Create: `backend/src/services/chunkUploadSessions.ts`
- Modify: `backend/src/db/schema.sql`
- Modify: `backend/src/db/index.ts`
- Modify: `backend/src/routes/chunkedUpload.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/ui/UploadQueueModal.tsx`
- Test: `backend/src/services/chunkUploadSessions.test.ts`

**Interfaces:**
- persisted session statuses: `open|completing|completed|cancelled|failed` with owner, target, expected bytes/chunks, received bytes, expiry, completion lease.
- each chunk uses idempotent index+size/hash metadata; complete performs one CAS.
- server enforces per-file and global temporary byte budgets/disk watermark.
- frontend queue is bounded and exposes cancel/retry with typed status.

- [ ] Write RED tests for quota, duplicate chunk, truncated write, two complete requests, cancel-vs-complete, restart/status resume.
- [ ] Persist session metadata and completion lease; wait for write stream finish before recording chunk.
- [ ] Enforce max total size, global temporary bytes, disk reserve, chunk expected size/hash.
- [ ] Keep chunks until permanent write+index succeeds; recover/expire sessions deterministically.
- [ ] Lower simple-upload threshold below the production proxy limit or route all practical files through chunks.
- [ ] Add bounded frontend workers, AbortController/XHR handles, retry, partial summary, queue generation-safe clearing.
- [ ] Run focused tests, proxy-size boundary smoke, lint/typecheck.

### Task 6: Global file query semantics and frontend request races

**Files:**
- Modify: `backend/src/routes/files.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/App.tsx`
- Test: `backend/src/services/fileQuery.test.ts`

**Interfaces:**
- query accepts `q,type,folder,favorite,sort,direction,cursor` and returns deterministic keyset pages.
- folder aggregation endpoint returns global count/size/latest/cover/favorite.
- frontend requests carry AbortSignal/generation and only latest generation may commit.

- [ ] Write RED tests with 201+ records and out-of-order deferred responses.
- [ ] Add validated server-side search/filter/sort and matching indexes.
- [ ] Add folder aggregation endpoint.
- [ ] Add AbortController/request generation and explicit initial-error/stale-error/empty states.
- [ ] Ensure preview navigation and counts use global query semantics or clearly bounded loaded-state copy.
- [ ] Run backend tests, frontend lint/typecheck.

### Task 7: Operational truth, documentation, observability and verification

**Files:**
- Modify: `deploy/DEPLOY.md`
- Modify: `deploy/install.sh`
- Modify: `README.md`
- Modify: `docker-compose.yml`
- Create: `deploy/backup.sh`
- Create: `deploy/restore-verify.sh`

- [ ] Remove nonexistent Compose nginx/certbot instructions or explicitly implement the selected host-Nginx model.
- [ ] Document exact project-directory update commands and separate optional verification commands.
- [ ] Add coordinated encrypted/off-host-capable DB + `/data` backup manifest and isolated restore verification instructions.
- [ ] Add request/operation IDs, redaction, structured destructive/storage events and bounded container logs.
- [ ] Run shell syntax checks, Compose config, lint/typecheck/tests.
- [ ] Build frontend/backend locally.
- [ ] Independent reviewer checks the complete diff and security scan.
- [ ] Rebuild/recreate Docker services.
- [ ] Verify `/livez`, `/readyz`, protected 401/428, CORS, browser console, served frontend asset parity.
- [ ] Run read-only PostgreSQL invariants: terminal unfinished, stale leases, missing snapshots, duplicate task identity, failed reconciliation, orphan rows.
- [ ] Confirm no commit and no push occurred.
