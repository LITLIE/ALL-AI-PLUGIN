# Task 3 Report: Unify Adapter Loading and Fix Echo Execution

## Status

Complete. Echo dispatch now executes through the registry-configured adapter, persists the four yielded lifecycle events exactly once in order, reaches `awaiting-review`, and can be awaited through `waitForRun(runId)`.

## TDD Evidence

### RED

Added `workbench/test/orchestrator.test.mjs` with the required integration test before production edits.

Command:

```text
node --test test/orchestrator.test.mjs
```

Observed result: exit code 1. The test failed at `createRuntime()` with `createRuntime test fixture is not implemented yet`, confirming the required runtime path did not exist.

### GREEN

The first implementation run reached the assertions but failed because the orchestrator's pre-execution action event added an extra `undefined` payload type before the four Echo events. Removing that duplicate run-scoped lifecycle record made the adapter's yielded stream the single persisted source.

Final targeted command:

```text
node --test test/orchestrator.test.mjs
```

Observed result: exit code 0; 1 test passed, 0 failed.

## Changed Files

- `workbench/adapters/index.mjs`
  - Resolves adapters from a full Agent config object's `type` and caches by adapter type.
  - Retains string-key compatibility for the current registry probe call path.
- `workbench/adapters/echo.mjs`
  - Keeps the required four-event order and reduces the simulated delay to 10 ms.
- `workbench/core/orchestrator.mjs`
  - Loads the Agent config from `registry.agents` before loading its adapter.
  - Converts `_executeRun` to a normal async method that consumes the adapter stream.
  - Tracks execution promises in `_running`, removes them on settlement, and adds `waitForRun`.
  - Persists each yielded event once and removes automatic retry dispatch.
- `workbench/test/helpers.mjs`
  - Implements isolated `createRuntime(options?)` and `completedEchoRuntime()` fixtures.
- `workbench/test/orchestrator.test.mjs`
  - Adds the required Echo dispatch integration test.
- `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-3-report.md`
  - Records Task 3 evidence and results.

## Exact Verification Results

```text
node --test test/orchestrator.test.mjs
exit 0; tests 1, pass 1, fail 0

node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs
exit 0; tests 5, pass 5, fail 0

node --check adapters/index.mjs
exit 0

node --check adapters/echo.mjs
exit 0

node --check core/orchestrator.mjs
exit 0
```

## Concerns

- `loadAdapter()` accepts the required full config object and also temporarily accepts a string adapter type so the current registry probe implementation remains compatible. The orchestrator uses only the required full-config interface.
- No real Claude or Codex adapter was modified. No commit was created.

## Fix Round 1: Terminal Failure Contract

### RED

Added focused tests for adapter import rejection and an adapter stream ending without a terminal event.

Command:

```text
node --test test/orchestrator.test.mjs
```

Observed result: exit code 1; 1 test passed and 2 failed.

- Dispatching configured `claude-stream` caused `waitForRun()` to reject with `SyntaxError: Unexpected strict mode reserved word` during dynamic import.
- A temporary empty Echo stream returned from `waitForRun()` with both Run and task still in `running` state.

### GREEN

Moved Agent config lookup and adapter loading inside `_executeRun()`'s protected path. Added a single guarded failure terminalizer that marks the Run and task failed and persists one structured `{ type: 'run.failed', error }` event. Added a post-stream guard for streams that end without `run.completed`, `run.failed`, or `run.timeout`.

Focused result:

```text
node --test test/orchestrator.test.mjs
exit 0; tests 3, pass 3, fail 0
```

Combined and syntax verification:

```text
node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs
exit 0; tests 7, pass 7, fail 0

node --check adapters/index.mjs
exit 0

node --check adapters/echo.mjs
exit 0

node --check core/orchestrator.mjs
exit 0
```

Fix-round files changed:

- `workbench/core/orchestrator.mjs`
- `workbench/test/orchestrator.test.mjs`
- `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-3-report.md`

The real Claude adapter remains unchanged; its existing import failure is only used as the regression fixture.
