# TG Vault First-Round Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复第一轮审查确认的 Telegram 持久任务结算、订阅恢复、存储切换、并发同名上传、API Key、首次初始化及测试执行可靠性问题。

**Architecture:** 将外部存储写入、数据库索引和 Telegram 子项结算视为一个可验证协议；为每次上传固化存储目标；用数据库原子操作处理初始化和名称分配；通过独立 API Key 挂载及权限中间件恢复外部 API。每项修复都先加入会失败的回归测试，再做最小实现。

**Tech Stack:** Node.js 20、TypeScript、Express、PostgreSQL 16、GramJS、node:test/tsx、Docker Compose。

## Global Constraints

- 不覆盖当前工作树已有未提交改动。
- 不推送 GitHub。
- 每个行为修复先验证 RED，再实现 GREEN。
- 完成后运行全部后端测试、TypeScript、构建、Docker 重建和线上健康/数据库不变量验证。
- 生产部署保留现有数据卷、密钥和 Telegram session。

---

### Task 1: Persistent child settlement protocol

**Files:**
- Modify: `backend/src/services/telegramChannelJobs.ts`
- Test: `backend/src/services/telegramPersistentSettlementRef.test.ts`

**Interfaces:**
- Produce settlement result with affected row count.
- Successful settlement must remain valid when a user pause races after the child was claimed.
- Unsettled rows must not be restored to pending after an external side effect was successfully materialized.

- [ ] Add a failing regression test for pause-after-save settlement.
- [ ] Run the focused test and confirm expected failure.
- [ ] Implement affected-row validation and settlement semantics.
- [ ] Run focused test to green.

### Task 2: Subscription protection parity

**Files:**
- Modify: `backend/src/services/telegramChannelJobs.ts`
- Test: `backend/src/services/telegramStorageCooldownRetry.test.ts`

**Interfaces:**
- Subscription jobs consume the same claim/download/cooling/restoration path as date/tag jobs.
- FloodWait and storage quota restore unfinished claims to pending without increasing attempts.

- [ ] Add a failing test proving the subscription path uses the common protected downloader.
- [ ] Run RED.
- [ ] Replace direct bulk execution with common protected claim execution.
- [ ] Run GREEN.

### Task 3: Immutable storage target snapshot

**Files:**
- Modify: `backend/src/services/storage.ts`
- Modify: `backend/src/routes/upload.ts`
- Modify: `backend/src/routes/chunkedUpload.ts`
- Modify: `backend/src/services/telegramUpload.ts`
- Modify: `backend/src/services/downloadTaskQueue.ts`
- Test: new or existing focused storage race test.

**Interfaces:**
- Produce immutable `{ provider, accountId, generation }` per upload/task.
- Provider and DB `storage_account_id` must come from the same snapshot.

- [ ] Write a failing switch-vs-upload snapshot test.
- [ ] Run RED.
- [ ] Add snapshot API and pass it through Web, chunked and Telegram upload paths.
- [ ] Run GREEN.

### Task 4: Concurrent unique object identity

**Files:**
- Modify: `backend/src/utils/fileUtils.ts`
- Modify schema only if required.
- Test: focused concurrent name allocation test.

**Interfaces:**
- Concurrent uploads with the same display name must receive distinct object keys.

- [ ] Add failing concurrent allocation test.
- [ ] Run RED.
- [ ] Implement atomic/UUID-backed stored object names while preserving display names and duplicate policy.
- [ ] Run GREEN.

### Task 5: API Key-only upload

**Files:**
- Modify: `backend/src/index.ts`
- Modify: `backend/src/routes/upload.ts`
- Modify: `backend/src/middleware/apiKey.ts`
- Test: new HTTP/router-level test.

**Interfaces:**
- `POST /api/v1/upload` accepts API Key without Web cookie.
- API Key must include `upload`; successful use updates `last_used_at`.

- [ ] Add failing router/permission tests.
- [ ] Run RED.
- [ ] Split Web and API mounts and enforce permission.
- [ ] Run GREEN.

### Task 6: Atomic initial setup

**Files:**
- Modify: `backend/src/utils/authSettings.ts`
- Modify: `backend/src/routes/auth.ts`
- Test: new PostgreSQL-backed or repository-level concurrency test.

**Interfaces:**
- Web password and Telegram PIN are created atomically.
- Exactly one concurrent setup succeeds.

- [ ] Add failing concurrent setup test.
- [ ] Run RED.
- [ ] Implement transaction/advisory lock and atomic credential writes.
- [ ] Run GREEN.

### Task 7: Async test completion

**Files:**
- Modify: `backend/src/services/downloadTaskQueue.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Standalone queue test must print its completion marker and fail on unresolved flow/timeout.
- Canonical `npm test` and `npm run typecheck` commands exist.

- [ ] Convert entry to top-level await and add timeout protection where necessary.
- [ ] Verify completion marker.

### Task 8: Full verification and deployment

**Files:**
- Generated: `backend/dist/index.js`

- [ ] Run focused tests.
- [ ] Run all tests.
- [ ] Run typecheck and build.
- [ ] Run `git diff --check` and dependency audit.
- [ ] Build backend Docker image.
- [ ] Recreate backend container.
- [ ] Verify health, auth/API behavior, PostgreSQL invariants, container logs and Bot startup.
