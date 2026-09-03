# AgentWorkbench M6 Planner/DAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Add validated Planner decomposition, replayable parent/child DAG state, dependency-aware parallel scheduling, durable blocked tasks, and CLI/HTTP graph execution to the local AgentWorkbench.

**Architecture:** Keep EventBus as the sole source of truth. Add a focused `core/dag.mjs` for plan normalization, ID/dependency validation, topological readiness, and aggregate calculation; add `core/planner.mjs` for extracting and validating structured Planner output. Extend Orchestrator with decomposition, graph scheduling, replay folding, and parent aggregation while reusing the existing dispatch path for every child Run.

**Tech Stack:** Node.js >=22 ESM, built-in `node:test`, `node:crypto`, existing EventBus/AgentRegistry/Orchestrator, zero runtime dependencies, loopback HTTP server.

**Spec:** `docs/superpowers/specs/2026-09-03-workbench-m6-planner-dag-design.md`

## Global Constraints

- Preserve append-only EventBus JSONL, contiguous `seq`, sanitizer, and replay semantics.
- Preserve M5 approval, immutable retry, watchdog termination, prompt privacy, metrics, and Inline Execution behavior.
- Do not add runtime dependencies or introduce a second persistence store.
- Planner output must use the existing capability vocabulary (`read`, `write`, `refactor`, `analyze`, `test`, `review`, `design`).
- Plans contain 1-64 children; child IDs are unique and dependencies are sibling-only.
- A parent `high-risk` task cannot create a lower-risk child.
- Every production change starts with a focused failing `node:test` test and a recorded red run.
- This workspace is not a Git repository; use verification checkpoints instead of commit steps.

---

### Task 1: DAG Validation and Task Graph Primitives

**Files:**
- Create: `workbench/core/dag.mjs`
- Modify: `workbench/core/orchestrator.mjs: TASK_STATES and task initialization`
- Test: `workbench/test/dag.test.mjs`

**Interfaces:**
- `normalizePlan(rawPlan, parentTask, options?)` returns `{ ok: true, plan }` or `{ ok: false, error: { code, message, missingTags? } }`.
- `validateDependencies(children)` returns `{ ok: true, order }` or a cycle/missing-dependency error.
- `readyChildren(tasks, parentTask)` returns child Task objects whose dependencies are execution-successful.
- `aggregateChildren(tasks, childIds)` returns `{ total, completed, failed, timeout, interrupted, blocked }`.

- [ ] **Step 1: Write failing DAG tests**

Add tests for normalizing three children, ignoring unknown fields, defaulting child fields from the parent, rejecting duplicate IDs, rejecting unknown dependencies, rejecting self-dependencies and cycles, enforcing the 64-child limit, preserving high-risk inheritance, selecting only dependency-ready children, and calculating aggregate counters.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test test/dag.test.mjs` from `D:\Agentplugin\workbench`.

Expected: FAIL because `../core/dag.mjs` and the `blocked` state do not exist.

- [ ] **Step 3: Implement minimal graph primitives**

Implement `normalizePlan()` with the existing task ID regex, capability vocabulary imported from `config/schema.mjs`, parent risk inheritance, bounded child count, and a normalized child object. Implement Kahn topological sorting in `validateDependencies()`, readiness based on child Task states `awaiting-review` or `passed`, and aggregate counters from current child states. Add `TASK_STATES.BLOCKED` and initialize root tasks with `parentTaskId: null`, `children: []`, `planVersion: 0`, `planStatus: 'none'`, `blockedReason: null`, and `aggregate: null`.

- [ ] **Step 4: Run focused and regression tests**

Run: `node --test test/dag.test.mjs test/config.test.mjs test/orchestrator.test.mjs`.

Expected: all selected tests pass; existing single-task states remain unchanged.

### Task 2: Planner Output Extraction and Decomposition Events

**Files:**
- Create: `workbench/core/planner.mjs`
- Modify: `workbench/core/orchestrator.mjs: decomposeTask(), task event replay`
- Test: `workbench/test/planner.test.mjs`

**Interfaces:**
- `extractPlanText(run)` returns the final text candidate without writing a new event.
- `parsePlannerPlan(text, parentTask)` delegates to `normalizePlan()` and returns the same result shape.
- `Orchestrator.decomposeTask(taskId, plannerAgentId, prompt?)` returns `{ ok, task, children, planVersion, plannerRunId }` or throws a structured workflow error.

- [ ] **Step 1: Write failing Planner tests**

Use an injected adapter instance that yields one deterministic JSON plan in `run.completed.text`. Assert accepted plans create `task.plan.requested`, `task.plan.accepted`, and child `task.created` events in order; normalized children are attached to the parent; planner prompt/output text is not copied into plan events; malformed JSON, duplicate IDs, and cycles create `task.plan.rejected` without child Tasks; and a second decomposition returns `plan_conflict`.

- [ ] **Step 2: Run Planner tests and verify failure**

Run: `node --test test/planner.test.mjs`.

Expected: FAIL because the Planner extraction and `decomposeTask()` API do not exist.

- [ ] **Step 3: Implement extraction and decomposition**

Implement `extractPlanText()` from `run.text` and the terminal event payload, strip an optional Markdown code fence, and parse the first JSON object. Implement `decomposeTask()` by checking the parent, planner registry/probe, and planner capability (`design` or `analyze`), writing prompt length/hash in `task.plan.requested`, dispatching the Planner through the existing Run path, validating the result, and persisting accepted/rejected plan events. On success, call `createTask()` for each normalized child with `parentTaskId`, inherited `cwd`, `sandboxMode`, retry/watchdog settings, and dependency IDs; then append `task.plan.accepted` before child creation so replay can distinguish an accepted plan from partial child persistence.

- [ ] **Step 4: Run focused and M5 regression tests**

Run: `node --test test/planner.test.mjs test/privacy.test.mjs test/approval.test.mjs test/retry.test.mjs`.

Expected: Planner tests pass and raw prompt privacy, approval, and retry behavior remain green.

### Task 3: Replayable Parent/Child State and Blocked Propagation

**Files:**
- Modify: `workbench/core/orchestrator.mjs: replay(), getTaskSnapshot(), event application helpers`
- Test: `workbench/test/dag-replay.test.mjs`

**Interfaces:**
- Internal `_applyTaskGraphEvent(task, event)` folds `task.plan.*`, `task.blocked`, `task.ready`, and `task.aggregate.updated` events.
- `getTaskSnapshot(taskId)` includes `parentTaskId`, `children`, `blockedReason`, `aggregate`, and child snapshots for parent tasks.
- `Orchestrator.refreshGraphState(parentTaskId)` recomputes durable aggregate/readiness state without dispatching Runs.

- [ ] **Step 1: Write failing replay tests**

Create a parent and accepted child events, restart with a new Orchestrator, call `replay()`, and assert exact parent/child relationships, plan version, blocked reason, aggregate counters, and child dependencies are restored. Add a test that a missing capability writes one `task.blocked` event and dependent children become blocked with `dependency_blocked` after replay.

- [ ] **Step 2: Run replay tests and verify failure**

Run: `node --test test/dag-replay.test.mjs`.

Expected: FAIL because replay currently only understands single-task dispatch/run/verdict events.

- [ ] **Step 3: Implement replay folding and propagation**

Extend `replay()` to fold child creation and graph events after task creation, keep `assignedRuns` idempotent, and derive parent state from child state. Implement `refreshGraphState()` to mark ready children with `task.ready`, mark descendants of blocked children with `task.blocked`, and append one aggregate update per changed state. Do not create Runs during replay.

- [ ] **Step 4: Run replay and existing recovery tests**

Run: `node --test test/dag-replay.test.mjs test/replay.test.mjs test/bus.test.mjs`.

Expected: all selected tests pass with contiguous EventBus sequences.

### Task 4: Dependency-Aware Parallel Scheduler

**Files:**
- Modify: `workbench/core/orchestrator.mjs: runTaskGraph() and scheduling helpers`
- Test: `workbench/test/scheduler.test.mjs`

**Interfaces:**
- `Orchestrator.runTaskGraph(parentTaskId, { maxParallel = 4, continueOnFailure = false } = {})` resolves to `{ ok, task, children, aggregate, scheduledRunIds }` after reaching a stable graph point.
- Internal `_scheduleReadyChildren(parentTask, options)` returns settled child results and never creates duplicate Runs for a child already in progress or completed for the current `planVersion`.

- [ ] **Step 1: Write failing scheduler tests**

Inject an adapter that records active invocations and delays completion. Assert three independent children never exceed `maxParallel`, dependent children start only after prerequisites complete, no-capability children become blocked without a Run, fail-fast prevents descendants after a failed child, `continueOnFailure` permits independent branches but never marks the parent successful, and repeated `runTaskGraph()` calls do not duplicate Runs.

- [ ] **Step 2: Run scheduler tests and verify failure**

Run: `node --test test/scheduler.test.mjs`.

Expected: FAIL because `runTaskGraph()` and readiness scheduling do not exist.

- [ ] **Step 3: Implement minimal scheduler**

Implement a bounded worker loop over `readyChildren()`: select each child Agent independently, append `task.ready` or `task.blocked`, dispatch ready children concurrently up to `maxParallel`, await `waitForRun()` for each, refresh graph state, and repeat while new children become ready. Honor fail-fast by blocking descendants after the first failed/timeout/interrupted child unless `continueOnFailure` is true. Append `scheduler.started`, `task.aggregate.updated`, and `scheduler.completed` events. Reuse `dispatch()` so approval, retries, watchdog, snapshots, and metrics stay centralized.

- [ ] **Step 4: Run scheduler and full core regression tests**

Run: `node --test test/scheduler.test.mjs test/dag-replay.test.mjs test/orchestrator.test.mjs test/retry.test.mjs test/watchdog.test.mjs`.

Expected: all selected tests pass, including single-task Inline Execution and M5 reliability controls.

### Task 5: CLI and HTTP Graph Controls

**Files:**
- Modify: `workbench/awb.mjs: help, replay command set, command switch`
- Modify: `workbench/server/http.mjs: decomposition and graph-run routes`
- Test: `workbench/test/cli-smoke.test.mjs`
- Test: `workbench/test/http-smoke.test.mjs`

**Interfaces:**
- CLI `task:decompose --task <id> --planner <agent-id> [--prompt <text>]` prints the parent snapshot and child definitions as JSON.
- CLI `task:run --task <id> [--maxParallel <n>] [--continueOnFailure]` prints the stable parent graph result.
- HTTP `POST /api/tasks/:id/decompose` accepts `{ plannerAgentId, prompt? }`.
- HTTP `POST /api/tasks/:id/run` accepts `{ maxParallel?, continueOnFailure? }`.

- [ ] **Step 1: Write failing CLI/HTTP tests**

Add CLI tests for decompose/run success, invalid planner, invalid max parallel, and replay persistence. Add HTTP tests for both routes, structured 400/404/409 errors, exact loopback/origin checks, and returned parent aggregate/child snapshots.

- [ ] **Step 2: Run boundary tests and verify failure**

Run: `node --test test/cli-smoke.test.mjs test/http-smoke.test.mjs`.

Expected: FAIL because the new commands and routes are not registered.

- [ ] **Step 3: Implement CLI and HTTP surfaces**

Add command help and replay initialization for graph commands. Parse positive integer `maxParallel` and boolean `continueOnFailure`, call the Orchestrator APIs, and serialize structured errors with nonzero CLI exit codes. Add HTTP routes beside existing task routes, validate task IDs before lookup, enforce request body types, and return 201 for decomposition and 200 for stable graph execution.

- [ ] **Step 4: Run boundary and regression tests**

Run: `node --test test/cli-smoke.test.mjs test/http-smoke.test.mjs test/approval.test.mjs test/metrics-integration.test.mjs`.

Expected: all selected tests pass and deferred bridge routes remain unchanged.

### Task 6: Documentation and Final Verification

**Files:**
- Modify: `workbench/docs/SPEC.md`
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `docs/assessment/2026-09-02-项目成熟度评估与改进路线.md: M6 status`
- Test: all existing `workbench/test/*.mjs`

**Interfaces:**
- Documentation describes M6 as shipped only after the full test suite passes.
- Roadmap keeps Git worktrees, Human Bridge, ACP, Tauri, remote execution, and multi-user authorization deferred.

- [ ] **Step 1: Update shipped contracts**

Document Planner JSON, DAG states, blocked propagation, parallel limits, CLI/HTTP routes, event types, replay guarantees, and the continued M5 privacy/reliability contracts. Update the assessment roadmap to mark M6 complete and M7/M8 as next work.

- [ ] **Step 2: Run complete verification**

Run from `D:\Agentplugin\workbench`:

```powershell
node --test
$files = Get-ChildItem -Path . -Recurse -Filter *.mjs -File
foreach ($file in $files) { node --check $file.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

Expected: all tests pass, all `.mjs` files parse, and no new dependency is present.

- [ ] **Step 3: Perform contract scan**

Run:

```powershell
rg -n "M6|task:decompose|task:run|api/tasks/.*/decompose|api/tasks/.*/run|blocked|Planner|DAG" README.md workbench/docs docs/assessment
```

Confirm no document claims Planner/DAG is deferred after M6, while explicitly deferred M7/M8 items remain marked deferred.
