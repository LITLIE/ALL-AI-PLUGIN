# Workbench M7-A Human Bridge and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a replay-safe Human Bridge workflow and a usable task/review UI on top of the existing local Inline Execution workbench.

**Architecture:** Extend the existing orchestrator state machine and EventBus with an explicit `awaiting-human` pause point. The Human Bridge adapter emits a briefing and stops; a dedicated submit API validates and resumes the Run with an untrusted completion event. The zero-dependency SPA consumes task snapshots and SSE events, rendering bridge, review, diff, approval, and audit controls without changing server-side safety gates.

**Tech Stack:** Node.js ESM, built-in `node:http`, append-only JSONL EventBus, browser-native ES modules, CSS custom properties, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-03-workbench-m7a-human-bridge-ui-design.md`

## Global Constraints

- Keep Inline Execution as the only execution mode in this slice.
- Add no runtime or browser dependencies.
- Preserve sandbox, snapshot/diff/apply/rollback, approval, retry, watchdog, metrics, Planner/DAG, replay, and SSE contracts.
- Newly introduced metadata must not persist raw prompts; Human Bridge receipts are retained only as explicitly untrusted Agent output.
- Use `apply_patch` for edits and TDD for every production behavior change.
- This workspace is not a Git repository; do not add commit, merge, or push steps to the implementation workflow.

---

### Task 1: Define the Human Bridge state and event contract

**Files:**
- Modify: `workbench/core/orchestrator.mjs`
- Modify: `workbench/adapters/human-bridge.mjs`
- Test: `workbench/test/human-bridge.test.mjs`

**Interfaces:**
- `TASK_STATES.AWAITING_HUMAN` is the canonical string `awaiting-human`.
- `Orchestrator.submitBridgeReceipt(runId, receiptText)` returns `{ ok: true, run }` on success and throws structured errors with `code` values `run_not_found`, `bridge_not_supported`, `bridge_not_waiting`, `bridge_already_submitted`, or `invalid_receipt`.
- Human Bridge Run fields include `briefing`, `bridgeRequestedAt`, `bridgeSubmittedAt`, `untrusted`, and `via` when applicable.

- [ ] **Step 1: Write the failing tests**

Add tests that install the existing adapter fixture, dispatch a `human-bridge` task, assert the Run and Task enter `awaiting-human`, assert a briefing is retained, submit a non-empty receipt, assert exactly one untrusted completion and one `bridge.submitted` event, and assert a second submission is rejected without another completion event.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test workbench/test/human-bridge.test.mjs`

Expected: FAIL because `awaiting-human` and `submitBridgeReceipt` do not yet exist and the current stream ending is treated as failure.

- [ ] **Step 3: Implement the minimal state transition**

Add `AWAITING_HUMAN` to `TASK_STATES`, update `_applyRunEvent()` to retain briefing and keep the Run open when `run.awaiting-human` is received, and make `_executeRun()` accept a stream ending in `awaiting-human` without calling `_failRun()`.

- [ ] **Step 4: Implement receipt submission**

Add `submitBridgeReceipt()` to validate the Run's agent type/identity, require a non-empty string, reject duplicate or non-waiting submissions, append `bridge.submitted`, append one `run.completed` with `meta: { untrusted: true, via: 'human-bridge' }`, update Run/Task state, and return the updated Run.

- [ ] **Step 5: Run focused and regression tests**

Run: `node --test workbench/test/human-bridge.test.mjs workbench/test/orchestrator.test.mjs`

Expected: PASS with no changes to existing non-bridge lifecycle assertions.

### Task 2: Make Human Bridge replay-safe

**Files:**
- Modify: `workbench/core/orchestrator.mjs`
- Test: `workbench/test/human-bridge-replay.test.mjs`

**Interfaces:**
- `Orchestrator.replay()` restores waiting bridge Runs from `run.awaiting-human`, `run.briefing-ready`, and `bridge.requested` events.
- Replay restores submitted receipts from `bridge.submitted` and the corresponding `run.completed` event without duplicating events.

- [ ] **Step 1: Write the failing replay tests**

Create an isolated EventBus, append a task plus waiting bridge events, replay into a fresh Orchestrator, and assert `run.state === 'awaiting-human'`, `task.state === 'awaiting-human'`, and the briefing is present. Add a submitted sequence and assert the fresh Orchestrator restores `completed`, `awaiting-review`, `untrusted`, and `via`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test workbench/test/human-bridge-replay.test.mjs`

Expected: FAIL because replay currently handles only the pre-M7 terminal events.

- [ ] **Step 3: Extend replay minimally**

Handle bridge event payloads and `run.awaiting-human` in the existing event loop. Preserve legacy events and ignore malformed unsupported bridge payloads without inventing a terminal completion.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test workbench/test/human-bridge-replay.test.mjs workbench/test/replay.test.mjs`

Expected: PASS.

### Task 3: Add the bridge submission HTTP route

**Files:**
- Modify: `workbench/server/http.mjs`
- Test: `workbench/test/http-human-bridge.test.mjs`

**Interfaces:**
- `POST /api/bridges/:runId/submit` accepts `{ "receiptText": "..." }`.
- Success returns HTTP `200` and the updated Run snapshot.
- Invalid receipt returns `400 invalid_receipt`; unknown Run returns `404 run_not_found`; wrong state or duplicate returns `409` with the orchestrator error code.

- [ ] **Step 1: Write the failing HTTP tests**

Start the existing loopback server with a fixture Human Bridge Agent. Exercise success, blank receipt, unknown Run, non-bridge Run, and duplicate submission. Assert response codes, JSON error codes, event counts, and same-origin/host protections.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test workbench/test/http-human-bridge.test.mjs`

Expected: FAIL with the current `501 not_implemented` route.

- [ ] **Step 3: Implement the route**

Replace the placeholder route with strict Run ID extraction, JSON body parsing through the existing helper, `receiptText` validation delegated to `submitBridgeReceipt()`, and status mapping from structured errors.

- [ ] **Step 4: Run focused and HTTP regression tests**

Run: `node --test workbench/test/http-human-bridge.test.mjs workbench/test/http-smoke.test.mjs`

Expected: PASS.

### Task 4: Refine browser state and SSE projection

**Files:**
- Modify: `workbench/ui/app.mjs`
- Modify: `workbench/ui/icons.mjs`
- Modify: `workbench/ui/tokens.css`
- Test: `workbench/test/ui-human-bridge.test.mjs`

**Interfaces:**
- UI state continues to use the existing `S` singleton and render loop.
- New helper functions must remain browser-safe and exported only if the test needs direct inspection.
- SSE events update task/run state by sequence and never insert duplicate events.

- [ ] **Step 1: Write failing browser-safety and projection tests**

Read the served UI modules as source and assert they contain no Node imports/process references. Add a fixture projection test that feeds `task.ready`, `run.awaiting-human`, `bridge.requested`, `bridge.submitted`, and `run.completed` events and verifies the selected task/run state and briefing are reflected in rendered HTML.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test workbench/test/ui-human-bridge.test.mjs`

Expected: FAIL because the current UI has no Human Bridge projection/panel and no explicit `awaiting-human` state styling.

- [ ] **Step 3: Implement the minimal UI projection**

Add state normalization for `awaiting-human`, event application for bridge events, a board column/status label, and a selected-run panel that shows the briefing, copy action, receipt textarea, submit action, loading state, and error state. Use existing icon/token conventions and keep all user-provided text escaped through the current rendering helpers.

- [ ] **Step 4: Add adjacent review controls**

Expose existing diff, apply, rollback, approval, verdict, and interrupt actions from the selected task/run view, with buttons disabled when the server-side lifecycle state does not permit the action. Do not duplicate server policy in a way that changes behavior.

- [ ] **Step 5: Run focused UI and full browser-safe tests**

Run: `node --test workbench/test/ui-human-bridge.test.mjs workbench/test/http-smoke.test.mjs`

Expected: PASS.

### Task 5: Add end-to-end SSE reconnect and documentation coverage

**Files:**
- Modify: `workbench/ui/app.mjs`
- Modify: `workbench/server/sse.mjs`
- Modify: `workbench/docs/SPEC.md`
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `README.md`
- Test: `workbench/test/http-human-bridge.test.mjs`

**Interfaces:**
- Browser reconnect uses the last received `seq` as the `since` cursor.
- Server replay remains exclusive of already-consumed sequence numbers.
- Documentation examples use `cd workbench` and the actual `node awb.mjs` entry point.

- [ ] **Step 1: Write the failing reconnect/documentation assertions**

Extend the HTTP test to disconnect/reconnect after a bridge request and assert only events with `seq > since` arrive. Add a documentation contract test that checks the bridge endpoint, `awaiting-human` state, and CLI/server commands are present.

- [ ] **Step 2: Run focused tests to verify the new assertions fail**

Run: `node --test workbench/test/http-human-bridge.test.mjs workbench/test/docs-contract.test.mjs`

Expected: FAIL for missing UI reconnect behavior or missing M7-A documentation entries.

- [ ] **Step 3: Implement reconnect and docs**

Use the existing SSE handler contract and sequence de-duplication, then document the new route, state transition, UI behavior, and the deferred M7-B work.

- [ ] **Step 4: Run the complete verification suite**

Run: `node --test`

Expected: 100 existing tests plus the new M7-A tests pass with zero failures.

- [ ] **Step 5: Run syntax verification**

Run: `$files = Get-ChildItem -Recurse -Filter *.mjs | Where-Object { $_.FullName -notmatch '\\node_modules\\' }; $failed = @(); foreach ($f in $files) { node --check $f.FullName 2>$null; if ($LASTEXITCODE -ne 0) { $failed += $f.FullName } }; "checked=$($files.Count) failed=$($failed.Count)"; $failed`

Expected: `failed=0`.

