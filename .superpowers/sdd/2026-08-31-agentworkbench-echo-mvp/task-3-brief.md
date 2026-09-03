# Task 3: Unify Adapter Loading and Fix Echo Execution

Read this first — it is your complete requirements.

Modify/create only:
- Modify `workbench/adapters/index.mjs`
- Modify `workbench/adapters/echo.mjs`
- Modify `workbench/core/orchestrator.mjs`
- Modify `workbench/test/helpers.mjs`
- Create `workbench/test/orchestrator.test.mjs`

Existing interface decision from Task 2:
- Registry configs use `agent.type` as the adapter key.
- `registry.probeAll()` isolates broken non-Echo adapters and records their health failures.

Required production interfaces:
- `loadAdapter(agentConfig)` accepts a full Agent config object and resolves `agentConfig.type`.
- `Orchestrator.dispatch(taskId, agentId, prompt)` returns a Run with `{ runId, taskId, agentId, state }`.
- `Orchestrator.waitForRun(runId)` resolves to the terminal Run.
- `Orchestrator` must persist each yielded Echo event exactly once.

Required test helper interfaces:
- `createRuntime(options?)` creates an isolated temp EventBus, loads `workbench/agents`, probes the registry, creates an Orchestrator, and returns `{ storeDir, bus, registry, orchestrator }`.
- `completedEchoRuntime()` uses `createRuntime()`, creates and completes one Echo task, and returns the same runtime object.

Follow TDD. Write and watch this test fail before production edits:

```js
test('echo dispatch reaches awaiting-review and writes ordered run events', async () => {
  const { bus, orchestrator } = await createRuntime();
  const task = await orchestrator.createTask({ taskId: 'task-echo', description: 'ping', requiredTags: ['read'] });
  const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'ping');
  await orchestrator.waitForRun(run.runId);
  const events = await bus.readAll();
  assert.deepEqual(events.filter(e => e.runId === run.runId).map(e => e.payload?.type), [
    'run.started', 'run.thinking', 'run.stdout', 'run.completed'
  ]);
  assert.equal(orchestrator.tasks.get(task.taskId).state, 'awaiting-review');
  await bus.close();
});
```

Note: the current `EventBus.append()` flattens meta fields onto the event (`runId`, `taskId`, `agentId`) rather than nesting `meta`; use the actual current format for this phase. Do not redesign EventBus format in Task 3.

Implementation requirements:
- Adapter loader maps the full config's `type` to the existing module table. Cache safely; Echo may remain a singleton because it is stateless.
- Orchestrator obtains the Agent config from `registry.agents.get(run.agentId)` and passes it to `loadAdapter()`.
- `_executeRun` must be a normal async method returning a promise, not an async generator that is never consumed.
- Store its promise in `_running`, remove it when settled, and implement `waitForRun`.
- Do not add automatic retry behavior in this phase. Do not modify real Claude/Codex adapters.
- Echo should yield the four expected events in order. Keep the delay short enough for tests (prefer <=20 ms).

Run:

```text
node --test test/orchestrator.test.mjs
node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs
node --check adapters/index.mjs
node --check adapters/echo.mjs
node --check core/orchestrator.mjs
```

Write report to `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-3-report.md` including RED/GREEN evidence, changed files, exact results, concerns. Do not spawn subagents or commit.
