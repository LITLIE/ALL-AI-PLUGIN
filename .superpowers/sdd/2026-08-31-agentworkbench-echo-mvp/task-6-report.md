# Task 6 Report: Route CLI Through the Unified Runtime

## Status

Complete. The CLI now constructs the shared `EventBus`, `AgentRegistry`, and `Orchestrator` class runtime for non-server commands, uses `<AWB_STORE>/eventbus/bus.jsonl`, replays persisted state before stateful commands, honors explicit Agent selection, waits for terminal Runs, and closes the bus in `finally` without a forced-exit timer.

No core runtime behavior was modified.

## RED Evidence

Command:

```text
node --test test/cli-smoke.test.mjs
```

Initial result: exit 1, 0 passed, 2 failed.

- Explicit `--agent echo-test` was ignored. The CLI selected `codex-app` and printed a Run with `"state": "running"`.
- Explicit `--agent missing-agent` exited 0 and proceeded to dispatch instead of rejecting the unknown Agent.

These failures directly demonstrated the missing CLI behavior before production code was changed.

## GREEN Implementation

- Centralized non-server CLI setup in one runtime initializer using `EventBus`, `AgentRegistry`, and `Orchestrator`.
- Reused `core/flags.mjs` instead of retaining a duplicate parser in `awb.mjs`.
- Added generated task IDs and required flag validation for task creation.
- Replayed state before `task:list`, `task:dispatch`, `task:verdict`, `run:interrupt`, `run:rollback`, and `replay`.
- Validated an explicit configured Agent is known, enabled, and successfully probed; otherwise selected through `selectAgent(task)`.
- Awaited `waitForRun(runId)` and printed the terminal Run JSON.
- Added clear nonzero errors for unknown tasks, unknown/unavailable Agents, and no matching capability.
- Routed verdict actions `passed`, `rejected`, and `rework` to `submitVerdict`.
- Made `audit` print `integrityCheck()` and set a nonzero exit code when `ok:false`, including corrupt stores that cannot be initialized for append.
- Closed the bus in `finally` for every non-server command and removed timer-based forced process exit.

## Changed Files

- `workbench/awb.mjs`
- `workbench/test/cli-smoke.test.mjs`
- `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-6-report.md`

`workbench/core/flags.mjs` was reused without modification.

## Verification

```text
node --test test/cli-smoke.test.mjs
```

Exit 0: 2 tests passed, 0 failed.

```text
node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs test/replay.test.mjs test/verdict.test.mjs test/cli-smoke.test.mjs
```

Exit 0: 22 tests passed, 0 failed.

```text
node --check awb.mjs
```

Exit 0 with no syntax errors.

## Concerns

- Per the task constraint, the `serve` command was not started or browser-tested. It continues to delegate runtime ownership and shutdown to `server/http.mjs`, which already constructs the same three runtime classes.
- The smoke test intentionally uses real configured Agent probes. Broken optional adapters may report unavailable, but do not fail `agents:list`.

## Fix Round 1/5

### Review Findings Addressed

- `initializeRuntime()` now closes its real `EventBus` if any setup step throws after bus creation, then rethrows the original error. The normal successful-runtime cleanup in `main()` remains in `finally`.
- The `agents:list` smoke assertion now locates the `echo-test` row and requires its final status token to equal `available` exactly.
- A corrupt-store audit regression now requires a nonzero exit and parseable JSON stdout with `ok:false`.

### RED Evidence

Lifecycle regression, before the initializer was exposed for direct testing:

```text
node --test test/cli-smoke.test.mjs
```

Exit 1: 3 passed, 1 failed because `initializeRuntime` was not exported. After the minimal direct-entry guard/export change, the same command remained RED: 3 passed, 1 failed with `Missing expected rejection`, proving a real append still succeeded after forced registry initialization failure and the initialized bus was left open.

Availability assertion mutation check:

- Temporarily forced the `echo-test` row to print `unavailable`.
- Focused result: exit 1, 3 passed, 1 failed with actual `unavailable` versus expected `available`.
- The previous `/available/` substring assertion would have matched `unavailable`; the exact row-status assertion caught the mutation.
- Restored the correct probe-derived status logic immediately after the RED run.

Corrupt audit mutation check:

- Temporarily restored `bus.init()` for the `audit` command.
- Focused result: exit 1, 3 passed, 1 failed with `Unexpected end of JSON input`, because the CLI emitted no JSON report for the corrupt store.
- Restored the audit-specific no-init path immediately after the RED run.

### GREEN Evidence

```text
node --test test/cli-smoke.test.mjs
```

Exit 0: 4 tests passed, 0 failed.

```text
node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs test/replay.test.mjs test/verdict.test.mjs test/cli-smoke.test.mjs
```

Exit 0: 24 tests passed, 0 failed.

```text
node --check awb.mjs
```

Exit 0 with no syntax errors.

### Fix-Round Changed Files

- `workbench/awb.mjs`
- `workbench/test/cli-smoke.test.mjs`
- `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-6-report.md`

No core runtime files were modified.
