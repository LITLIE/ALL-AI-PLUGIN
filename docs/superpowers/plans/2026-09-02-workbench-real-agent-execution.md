# AgentWorkbench Real Agent Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Workbench execute configured Claude stream-json and Codex app-server Agents through the existing event-sourced runtime while preserving deterministic Echo behavior.

**Architecture:** `Orchestrator` remains the only execution coordinator and passes the complete Agent configuration into adapters. A single Windows-aware process launcher resolves commands and `.cmd/.bat` shims; Claude and Codex adapters convert their native streams into a uniform `AsyncIterable<Event>`. Existing EventBus persistence, replay, verdict, HTTP, and SSE contracts remain authoritative.

**Tech Stack:** Node.js 22 ESM, `node:child_process`, `node:test`, JSONL persistence, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-workbench-real-agent-execution-design.md`

## Global Constraints

- Runtime is Node.js >=22 with zero npm runtime dependencies.
- HTTP remains loopback-only on `127.0.0.1`.
- Agent configuration is the source of command, args, env, protocol, timeout, and retry metadata.
- Every adapter returns an `AsyncIterable<Event>` and emits at most one terminal Run event.
- EventBus remains append-only with continuous `seq`; all adapter output is untrusted data.
- Do not implement worktrees, snapshots, diff/apply/rollback, approvals, Planner/DAG, retries, Tauri, or remote execution in this plan.
- Real CLI smoke tests are optional and must never be required by automated tests.
- The workspace is not a Git repository; do not run or claim `git commit`.

---

### Task 1: Replace the Windows Process Launcher With One Tested Implementation

**Files:**
- Modify: `workbench/core/utils.mjs`
- Modify: `workbench/core/spawn-helper.mjs`
- Create: `workbench/test/spawn.test.mjs`

**Interfaces:**
- `spawnPlan(command, args)` returns `{ file, args, viaShell, resolved }` and resolves Windows `.cmd/.bat` files through `cmd.exe /d /s /c`.
- `findInPath(command)` returns the resolved executable path or `null`.
- Existing imports of `spawnPlan`, `findInPath`, `killProcessTree`, and snapshot helpers remain valid.

- [ ] **Step 1: Write failing launcher tests**

Create a temporary directory containing `fake-agent.cmd` and a no-extension `fake-agent` shim. Set `PATH` to that directory plus the original path, then assert that `findInPath('fake-agent')` selects a PATHEXT candidate and `spawnPlan('fake-agent', ['--version'])` returns `viaShell: true`, `file` equal to `ComSpec`, and args beginning with `['/d', '/s', '/c']` on Windows. Add a non-Windows branch that asserts direct execution remains shell-free.

- [ ] **Step 2: Run the focused test and capture the failure**

Run:

```text
cd workbench
node --test test/spawn.test.mjs
```

Expected: the current implementation either selects the extensionless shim or returns the incompatible `{ command, shell }` shape.

- [ ] **Step 3: Copy the proven resolution semantics into `utils.mjs`**

Implement PATHEXT probing in this order: explicit path, each extension in `PATHEXT`, then extensionless executable on non-Windows. For `.cmd` and `.bat`, return the `ComSpec` command plan; for `.exe` and ordinary binaries, return the resolved path directly. Keep argument arrays intact and do not interpolate prompt text in this helper.

- [ ] **Step 4: Remove competing command-resolution behavior**

Update `spawn-helper.mjs` so it delegates to `utils.mjs` or only retains helpers that have no overlapping resolution logic. Update all callers to use the same returned property names (`file`, `viaShell`, `resolved`).

- [ ] **Step 5: Run focused tests and syntax checks**

Run:

```text
node --check core/utils.mjs
node --check core/spawn-helper.mjs
node --test test/spawn.test.mjs
```

Expected: PASS, including the Windows shim regression.

### Task 2: Make Probing and Dispatch Fully Configuration-Driven

**Files:**
- Modify: `workbench/adapters/index.mjs`
- Modify: `workbench/core/registry.mjs`
- Modify: `workbench/core/orchestrator.mjs`
- Modify: `workbench/awb.mjs`
- Modify: `workbench/server/http.mjs`
- Create: `workbench/test/adapter-config.test.mjs`

**Interfaces:**
- `loadAdapter(agentConfig)` resolves `agentConfig.type` and returns the adapter module or `null`.
- `adapter.probe(agentConfig)` may read `command`, `args`, and `env` from the supplied config.
- `adapter.run({ taskId, runId, prompt, cwd, timeoutMs, signal, agentConfig })` receives the complete config.
- Explicit Agent selection rejects only missing, disabled, unavailable, or adapter-less Agents; it no longer rejects every non-Echo type.

- [ ] **Step 1: Write failing configuration tests**

Create a temporary Agent config with `type: 'cli-text'`, a fixture command, custom args, and an environment marker. Assert that `registry.probeAll()` invokes the configured command and that a spy adapter receives the same config from `Orchestrator._executeRun`.

- [ ] **Step 2: Run the focused test**

Run:

```text
node --test test/adapter-config.test.mjs
```

Expected: FAIL because probes currently call adapters without config and dispatch paths enforce `type === 'echo'`.

- [ ] **Step 3: Update adapter loading and registry probing**

Make `loadAdapter` accept a config object while retaining string compatibility for existing tests. Change `AgentRegistry.probe()` to call `adapter.probe(agent)` and persist the result. Preserve built-in Echo probing without requiring a command.

- [ ] **Step 4: Pass config through the Orchestrator**

In `_executeRun`, call `adapter.run({ taskId, runId, prompt, cwd, timeoutMs, signal, agentConfig })`. Use `agentConfig.timeoutDefault` when the task does not override a timeout, capped by `timeoutMax` when present. Keep the existing active adapter and iterator references for interruption.

- [ ] **Step 5: Remove Echo-only gates at every boundary**

Delete the type equality checks in `Orchestrator.dispatch`, `AgentRegistry.findByCapability`, `awb.mjs` explicit selection, and the HTTP dispatch route. Replace them with adapter existence plus successful probe checks. Error messages must identify the Agent ID and actual cause.

- [ ] **Step 6: Run focused and existing tests**

Run:

```text
node --check adapters/index.mjs
node --check core/registry.mjs
node --check core/orchestrator.mjs
node --test test/adapter-config.test.mjs test/registry.test.mjs test/orchestrator.test.mjs
```

Expected: PASS with Echo behavior unchanged and configured non-Echo Agents accepted by validation.

### Task 3: Implement a Lossless Claude stream-json Event Bridge

**Files:**
- Modify: `workbench/adapters/claude-stream-json.mjs`
- Modify: `workbench/core/utils.mjs`
- Create: `workbench/test/claude-adapter.test.mjs`
- Create: `workbench/test/fixtures/fake-claude.mjs`

**Interfaces:**
- `claude-stream-json.run(...)` yields exactly one `run.started`, zero or more process events, and exactly one terminal event.
- The adapter reads `agentConfig.command`, `agentConfig.args`, `agentConfig.env`, and `agentConfig.outputProtocol`.
- `interrupt({ proc, runId, signal })` or the active Run context terminates the process without allowing a later completion.

- [ ] **Step 1: Write the failing Claude contract test**

The fixture writes JSONL messages for `system/init`, `assistant`, and successful `result`, then exits zero. The test collects the adapter stream and asserts event types contain one `run.started`, one `run.init`, one `run.stdout`, and one `run.completed`, with no duplicate terminal event and a non-negative cost/duration.

- [ ] **Step 2: Run the focused test**

Run:

```text
node --test test/claude-adapter.test.mjs
```

Expected: FAIL because the current generator emits duplicate `run.started` and sends all useful events through an unconsumed callback.

- [ ] **Step 3: Add a small internal async queue**

Implement a queue with `push(value)`, `close(error)`, and an async `next()` operation. Stdout and stderr listeners push converted events; the generator yields queued events until a terminal event closes the queue. The queue must wake pending readers when the process closes.

- [ ] **Step 4: Build arguments from the Agent config**

Substitute only documented variables (`{{prompt}}`, `{{cwd}}`, `{{taskId}}`, `{{runId}}`) in configured args. If prompt is configured for stdin, write it to stdin and do not duplicate it in args. Use the unified `spawnPlan` result and merged environment.

- [ ] **Step 5: Enforce terminal-event uniqueness**

When `result` reports success, enqueue one `run.completed` with result text, cost, duration, usage, permission denials, and session metadata. On non-zero exit or failed result, enqueue one `run.failed`. On timeout, enqueue one `run.timeout`, terminate the process tree, and ignore any later result message.

- [ ] **Step 6: Run focused tests and syntax checks**

Run:

```text
node --check adapters/claude-stream-json.mjs
node --test test/claude-adapter.test.mjs
```

Expected: PASS for success, malformed-line tolerance, non-zero exit, timeout, and interruption cases.

### Task 4: Make Codex app-server Complete on Notifications

**Files:**
- Modify: `workbench/adapters/codex-app-server.mjs`
- Modify: `workbench/core/utils.mjs`
- Create: `workbench/test/codex-adapter.test.mjs`
- Create: `workbench/test/fixtures/fake-codex-app-server.mjs`

**Interfaces:**
- `connect({ cwd, agentConfig, onEvent })` returns `{ proc, send, notifications, close }` and rejects pending requests when the process exits.
- `codex-app-server.run(...)` yields one terminal event based on a turn completion, error, timeout, or interruption.
- `interrupt({ proc, threadId, turnId })` sends `turn/interrupt` before process-tree cleanup.

- [ ] **Step 1: Write the failing Codex completion test**

The fixture responds to `initialize`, `thread/start`, and `turn/start`, then emits a completion notification after a short delay. The test asserts the adapter completes before a timeout and includes the returned thread/turn IDs in intermediate events.

- [ ] **Step 2: Run the focused test**

Run:

```text
node --test test/codex-adapter.test.mjs
```

Expected: FAIL because the current polling loop never reads `notifications` and therefore waits until timeout.

- [ ] **Step 3: Add notification waiting and protocol normalization**

Track notifications by turn ID and normalize completion methods such as `turn/completed`, `turn/complete`, and equivalent status payloads into one internal completion signal. Preserve unrelated notifications as `run.stdout` or `codex.notify` process events.

- [ ] **Step 4: Handle process exit and pending RPC failure**

On `proc.exit` or `proc.error`, reject all pending request promises, close notification waiting, and produce one `run.failed` unless a terminal event already won the race.

- [ ] **Step 5: Implement timeout and interruption cleanup**

On timeout, yield `run.timeout`, send `turn/interrupt`, wait no longer than 3 seconds, then call the shared `killProcessTree`. Abort signals must follow the same terminal uniqueness rule.

- [ ] **Step 6: Run focused tests and syntax checks**

Run:

```text
node --check adapters/codex-app-server.mjs
node --test test/codex-adapter.test.mjs
```

Expected: PASS for completion, server error, timeout, interruption, and no-orphan cleanup fixture cases.

### Task 5: Integrate External Runs Into Orchestrator Lifecycle

**Files:**
- Modify: `workbench/core/orchestrator.mjs`
- Modify: `workbench/test/orchestrator.test.mjs`
- Modify: `workbench/test/replay.test.mjs`
- Modify: `workbench/test/verdict.test.mjs`

**Interfaces:**
- `Orchestrator.dispatch(taskId, agentId, prompt)` creates and persists one Run for any available adapter.
- `Orchestrator.waitForRun(runId)` resolves after a terminal event and never before the event is persisted.
- `_applyRunEvent` maps external completion/failure/timeout/interruption to existing task states without vendor-specific branches.

- [ ] **Step 1: Add integration tests using both protocol fixtures**

Create temporary Agent configs for the Claude and Codex fixtures, dispatch each through the same Orchestrator, assert ordered persisted events, assert task state `awaiting-review` on completion, and assert replay reconstructs the same Run state.

- [ ] **Step 2: Run the focused integration tests**

Run:

```text
node --test test/orchestrator.test.mjs test/replay.test.mjs
```

Expected: FAIL until the adapter config and terminal event contracts are consumed by the Orchestrator.

- [ ] **Step 3: Guard against duplicate terminal transitions**

Before appending an adapter event, ignore a second terminal event for the same Run. Preserve the first terminal event as authoritative and ensure `_failRun` does not turn a completed Run into failed merely because an iterator closes afterward.

- [ ] **Step 4: Preserve maker-checker behavior for external Agents**

Run the existing self-review and independent-review tests against a fixture-created Run. The maker Agent ID must still be compared with `reviewerId`; accepted verdicts must remain replayable.

- [ ] **Step 5: Run the complete Workbench test suite**

Run:

```text
node --test
```

Expected: all existing tests plus the new adapter tests pass.

### Task 6: Add CLI/HTTP Regression Coverage and Synchronize Documentation

**Files:**
- Modify: `workbench/awb.mjs`
- Modify: `workbench/server/http.mjs`
- Modify: `workbench/ui/app.mjs`
- Modify: `workbench/docs/SPEC.md`
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `workbench/test/cli-smoke.test.mjs`
- Modify: `workbench/test/http-smoke.test.mjs`

**Interfaces:**
- CLI `agents:list` and `agents:probe` expose configured external Agent status and resolved command diagnostics.
- CLI `task:dispatch --agent <id>` waits for the selected Run terminal state before closing the bus.
- HTTP dispatch returns the Run immediately while SSE exposes subsequent process and terminal events.
- UI treats external Agent states and Run terminal events using the same response shapes as Echo.

- [ ] **Step 1: Add CLI fixture regression**

Run the CLI with a temporary `AWB_AGENTS_DIR` containing a Claude fixture config and temporary `AWB_STORE`. Assert `agents:probe` reports success, dispatch exits zero, and `bus.jsonl` contains exactly one terminal event for the Run.

- [ ] **Step 2: Add HTTP/SSE fixture regression**

Start the server with the temporary Agent directory, create a task requiring the fixture capability, dispatch it through HTTP, consume `/api/events?since=0`, and assert the stream contains process output followed by one terminal event. Close the server and replay from the same store.

- [ ] **Step 3: Update CLI and HTTP error messages**

Replace Echo-specific wording such as “not executable in the Echo MVP” with errors that name the configured Agent, missing adapter, failed probe, or capability mismatch. Keep deferred endpoints returning `501`.

- [ ] **Step 4: Verify UI response handling**

Ensure external Agent cards show `available` based on probe state, task rows show the actual Agent ID, and logs include `run.stdout`, `run.stderr`, `run.failed`, `run.timeout`, and `run.completed` events without assuming Echo-only text.

- [ ] **Step 5: Synchronize shipped-scope documentation**

Update `README.md`, `workbench/docs/SPEC.md`, and `workbench/docs/ARCHITECTURE.md` to state that Claude/Codex fixture execution is supported through the unified adapter path, while worktree isolation, diff/apply/rollback, approvals, Planner/DAG, retries, and human bridge remain deferred.

- [ ] **Step 6: Run final verification**

Run:

```text
cd workbench
Get-ChildItem -Recurse -File -Filter *.mjs | ForEach-Object { node --check $_.FullName }
node --test
node awb.mjs agents:list
node awb.mjs agents:probe
```

Expected: syntax checks and tests pass; installed tools report their actual probe status; missing tools report actionable errors; no deferred feature is presented as implemented.

