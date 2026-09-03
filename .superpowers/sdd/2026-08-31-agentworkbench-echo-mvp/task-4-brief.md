# Task 4: Harden Event Integrity and Replay

Read this first — it is your complete requirements.

Modify/create only:
- Modify `workbench/core/bus.mjs`
- Modify `workbench/core/orchestrator.mjs`
- Modify `workbench/test/helpers.mjs` only if an isolated-store option is needed
- Create `workbench/test/replay.test.mjs`

Existing event shape is `{ ts, seq, kind, ...meta, payload }`, so `taskId`, `runId`, and `agentId` are top-level event fields. Preserve this phase's actual format.

Required interfaces:
- `EventBus.readAll()` returns parsed valid events only when the file is valid; it must not silently filter malformed lines. Choose one clear failure contract: throw an Error with line details on corruption.
- `EventBus.integrityCheck()` returns `{ ok, totalLines, errors? }` and reports invalid JSON plus sequence gaps.
- `EventBus.readFrom(seq)` returns events whose `event.seq >= seq`, preserving the existing inclusive behavior used by CLI for now.
- `Orchestrator.replay()` clears current in-memory maps and rebuilds tasks and runs from persisted events.

Follow TDD. Add tests that fail first:

```js
test('integrity detects a seq gap and malformed line', async () => {
  const dir = await tempWorkspace();
  const file = join(dir, 'bus.jsonl');
  await writeFile(file, '{"seq":1,"kind":"system","payload":{}}\n{"seq":3,"kind":"system","payload":{}}\nnot-json\n');
  const bus = new EventBus(dir);
  const report = await bus.integrityCheck();
  assert.equal(report.ok, false);
  assert.deepEqual(report.errors.map(e => e.error), ['seq_gap', 'invalid_json']);
  await assert.rejects(() => bus.readAll(), /line 3/i);
});

test('replay restores completed Echo task and run', async () => {
  const first = await createRuntime();
  const task = await first.orchestrator.createTask({ taskId: 'task-replay', description: 'ping', requiredTags: ['read'] });
  const run = await first.orchestrator.dispatch(task.taskId, 'echo-test', 'ping');
  await first.orchestrator.waitForRun(run.runId);
  await first.bus.close();

  const second = await createRuntime({ storeDir: first.storeDir });
  await second.orchestrator.replay();
  assert.equal(second.orchestrator.tasks.get('task-replay').state, 'awaiting-review');
  assert.equal(second.orchestrator.runs.get(run.runId).state, 'completed');
  assert.equal(second.orchestrator.runs.get(run.runId).agentId, 'echo-test');
  await second.bus.close();
});
```

Replay folding requirements:
- `task.created`: restore the full task snapshot and its `assignedRuns` array.
- First run event: create a Run with `runId`, `taskId`, `agentId`, state `running`, and add the Run ID to the task only once.
- `run.started` keeps running.
- `run.completed` restores Run state `completed`, result text/cost/duration where present, and task state `awaiting-review`.
- `run.failed`, `run.timeout`, and `run.interrupted` restore matching terminal state and task failure/timeout state.
- Verdict folding can be implemented now only if straightforward, but Task 5 owns verdict normalization; do not redesign verdict events here.
- Do not use `ev.meta`; current metadata is top-level.

Bus integrity requirements:
- Physical non-empty line N must contain `seq === N`.
- Invalid JSON and each seq gap are accumulated in `errors` in line order.
- `init()` must derive the next append sequence from validated existing events. If the existing bus is corrupt, initialization must fail rather than append after corruption.
- Keep recursive redaction and append behavior for valid stores.

Run:

```text
node --test test/replay.test.mjs
node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs test/replay.test.mjs
node --check core/bus.mjs
node --check core/orchestrator.mjs
```

Write report to `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-4-report.md` with RED/GREEN evidence, changed files, exact verification, concerns. Do not spawn subagents or commit.
