# AgentWorkbench M5 Reliability Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Add replayable approval gates, bounded retries, Orchestrator watchdog timeouts, process-tree termination hooks, lifecycle metrics, and prompt privacy to the M4 AgentWorkbench runtime.

**Architecture:** Keep EventBus as the only persisted source of truth. High-risk approval is a Task-level state transition; each retry is a new immutable Attempt Run linked by `retryOf`; the Orchestrator owns watchdog and retry scheduling while adapters expose optional `terminate()`. Metrics are append-only `kind: "metric"` events aggregated from the bus, never a second database.

**Tech Stack:** Node.js >=22 ESM, built-in `node:test`, `node:crypto`, `node:child_process`, zero runtime dependencies, loopback HTTP server.

**Spec:** `docs/superpowers/specs/2026-09-02-workbench-m5-reliability-controls-design.md`

## Global Constraints

- Preserve append-only EventBus JSONL, contiguous `seq`, sanitizer, and replay semantics.
- Preserve M4 copied sandbox, snapshot, diff, apply, rollback, SSE, and maker-checker behavior.
- Do not add runtime dependencies.
- Use `retryBaseDelayMs = 250`, `retryMaxDelayMs = 10_000`, and `interruptGraceMs = 3_000` unless Task/Agent configuration overrides them.
- High-risk Tasks require an independent approval before a Run can start.
- `run.created` must store `promptLength` and `promptSha256`, never raw prompt text.
- Every implementation step must add or update a focused `node:test` test before changing production code.
- This workspace is not a Git repository; use verification checkpoints instead of commit steps.

---

### Task 1: Metric Event Primitive and Aggregation

**Files:**
- Create: `workbench/core/metrics.mjs`
- Modify: `workbench/core/audit.mjs: metrics compatibility wrapper`
- Test: `workbench/test/metrics.test.mjs`

**Interfaces:**
- Produces `metricPayload(name, value, meta = {})` returning a validated payload.
- Produces `appendMetric(bus, name, value, meta = {})` returning the EventBus append result with `kind: "metric"`.
- Produces `aggregateMetrics(events, { sinceMs = 0 } = {})` returning `{ counts, durations, retries, agents }`.

- [ ] **Step 1: Write failing metric tests**

Add tests that assert finite-number validation, deterministic payload fields, filtering by timestamp, duration average calculation, retry count aggregation, and per-Agent outcome counts. Include a test proving prompt text is not copied into a metric payload.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test test/metrics.test.mjs` from `D:\Agentplugin\workbench`.

Expected: FAIL because `../core/metrics.mjs` does not exist.

- [ ] **Step 3: Implement the metric primitive**

Implement `metricPayload()` with `Number.isFinite(value)` enforcement and only copy safe metadata keys (`runId`, `taskId`, `agentId`, `attempt`, `dimensions`). Implement `appendMetric()` through `bus.append('metric', payload, meta)` and `aggregateMetrics()` over already-read EventBus events.

- [ ] **Step 4: Run focused and regression tests**

Run: `node --test test/metrics.test.mjs test/bus.test.mjs`.

Expected: all selected tests pass and EventBus sequence remains contiguous.

### Task 2: Approval State and High-Risk Dispatch Gate

**Files:**
- Modify: `workbench/core/orchestrator.mjs: task creation, dispatch, replay`
- Modify: `workbench/server/http.mjs: /api/approval route`
- Modify: `workbench/awb.mjs: help, command switch, replay command set`
- Test: `workbench/test/approval.test.mjs`
- Test: `workbench/test/http-smoke.test.mjs`
- Test: `workbench/test/cli-smoke.test.mjs`

**Interfaces:**
- Produces `Orchestrator.submitApproval(taskId, decision, reviewerId, agentId, reason)` returning `{ ok, task, approval }` or a structured conflict result.
- Task metadata gains `approval: { status: "not_required" | "pending" | "approved" | "rejected", reviewerId, agentId, reason, decidedAt }`.
- HTTP body is `{ taskId, decision, reviewerId, agentId?, reason? }`.

- [ ] **Step 1: Write failing approval tests**

Cover: high-risk creation emits pending approval state; dispatch returns `{ ok:false, status:409, error:'approval_required' }` without a Run; independent approval permits dispatch; rejection blocks dispatch; duplicate decisions return `409`; self-approval for a bound Agent writes `approval.denied`; replay reconstructs the latest approval state.

- [ ] **Step 2: Run approval tests and verify failure**

Run: `node --test test/approval.test.mjs`.

Expected: FAIL because `submitApproval()` and the high-risk gate are absent.

- [ ] **Step 3: Implement approval events and gate**

Initialize approval metadata in `createTask()`, append `approval.granted` or `approval.denied` in `submitApproval()`, reject invalid transitions, and check the approval state at the beginning of `dispatch()`. If approval binds `agentId`, reject a different dispatch Agent. Fold approval events in `replay()`.

- [ ] **Step 4: Add HTTP and CLI adapters**

Implement `POST /api/approval` with 400/404/409 responses. Add `task:approve` and `task:reject` commands with `--task`, `--reviewer`, optional `--agent`, and optional `--reason`. Ensure `task:dispatch` remains a blocking command and prints the structured approval error.

- [ ] **Step 5: Run focused and existing boundary tests**

Run: `node --test test/approval.test.mjs test/http-smoke.test.mjs test/cli-smoke.test.mjs`.

Expected: all selected tests pass, and deferred bridge routes remain `501`.

### Task 3: Immutable Attempt Runs and Exponential Retry

**Files:**
- Modify: `workbench/core/orchestrator.mjs: dispatch, waitForRun, _executeRun, replay`
- Modify: `workbench/core/flags.mjs` only if a retry flag parser is required by the existing CLI conventions
- Test: `workbench/test/retry.test.mjs`
- Test: `workbench/test/replay.test.mjs`

**Interfaces:**
- Internal `_dispatchAttempt(taskId, agentId, prompt, { retryOf = null, retryCount = 0 })` returns a new Run.
- Run metadata gains `attempt`, `retryOf`, `retryCount`, `retryPolicy`, and `latestAttemptId` on the Task.
- `waitForRun(runId)` follows the attempt chain and resolves the authoritative final Run for the Task.

- [ ] **Step 1: Write a deterministic failing retry fixture test**

Create an adapter fixture that emits `run.failed` twice and `run.completed` on the third invocation. Assert three Run ids, `retryOf` links, two `run.retry.scheduled` events, retry counts `0/1/2`, one final reviewable Run, and a Task state of `awaiting-review`.

- [ ] **Step 2: Run retry tests and verify failure**

Run: `node --test test/retry.test.mjs`.

Expected: FAIL because failed Runs currently terminate the Task without retrying.

- [ ] **Step 3: Implement attempt creation and scheduling**

Extract Run creation into `_dispatchAttempt()`. On retryable terminal events, calculate `min(retryMaxDelayMs, retryBaseDelayMs * 2 ** retryCount)`, append `run.retry.scheduled`, wait the delay, then create and execute the linked Run. Keep prior Runs immutable and keep Task `running` until the final attempt.

- [ ] **Step 4: Implement terminal and replay rules**

Ensure `run.interrupted` never retries, retry exhaustion sets Task `failed` or `timeout`, and replay selects the latest attempt as authoritative while retaining all Runs. Make the initial active promise encompass its retry chain so existing CLI `task:dispatch` waits for the final attempt.

- [ ] **Step 5: Run retry and replay regression tests**

Run: `node --test test/retry.test.mjs test/replay.test.mjs test/orchestrator.test.mjs`.

Expected: all selected tests pass, including the existing M4 lifecycle assertions.

### Task 4: Orchestrator Watchdog and Adapter Termination Contract

**Files:**
- Modify: `workbench/core/orchestrator.mjs: _executeRun, interrupt, cleanup`
- Modify: `workbench/adapters/claude-stream-json.mjs: terminate`
- Modify: `workbench/adapters/codex-app-server.mjs: terminate`
- Modify: `workbench/adapters/cli-text.mjs: terminate`
- Modify: `workbench/adapters/acp.mjs: terminate`
- Test: `workbench/test/watchdog.test.mjs`
- Test: `workbench/test/adapter-termination.test.mjs`

**Interfaces:**
- Optional adapter method: `terminate({ runId, taskId, agentId, reason }) -> Promise<{ ok: boolean, termination: string }>`.
- Orchestrator watchdog uses `adapter.interrupt(context)` followed by `adapter.terminate(context)` after `interruptGraceMs`.

- [ ] **Step 1: Write a hanging-adapter watchdog test**

Use an adapter whose iterator never completes and whose `interrupt()` intentionally does not close it. Assert `run.timeout.requested`, one `run.timeout`, one `run.terminated`, no duplicate terminal event, and completion within timeout plus grace tolerance.

- [ ] **Step 2: Run watchdog tests and verify failure**

Run: `node --test test/watchdog.test.mjs`.

Expected: FAIL because the Orchestrator currently relies on adapter-provided timeouts.

- [ ] **Step 3: Implement the watchdog and terminal guard**

Wrap iterator consumption in a watchdog that aborts the signal, invokes `interrupt`, waits the configured grace period, invokes optional `terminate`, and persists exactly one terminal event. Clear the timer before normal snapshot/diff finalization and ignore late adapter events after terminal state.

- [ ] **Step 4: Implement adapter termination hooks**

Expose active process/session handles by Run id in process-backed adapters. Implement `terminate()` with the existing `killProcessTree()` helper; return `termination: "process-tree"`. Keep Echo cooperative and return `termination: "cooperative"`.

- [ ] **Step 5: Run watchdog, adapter, and full orchestration tests**

Run: `node --test test/watchdog.test.mjs test/adapter-termination.test.mjs test/claude-adapter.test.mjs test/codex-adapter.test.mjs test/orchestrator.test.mjs`.

Expected: all selected tests pass with exactly one terminal event per Attempt.

### Task 5: Prompt Privacy and Run Metadata Compatibility

**Files:**
- Modify: `workbench/core/orchestrator.mjs: run.created payload, retry metadata, replay`
- Test: `workbench/test/privacy.test.mjs`
- Modify: `workbench/test/cli-smoke.test.mjs` if output assertions include raw prompts
- Modify: `workbench/docs/SPEC.md` and `workbench/docs/ARCHITECTURE.md`

**Interfaces:**
- Run metadata contains `promptLength` and `promptSha256`; raw `prompt` is retained only in transient memory for adapter invocation.
- Replay accepts legacy `run.created` events containing `prompt` but does not emit the raw value in newly persisted events.

- [ ] **Step 1: Write failing privacy tests**

Dispatch a prompt containing a unique secret marker and assert the persisted `run.created` payload has no `prompt` field, has the expected length/hash, and that replay still exposes a valid Run. Verify metric payloads also contain no prompt.

- [ ] **Step 2: Run privacy tests and verify failure**

Run: `node --test test/privacy.test.mjs`.

Expected: FAIL because `run.created` currently persists the raw prompt.

- [ ] **Step 3: Implement hashed Run creation**

Use SHA-256 over the exact prompt string, store length/hash in persisted Run metadata, and keep the prompt only on the in-memory Run/dispatch call path. Preserve EventBus sanitizer behavior for all other fields.

- [ ] **Step 4: Run privacy and replay tests**

Run: `node --test test/privacy.test.mjs test/replay.test.mjs test/bus.test.mjs`.

Expected: all selected tests pass and legacy replay fixtures remain readable.

### Task 6: Lifecycle Metrics, HTTP Metrics, and CLI Metrics

**Files:**
- Modify: `workbench/core/orchestrator.mjs: lifecycle metric calls`
- Modify: `workbench/core/audit.mjs: metrics aggregation export`
- Modify: `workbench/server/http.mjs: /api/metrics`
- Modify: `workbench/awb.mjs: metrics command`
- Test: `workbench/test/metrics-integration.test.mjs`
- Test: `workbench/test/http-smoke.test.mjs`
- Test: `workbench/test/cli-smoke.test.mjs`

**Interfaces:**
- `GET /api/metrics?windowMs=<positive integer>` returns `{ ok: true, windowMs, metrics }`.
- `node awb.mjs metrics [windowMs]` prints the same aggregate JSON.

- [ ] **Step 1: Write failing integration tests**

Run an Echo success, a retry fixture, and a timeout fixture. Assert metric events for started/completed/failed/timeout/retry/duration and deterministic aggregate counts, duration totals/averages, retries, and Agent outcomes.

- [ ] **Step 2: Run integration tests and verify failure**

Run: `node --test test/metrics-integration.test.mjs`.

Expected: FAIL because Orchestrator emits no lifecycle metric events and routes are absent.

- [ ] **Step 3: Add metric emission at lifecycle boundaries**

Call `appendMetric()` for start, terminal outcome, retry scheduling, duration, and finite cost. Keep metric failures non-fatal to the Run while recording a system warning only in memory.

- [ ] **Step 4: Wire audit, HTTP, and CLI aggregation**

Have `audit.mjs` read the existing bus and call `aggregateMetrics()`. Add positive-integer `windowMs` validation to HTTP and CLI. Return 400 for invalid windows and preserve existing `/api/audit` behavior.

- [ ] **Step 5: Run metrics, HTTP, CLI, and full tests**

Run: `node --test test/metrics-integration.test.mjs test/http-smoke.test.mjs test/cli-smoke.test.mjs`.

Expected: all selected tests pass and metric events do not alter replayed Task/Run state.

### Task 7: Documentation and Full Verification

**Files:**
- Modify: `workbench/docs/SPEC.md`
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `workbench/docs/decisions/ADR-003-acceptance-rollback.md`
- Modify: `README.md`
- Test: all `workbench/test/*.mjs`

- [ ] **Step 1: Update shipped contracts**

Document M5 approval, retry, watchdog, metrics, and prompt privacy behavior. Keep Git worktrees, Planner/DAG, human bridge completion, Tauri, and remote execution explicitly deferred.

- [ ] **Step 2: Scan the documents for stale M4/M5 claims**

Run: `rg -n "M2|M4|M5|deferred|not_implemented|prompt|retry|approval|metrics" README.md workbench/docs docs/superpowers/specs/2026-09-02-workbench-m5-reliability-controls-design.md`.

Expected: no statement claims M5 features are deferred or claims Planner/DAG is already implemented.

- [ ] **Step 3: Run the complete test suite**

Run: `node --test` from `D:\Agentplugin\workbench`.

Expected: zero failures, with all M4 regression tests still present.

- [ ] **Step 4: Run syntax verification**

Run: `Get-ChildItem -Path . -Recurse -Filter *.mjs -File | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }` from `D:\Agentplugin\workbench`.

Expected: exit code 0 and no syntax errors.

- [ ] **Step 5: Perform the acceptance checklist**

Verify each spec criterion manually from test output: approval gate, three-attempt retry chain, watchdog terminal uniqueness, child-process cleanup, metrics CLI/API, prompt privacy, and all M4 sandbox/diff/apply/rollback behavior.
