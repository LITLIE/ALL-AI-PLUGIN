# Workbench M7-B Probe and ACP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent availability truthful and configuration-driven for all process-backed adapters, especially ACP, without changing the shipped orchestration lifecycle.

**Architecture:** Add one shared local probe helper under `workbench/core` that executes normalized health-check commands through `spawnPlan`, bounds output and duration, and returns a stable result. Adapters delegate probing and process startup to Agent configuration; the registry treats unknown/unavailable Agents as unroutable. ACP and generic CLI behavior are verified with local fixtures.

**Tech Stack:** Node.js ESM, built-in `node:child_process`, `node:test`, existing `spawnPlan`, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-workbench-m7b-probe-acp-design.md`

## Global Constraints

- Every adapter exposes `probe(agentConfig)` and returns structured availability metadata.
- Built-in `echo` and `human-bridge` adapters return `available` without spawning a process.
- Process-backed adapters execute configured `healthCheck` command, arguments, environment, and cwd through `spawnPlan`.
- Unknown probe status is never treated as available for dispatch.
- No adapter may silently replace a configured command with a hard-coded vendor executable.
- Add no runtime dependencies or network calls.
- Preserve sandbox, approval, retry, watchdog, metrics, Planner/DAG, Human Bridge, UI, replay, and SSE behavior.
- Use TDD and `apply_patch`; this workspace is not a Git repository, so no commit/push steps are included.

---

### Task 1: Implement the shared probe helper

**Files:**
- Create: `workbench/core/probe.mjs`
- Test: `workbench/test/probe.test.mjs`

**Interfaces:**
- `probeCommand(agentConfig, options = {})` returns `Promise<{ ok, status, resolved, version, code, error, checkedAt }>`.
- It reads `agentConfig.healthCheck`, falls back to `agentConfig.command` plus `['--version']`, uses `agentConfig.env` and `agentConfig.cwd`, and defaults to a 4-second timeout.

- [ ] **Step 1: Write failing tests**

Cover a successful Node command, non-zero exit, missing command, timeout, expectation mismatch, expectation match, bounded output, and a Windows shim plan using the existing `spawnPlan` contract.

- [ ] **Step 2: Run focused tests**

Run: `node --test workbench/test/probe.test.mjs`

Expected: FAIL because `workbench/core/probe.mjs` does not exist.

- [ ] **Step 3: Implement minimal helper**

Resolve the command with `spawnPlan`, spawn with `shell: false` and inherited plus configured environment, collect bounded stdout/stderr, resolve exactly once on close/error/timeout, terminate the probe child on timeout, and apply `healthCheck.expect` to combined output.

- [ ] **Step 4: Verify focused tests**

Run: `node --test workbench/test/probe.test.mjs`

Expected: PASS.

### Task 2: Normalize built-in and process-backed adapter probes

**Files:**
- Modify: `workbench/adapters/echo.mjs`
- Modify: `workbench/adapters/human-bridge.mjs`
- Modify: `workbench/adapters/claude-stream-json.mjs`
- Modify: `workbench/adapters/codex-app-server.mjs`
- Modify: `workbench/adapters/cli-text.mjs`
- Test: `workbench/test/adapter-probe-contract.test.mjs`

**Interfaces:**
- Built-ins return `{ ok: true, status: 'available', resolved: null, version, code: 0, error: null, checkedAt }`.
- Process-backed adapters delegate to `probeCommand(agentConfig)`.
- `cli-text.run()` uses `agentConfig.command`, `agentConfig.args`, `agentConfig.env`, and `agentConfig.cwd`.
- `acp.run()` uses the same configured command/args/env/cwd and emits `run.failed` on startup or handshake failure.

- [ ] **Step 1: Write failing adapter contract tests**

Use `process.execPath` fixtures to assert each process-backed adapter probes a configured command. Add an ACP fixture that writes a minimal failure/response and assert no hard-coded `claude-code-acp` spawn occurs. Add a generic CLI fixture and assert its configured command is used.

- [ ] **Step 2: Run focused tests**

Run: `node --test workbench/test/adapter-probe-contract.test.mjs`

Expected: FAIL because ACP and CLI currently hard-code commands and probe responses are inconsistent.

- [ ] **Step 3: Implement adapter delegation**

Import `probeCommand` into process-backed adapters, pass the full Agent config, replace hard-coded executable selection in ACP/CLI startup with `spawnPlan(agentConfig.command, configuredArgs)`, and preserve existing normalized terminal events.

- [ ] **Step 4: Verify focused and adapter regressions**

Run: `node --test workbench/test/adapter-probe-contract.test.mjs workbench/test/adapter-config.test.mjs workbench/test/adapter-termination.test.mjs`

Expected: PASS.

### Task 3: Make registry availability and routing truthful

**Files:**
- Modify: `workbench/core/registry.mjs`
- Test: `workbench/test/registry-probe-state.test.mjs`
- Modify: `workbench/test/registry.test.mjs`

**Interfaces:**
- `AgentRegistry.probe()` stores the normalized structured result and fills `status: 'unknown'` only when no probe has run.
- `listAll()` reports `available: false` for unknown, disabled, or failed Agents.
- `findByCapability()` only returns enabled Agents with `probe.ok === true`.

- [ ] **Step 1: Write failing registry state tests**

Assert a fresh registry reports unknown/unavailable, a successful probe becomes available, a failed probe is excluded, and `upsert()` resets the Agent to unknown until probed again. Assert invalid config files remain isolated.

- [ ] **Step 2: Run focused tests**

Run: `node --test workbench/test/registry-probe-state.test.mjs workbench/test/registry.test.mjs`

Expected: FAIL because current `listAll()` and `findByCapability()` treat an absent probe as available.

- [ ] **Step 3: Implement state handling**

Add a structured unknown result for unprobed Agents, use strict `probe.ok === true` checks in listing and routing, and preserve existing error isolation and probe-all behavior.

- [ ] **Step 4: Verify registry and orchestrator regressions**

Run: `node --test workbench/test/registry-probe-state.test.mjs workbench/test/registry.test.mjs workbench/test/orchestrator.test.mjs workbench/test/planner.test.mjs`

Expected: PASS.

### Task 4: Expose and document truthful probe behavior

**Files:**
- Modify: `workbench/server/http.mjs`
- Modify: `workbench/awb.mjs`
- Modify: `workbench/docs/SPEC.md`
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `workbench/agents/README.md`
- Modify: `README.md`
- Test: `workbench/test/http-probe.test.mjs`
- Test: `workbench/test/docs-m7b-contract.test.mjs`

**Interfaces:**
- `POST /api/agents/probe` returns the structured result map from `AgentRegistry.probeAll()`.
- CLI `agents:probe` prints status, resolved executable, version, and error without exposing raw prompt data.
- Documentation states that unprobed Agents are not routable and that ACP/CLI commands are configuration-driven.

- [ ] **Step 1: Write failing HTTP and documentation tests**

Assert probe response fields for built-in and fixture Agents, repeat probing deterministically, and check the docs mention `status: unknown`, `healthCheck.expect`, configured ACP command, and no hard-coded vendor command.

- [ ] **Step 2: Run focused tests**

Run: `node --test workbench/test/http-probe.test.mjs workbench/test/docs-m7b-contract.test.mjs`

Expected: FAIL because the current output is adapter-specific and docs still describe optimistic/deferred probing.

- [ ] **Step 3: Implement endpoint/CLI/docs updates**

Keep the HTTP route shape stable while returning the richer probe result, update CLI formatting to include status and diagnostics, and revise M7-B/M8 roadmap wording.

- [ ] **Step 4: Verify focused HTTP and CLI tests**

Run: `node --test workbench/test/http-probe.test.mjs workbench/test/http-smoke.test.mjs workbench/test/cli-smoke.test.mjs workbench/test/docs-m7b-contract.test.mjs`

Expected: PASS.

### Task 5: Complete regression verification and runtime smoke test

**Files:**
- Modify: `docs/assessment/2026-09-02-项目成熟度评估与改进路线.md`
- Test: existing full suite

- [ ] **Step 1: Mark M7-B probe work complete in the assessment**

Record the shipped truthful probe behavior, ACP/CLI configuration consistency, and retain shared-kernel extraction as a later M8 item.

- [ ] **Step 2: Run complete tests**

Run: `node --test`

Expected: all existing M7-A tests plus new M7-B tests pass with zero failures.

- [ ] **Step 3: Run syntax checks**

Run: `$files = Get-ChildItem -Recurse -Filter *.mjs | Where-Object { $_.FullName -notmatch '\\node_modules\\' }; $failed = @(); foreach ($f in $files) { node --check $f.FullName 2>$null; if ($LASTEXITCODE -ne 0) { $failed += $f.FullName } }; "checked=$($files.Count) failed=$($failed.Count)"; $failed`

Expected: `failed=0`.

- [ ] **Step 4: Run local service smoke test**

Run from `workbench/`: `AWB_NO_BROWSER=1 node awb.mjs serve`, then request `GET /api/health` and `POST /api/agents/probe` on loopback. Reuse an existing server if port `7788` is already listening.

- [ ] **Step 5: Report push readiness**

Check for `.git` and configured remote. If the workspace is still not a Git repository, report that push cannot be performed without initializing repository metadata; do not initialize or push unless the user explicitly asks for that external state change.

