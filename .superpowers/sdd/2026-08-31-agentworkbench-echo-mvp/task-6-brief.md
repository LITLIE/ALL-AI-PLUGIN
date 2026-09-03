# Task 6: Route CLI Through the Unified Runtime

Read this first — it is your complete requirements.

Modify/create only:
- Modify `workbench/awb.mjs`
- Modify `workbench/core/flags.mjs` only if reused by `awb.mjs`
- Create `workbench/test/cli-smoke.test.mjs`

CLI commands must all construct the same `EventBus`, `AgentRegistry`, and `Orchestrator` class runtime. Do not use the stale function-style `core/dispatch.mjs` API.

Required behavior:
- `AWB_STORE` is a root chosen by the caller; the bus lives at `<AWB_STORE>/eventbus/bus.jsonl`.
- `agents:list` loads/probes the registry and prints `echo-test` as `available`; other broken adapters may print unavailable without failing the command.
- `task:create --title T --requiredTags a,b [--description D] [--cwd P]` creates a generated task ID, appends `task.created`, prints `[ok] task created: <id>`, and closes the bus.
- State-reading or mutation commands (`task:list`, `task:dispatch`, `task:verdict`, `run:interrupt`, `run:rollback`, `replay`) call `orchestrator.replay()` after initialization.
- `task:dispatch --task <id> [--agent <id>]`: if `--agent` is given, validate that exact configured Agent is enabled and has a successful probe; otherwise use `selectAgent(task)`. Dispatch and await `waitForRun(runId)` before closing the bus. Print the terminal Run JSON.
- Unknown task, unknown Agent, unavailable Agent, or no matching capability exits nonzero with a clear error.
- `task:verdict --run <id> --action passed|rejected|rework --reviewer <id> [--note text]` calls `submitVerdict`.
- `audit` prints `integrityCheck()` and exits nonzero when `ok:false`.
- Every command closes the bus in `finally`; no timer-based forced exit.

Follow TDD. The CLI smoke test must use `spawnSync(process.execPath, ['awb.mjs', ...])` with `cwd` set to the workbench directory and a unique temporary `AWB_STORE`.

Test flow:
1. `agents:list` exits 0 and stdout contains `echo-test` and `available`.
2. Create a task; parse the task ID from `[ok] task created: ...`.
3. In a new CLI process dispatch with `--agent echo-test`; assert exit 0 and stdout contains `"state": "completed"`.
4. Read `<store>/eventbus/bus.jsonl`; assert one `task.created` and ordered Echo `run.started`, `run.thinking`, `run.stdout`, `run.completed` for the returned Run.
5. Run `replay`; assert it reports one task and one Run.
6. Run `audit`; assert exit 0 and `"ok": true`.

Also test an unknown explicit Agent exits nonzero and creates no Run event.

Do not modify core runtime behavior unless a failing CLI test proves a CLI-facing bug and the controller approves it. Do not start a server, open a browser, spawn subagents, or commit.

Run:

```text
node --test test/cli-smoke.test.mjs
node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs test/replay.test.mjs test/verdict.test.mjs test/cli-smoke.test.mjs
node --check awb.mjs
```

Write report to `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-6-report.md` with RED/GREEN evidence, changed files, exact results, concerns.
