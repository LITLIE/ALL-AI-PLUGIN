# AgentWorkbench Sandbox, Diff, Apply and Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate each Run in a local copy, expose deterministic diffs, and support verified apply/rollback through the existing event-sourced runtime.

**Architecture:** `core/sandbox.mjs` owns path-safe copying and snapshots; `core/diff.mjs` owns text/binary diff generation; `Orchestrator` creates a Run workspace, executes adapters there, persists change metadata, and gates apply/rollback on verdict and conflict checks. HTTP routes delegate to the Orchestrator and never mutate state independently.

**Tech Stack:** Node.js 22 ESM, built-in `node:fs/promises`, `node:crypto`, `node:test`, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-workbench-sandbox-diff-design.md`

## Global Constraints

- `task.cwd` remains the target; adapters execute under `runWorkDir(runId)/workspace`.
- All scope paths must remain inside the target/workspace root.
- Default excludes are `.git`, `node_modules`, `dist`, and the configured store when nested.
- Apply requires a completed Run and a `passed` verdict; failed, timeout, interrupted, and unreviewed Runs cannot apply.
- Target changes made after the before snapshot cause an apply conflict with no partial writes.
- EventBus remains append-only; apply and rollback append events and never rewrite history.
- No Git dependency, worktree implementation, approval workflow, parallel scheduling, or Planner/DAG in this plan.

---

### Task 1: Implement Path-Safe Sandbox Copy and Snapshots

**Files:**
- Create: `workbench/core/sandbox.mjs`
- Modify: `workbench/core/paths.mjs`
- Test: `workbench/test/sandbox.test.mjs`

**Interfaces:**
- `createSandbox({ runId, targetCwd, storeRoot, scope })` -> `{ workspace, targetCwd, scope }` and copies allowed files.
- `snapshotTree(root, { scope, backupDir })` -> `{ root, ts, files }`, storing `{ relPath, size, sha256 }` plus backups when `backupDir` is supplied.
- `restoreSnapshot(snapshot, backupDir, root)` restores original files and removes files absent from the snapshot.
- `assertContained(root, candidate)` throws `path_outside_scope` when a resolved path escapes root.

- [ ] **Step 1: Write failing tests** for copying nested files, default excludes, explicit include/exclude, path traversal rejection, snapshot hashes/content backups, and restore removing added files.
- [ ] **Step 2: Run** `node --test test\sandbox.test.mjs` and confirm the module is missing.
- [ ] **Step 3: Implement** recursive copy with `readdir`/`lstat`, path containment checks, deterministic relative paths, SHA-256 file reads, and backup writes.
- [ ] **Step 4: Run** the focused sandbox tests and syntax-check the new module.

### Task 2: Implement Unified Diff and Change Classification

**Files:**
- Create: `workbench/core/diff.mjs`
- Test: `workbench/test/diff.test.mjs`

**Interfaces:**
- `classifyChanges(before, after)` -> `{ added, modified, deleted }` using relative paths.
- `buildUnifiedDiff(beforeText, afterText, relPath)` -> string with file headers and line additions/deletions.
- `buildDiff(beforeSnapshot, afterSnapshot, beforeBackupDir, afterRoot)` -> serializable diff items, marking binary files.

- [ ] **Step 1: Write failing tests** for added/modified/deleted files, empty changes, line-level text diff, newline handling, and binary metadata-only changes.
- [ ] **Step 2: Run** `node --test test\diff.test.mjs` and verify the expected missing-module failure.
- [ ] **Step 3: Implement** deterministic maps by `relPath`, UTF-8 text detection, a small LCS line diff, and binary fallback.
- [ ] **Step 4: Run** focused diff tests and syntax-check.

### Task 3: Integrate Sandbox Lifecycle Into Orchestrator

**Files:**
- Modify: `workbench/core/orchestrator.mjs`
- Modify: `workbench/test/orchestrator.test.mjs`
- Modify: `workbench/test/replay.test.mjs`

**Interfaces:**
- Run fields: `targetCwd`, `executionCwd`, `scope`, `snapshotBefore`, `snapshotAfter`, `diff`, `appliedAt`, `rolledBackAt`.
- `_executeRun` creates sandbox before adapter invocation and passes `executionCwd` as adapter `cwd`.
- `apply(runId)` and `rollback(runId)` return `{ ok, status, ... }` and append run events on successful mutation or conflict.

- [ ] **Step 1: Write failing integration tests** proving the adapter sees a workspace path, target remains unchanged before apply, and after completion the Run has a diff.
- [ ] **Step 2: Run** focused orchestrator tests and capture failures.
- [ ] **Step 3: Implement** sandbox creation before `adapter.run`, before/after snapshots around execution, and diff persistence while preserving terminal state.
- [ ] **Step 4: Add failing tests** for apply gating, target conflict, successful apply, rollback restoration, and idempotent repeated calls.
- [ ] **Step 5: Implement** apply/rollback with snapshot backups, containment checks, conflict verification, and append-only events.
- [ ] **Step 6: Run** orchestrator and replay tests together.

### Task 4: Expose HTTP Diff, Apply and Rollback Routes

**Files:**
- Modify: `workbench/server/http.mjs`
- Modify: `workbench/test/http-smoke.test.mjs`

- [ ] **Step 1: Add failing HTTP tests** for `GET /api/runs/:id/diff`, rejected apply before passed verdict, successful apply, and rollback.
- [ ] **Step 2: Run** the focused HTTP test and confirm current `501` responses fail.
- [ ] **Step 3: Route** requests to `orchestrator.apply`, `orchestrator.rollback`, and return `run.diff` for existing Runs; preserve JSON errors and loopback/origin checks.
- [ ] **Step 4: Run** HTTP smoke/security tests.

### Task 5: Documentation and Full Verification

**Files:**
- Modify: `workbench/docs/SPEC.md`
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `workbench/docs/decisions/ADR-003-acceptance-rollback.md`
- Modify: `D:\Agentplugin\README.md`

- [ ] **Step 1: Document** sandbox execution, diff fields, apply prerequisites, conflict semantics, and rollback events; remove M4 items from deferred lists while keeping Git worktrees and approvals deferred.
- [ ] **Step 2: Run** `node --test` and syntax-check every `.mjs` file under `workbench`.
- [ ] **Step 3: Verify** `node awb.mjs agents:list`, `node awb.mjs agents:probe`, and a no-network Echo smoke run still work.
