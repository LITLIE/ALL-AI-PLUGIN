# AgentWorkbench Echo MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `workbench` run a deterministic Echo vertical slice with one core model, replayable events, maker-checker verdicts, and test coverage.

**Architecture:** `EventBus`, `AgentRegistry`, and `Orchestrator` are the only runtime model. CLI and HTTP construct the same objects and persist all state-changing events to one JSONL bus. Adapter selection is configuration-driven by `agent.type`; Echo is the only adapter required to execute in this phase.

**Tech Stack:** Node.js 22 ESM, `node:http`, `node:test`, JSONL persistence, no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-agentworkbench-echo-mvp-design.md`

## Global Constraints

- Runtime is Node.js >=22 with zero npm runtime dependencies.
- Bind HTTP only to `127.0.0.1`.
- `bus.jsonl` is append-only; `seq` starts at 1 and must be continuous.
- Event payload strings are recursively redacted before persistence.
- Task and Run state must be reconstructable from the event log after process restart.
- External adapter output is untrusted; Echo output is deterministic test data.
- Do not implement real Claude/Codex execution, worktree merge, approval RPC, Tauri, or non-coding Agent protocols in this plan.
- This directory has no `.git`; commit commands are listed for traceability but must be reported as unavailable rather than simulated.

---

### Task 1: Establish the Test Harness and Reproduce Current Failures

**Files:**
- Create: `workbench/test/helpers.mjs`
- Create: `workbench/test/registry.test.mjs`
- Create: `workbench/test/bus.test.mjs`
- Modify: `workbench/package.json`

**Interfaces:**
- Tests import `EventBus` from `../core/bus.mjs` and `AgentRegistry` from `../core/registry.mjs`.
- `package.json` exposes `test: "node --test"`; Node's built-in test discovery finds `test/**/*.test.mjs` without shell glob expansion.
- `test/helpers.mjs` exports `tempWorkspace()`, `createRuntime()`, and `completedEchoRuntime()`; the latter two return isolated initialized runtimes for later tests.

- [ ] **Step 1: Write failing registry and bus tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../core/registry.mjs';
import { EventBus } from '../core/bus.mjs';
import { tempWorkspace } from './helpers.mjs';
import { fileURLToPath } from 'node:url';

test('registry loads echo config in ESM runtime', () => {
  const registry = new AgentRegistry(fileURLToPath(new URL('../agents', import.meta.url)));
  registry.load();
  assert.equal(registry.agents.has('echo-test'), true);
});

test('bus appends redacted events with continuous seq', async () => {
  const dir = await tempWorkspace();
  const bus = new EventBus(dir);
  await bus.init();
  await bus.append('system', { secret: 'sk-test12345678901234567890' });
  const events = await bus.readAll();
  assert.equal(events[0].seq, 1);
  assert.match(JSON.stringify(events[0]), /REDACTED/);
  await bus.close();
});
```

- [ ] **Step 2: Run the new tests and syntax checks**

Run: `npm test` and `node --check core/registry.mjs`

Expected: FAIL before implementation because the registry uses undefined `require` and the test script does not yet exist.

- [ ] **Step 3: Add the test helper and test script**

`tempWorkspace()` creates a unique directory under `node:os.tmpdir()` and returns its path. Add only the `test` script; do not add dependencies.

- [ ] **Step 4: Run the tests again**

Run: `npm test`

Expected: Tests still fail at the known ESM/CommonJS boundary, providing the baseline for Task 2.

- [ ] **Step 5: Record repository state**

Run: `git status --short`

Expected: Git reports that `D:\Agentplugin` is not a repository. Record this in the task notes; do not initialize Git or fabricate a commit.

### Task 2: Make Core Utilities and Registry ESM-Safe

**Files:**
- Modify: `workbench/core/registry.mjs`
- Modify: `workbench/core/utils.mjs`
- Modify: `workbench/core/spawn-helper.mjs`
- Test: `workbench/test/registry.test.mjs`

**Interfaces:**
- `AgentRegistry.load()` remains synchronous and loads JSON files from a filesystem string path.
- `AgentRegistry.probeAll()` stores results per Agent ID.
- `spawnPlan`, `findInPath`, `killProcessTree`, and `makeSnapshot` remain exported with their current names.

- [ ] **Step 1: Add a failing probe test**

```js
test('echo probe is available and type is resolved', async () => {
  const registry = new AgentRegistry(fileURLToPath(new URL('../agents', import.meta.url)));
  registry.load();
  const results = await registry.probeAll();
  assert.equal(results['echo-test'].ok, true);
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/registry.test.mjs`

Expected: FAIL with `require is not defined`.

- [ ] **Step 3: Replace CommonJS calls with static ESM imports**

Use `node:fs`, `node:path`, `node:crypto`, and `node:child_process` imports. Remove duplicate `spawnSync` naming in `spawn-helper.mjs`; alias the imported child-process function if necessary.

- [ ] **Step 4: Run syntax and focused tests**

Run: `node --check core/registry.mjs; node --check core/utils.mjs; node --check core/spawn-helper.mjs; node --test test/registry.test.mjs`

Expected: PASS.

### Task 3: Unify Adapter Loading and Fix Echo Execution

**Files:**
- Modify: `workbench/adapters/index.mjs`
- Modify: `workbench/adapters/echo.mjs`
- Modify: `workbench/core/orchestrator.mjs`
- Create: `workbench/test/orchestrator.test.mjs`

**Interfaces:**
- `loadAdapter(agentConfig)` accepts a full config object and resolves `agentConfig.type`.
- `Orchestrator.dispatch(taskId, agentId, prompt)` returns `{ runId, taskId, agentId, state }`.
- `Orchestrator.waitForRun(runId)` resolves when the Run reaches a terminal state.
- `test/helpers.mjs` exports `createRuntime()` and `completedEchoRuntime()` for isolated tests; both create a temporary store, initialize an `EventBus`, load `workbench/agents`, and return `{ bus, registry, orchestrator }`.

- [ ] **Step 1: Write the failing adapter and Echo flow test**

```js
test('echo dispatch reaches awaiting-review and writes ordered run events', async () => {
  const { bus, registry, orchestrator } = await createRuntime();
  const task = await orchestrator.createTask({ taskId: 'task-echo', description: 'ping', requiredTags: ['read'] });
  const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'ping');
  await orchestrator.waitForRun(run.runId);
  const events = await bus.readAll();
  assert.deepEqual(events.filter(e => e.meta?.runId === run.runId).map(e => e.payload?.type), [
    'run.started', 'run.thinking', 'run.stdout', 'run.completed'
  ]);
  assert.equal(orchestrator.tasks.get(task.taskId).state, 'awaiting-review');
  await bus.close();
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/orchestrator.test.mjs`

Expected: FAIL because `loadAdapter('echo-test')` returns no adapter and dispatch has no wait contract.

- [ ] **Step 3: Implement config-driven adapter loading**

Map `agent.type` to the existing module table, cache by type plus Agent ID when configuration affects behavior, and return `null` for unknown types. Update Orchestrator to pass the loaded config.

- [ ] **Step 4: Track execution promises and terminal state**

Store each `_executeRun` promise in a `Map`, resolve `waitForRun` on `run.completed`, `run.failed`, `run.timeout`, or `run.interrupted`, and ensure the task transitions to `awaiting-review` only on completion.

- [ ] **Step 5: Run the focused test**

Run: `node --test test/orchestrator.test.mjs`

Expected: PASS with exactly one persisted event per yielded Echo event.

### Task 4: Harden Event Integrity and Replay

**Files:**
- Modify: `workbench/core/bus.mjs`
- Modify: `workbench/core/orchestrator.mjs`
- Create: `workbench/test/replay.test.mjs`

**Interfaces:**
- `EventBus.integrityCheck()` returns `{ ok, totalLines, errors? }` and reports invalid JSON or a sequence gap.
- `Orchestrator.replay()` rebuilds `tasks` and `runs` from all persisted events.
- Replay tests reuse `createRuntime()` from `test/helpers.mjs`; the helper uses a unique `AWB_STORE`-equivalent temporary directory rather than the repository store.

- [ ] **Step 1: Write failing integrity and replay tests**

```js
test('integrity detects a seq gap and malformed line', async () => {
  const dir = await tempWorkspace();
  const file = join(dir, 'bus.jsonl');
  await mkdir(dir, { recursive: true });
  await writeFile(file, '{"seq":1,"kind":"system"}\n{"seq":3,"kind":"system"}\nnot-json\n');
  const bus = new EventBus(dir);
  assert.equal((await bus.integrityCheck()).ok, false);
});

test('replay restores completed Echo task', async () => {
  const first = await createRuntime();
  const task = await first.orchestrator.createTask({ taskId: 'task-replay', description: 'ping', requiredTags: ['read'] });
  const run = await first.orchestrator.dispatch(task.taskId, 'echo-test', 'ping');
  await first.orchestrator.waitForRun(run.runId);
  await first.bus.close();
  const second = await createRuntime();
  await second.orchestrator.replay();
  assert.equal(second.orchestrator.tasks.get('task-replay').state, 'awaiting-review');
  assert.equal(second.orchestrator.runs.has(run.runId), true);
  await second.bus.close();
});
```

- [ ] **Step 2: Run the focused tests**

Run: `node --test test/replay.test.mjs`

Expected: FAIL because the current bus filters malformed lines and replay only restores partial metadata.

- [ ] **Step 3: Implement strict read and integrity validation**

Parse every non-empty line, preserve its physical line number, validate `seq === index + 1`, and return structured errors without silently dropping invalid lines. Keep append-time redaction.

- [ ] **Step 4: Implement replay state folding**

Apply `task.created`, `run.started`, `run.completed`, `run.failed`, `run.timeout`, `run.interrupted`, and `verdict.*` events to reconstruct task and Run fields consistently with live execution.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/replay.test.mjs; npm test`

Expected: PASS.

### Task 5: Implement Maker-Checker Verdicts

**Files:**
- Modify: `workbench/core/orchestrator.mjs`
- Create: `workbench/test/verdict.test.mjs`

**Interfaces:**
- `submitVerdict(runId, verdict, reviewerId, reason)` returns `{ ok: boolean, reason?: string }`.
- Supported verdicts are `passed`, `rejected`, and `rework`.

- [ ] **Step 1: Write failing verdict tests**

```js
test('maker cannot review its own run', async () => {
  const { orchestrator, bus } = await completedEchoRuntime();
  const run = [...orchestrator.runs.values()][0];
  const result = await orchestrator.submitVerdict(run.runId, 'passed', run.agentId, 'self review');
  assert.equal(result.ok, false);
  await bus.close();
});

test('independent reviewer can pass a run', async () => {
  const { orchestrator, bus } = await completedEchoRuntime();
  const run = [...orchestrator.runs.values()][0];
  const result = await orchestrator.submitVerdict(run.runId, 'passed', 'human', 'verified');
  assert.equal(result.ok, true);
  assert.equal(orchestrator.tasks.get(run.taskId).state, 'passed');
  await bus.close();
});
```

- [ ] **Step 2: Run the focused tests**

Run: `node --test test/verdict.test.mjs`

Expected: FAIL or expose mismatched state names from the current implementation.

- [ ] **Step 3: Normalize verdict state transitions and event payloads**

Reject same-agent reviewers without changing the task state. For independent reviewers, update the task state and append one `verdict` event with `runId`, `taskId`, `reviewerId`, `verdict`, and `reason`.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/verdict.test.mjs; npm test`

Expected: PASS.

### Task 6: Route CLI Through the Unified Runtime

**Files:**
- Modify: `workbench/awb.mjs`
- Modify: `workbench/core/flags.mjs`
- Create: `workbench/test/cli-smoke.test.mjs`

**Interfaces:**
- `agents:list` prints `echo-test` as available.
- `task:create` prints the created `taskId`.
- `task:dispatch --task <id> --agent echo-test` waits for Echo completion before exiting.
- `replay` and `audit` operate on the same store selected by `AWB_STORE`.

- [ ] **Step 1: Write the CLI smoke test**

Spawn `node awb.mjs agents:list` and assert exit code 0 plus `echo-test`; create a temporary `AWB_STORE`, create a task, dispatch it, then assert `run.completed` exists in `eventbus/bus.jsonl`.

- [ ] **Step 2: Run the smoke test**

Run: `node --test test/cli-smoke.test.mjs`

Expected: FAIL initially because the current CLI exits through the broken registry and does not reliably wait for execution.

- [ ] **Step 3: Simplify CLI construction**

Use one helper to create `EventBus`, `AgentRegistry`, and `Orchestrator`, call `registry.load()` and `orchestrator.replay()` where needed, and close the bus on every successful command path.

- [ ] **Step 4: Make dispatch deterministic**

After printing the Run, await `orchestrator.waitForRun(run.runId)` before closing the bus. Preserve `--agent` selection and return a non-zero exit for unknown tasks or unavailable Agents.

- [ ] **Step 5: Run CLI smoke and full tests**

Run: `node --test test/cli-smoke.test.mjs; npm test`

Expected: PASS.

### Task 7: Align HTTP/SSE With the Same Core Objects

**Files:**
- Modify: `workbench/server/http.mjs`
- Modify: `workbench/server/sse.mjs`
- Modify: `workbench/ui/app.mjs`
- Create: `workbench/test/http-smoke.test.mjs`

**Interfaces:**
- `GET /api/health` returns `{ ok: true }`.
- `GET /api/agents` includes `echo-test` and its probe state.
- `POST /api/tasks` creates a task using the same Orchestrator instance.
- `POST /api/tasks/:id/dispatch` accepts `{ agentId, prompt }` and returns the Run.
- `GET /api/events?since=N` sends only events with `seq > N`, then new events once.

- [ ] **Step 1: Write failing HTTP smoke tests**

Start `startServer({ host: '127.0.0.1', port: 0, agentsDir })`, call health, agents, task creation, and dispatch endpoints, then close the returned server and bus. Assert the Echo completion event is visible through `/api/events?since=0`.

- [ ] **Step 2: Run the focused HTTP test**

Run: `node --test test/http-smoke.test.mjs`

Expected: FAIL on the current `require` usage and stale SSE implementation.

- [ ] **Step 3: Remove stale HTTP API imports and CommonJS calls**

Keep `server/http.mjs` as the only HTTP router. Use `EventBus.readFrom()` for initial SSE replay and a polling cursor or explicit bus event hook for subsequent events; do not mutate a `const` cursor.

- [ ] **Step 4: Update the UI client to current response shapes**

Read task IDs from `taskId`, Run IDs from `runId`, and verdict actions from the unified endpoint. Do not add new screens or visual systems in this phase.

- [ ] **Step 5: Run HTTP and full tests**

Run: `node --test test/http-smoke.test.mjs; npm test`

Expected: PASS.

### Task 8: Final Verification and Documentation Update

**Files:**
- Modify: `workbench/docs/SPEC.md`
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `README.md`

- [ ] **Step 1: Run all static and behavioral checks**

Run:

```text
Get-ChildItem -Recurse -File workbench -Filter *.mjs | ForEach-Object { node --check $_.FullName }
npm test
node awb.mjs agents:list
node awb.mjs audit
```

Expected: all syntax checks and tests pass; `agents:list` shows `echo-test` available; `audit` reports an intact store for the test workspace.

- [ ] **Step 2: Update docs to match shipped behavior**

Document the single runtime path, the Echo smoke test, the exact store layout, and the explicitly deferred features. Remove claims that are not implemented in this phase.

- [ ] **Step 3: Verify the documented smoke flow manually**

Run the six commands in the design spec with a temporary `AWB_STORE`, then inspect `bus.jsonl` and confirm ordered task/run/verdict events.

- [ ] **Step 4: Record final repository status**

Run: `git status --short`

Expected: the command still reports no Git repository. Report changed files and test output directly to the user; do not claim a commit.
