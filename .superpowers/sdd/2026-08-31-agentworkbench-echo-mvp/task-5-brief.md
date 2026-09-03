# Task 5: Implement Maker-Checker Verdicts

Read this first — it is your complete requirements.

Modify/create only:
- Modify `workbench/core/orchestrator.mjs`
- Create `workbench/test/verdict.test.mjs`

Required interface:
- `submitVerdict(runId, verdict, reviewerId, reason)` returns `{ ok: boolean, reason?: string }`.
- Supported verdicts are exactly `passed`, `rejected`, and `rework`.
- Unknown verdicts must throw a clear error and persist nothing.

Follow TDD. Add tests for:

```js
test('maker cannot review its own run', async () => {
  const { orchestrator, bus } = await completedEchoRuntime();
  const run = [...orchestrator.runs.values()][0];
  const before = orchestrator.tasks.get(run.taskId).state;
  const result = await orchestrator.submitVerdict(run.runId, 'passed', run.agentId, 'self review');
  assert.equal(result.ok, false);
  assert.equal(orchestrator.tasks.get(run.taskId).state, before);
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

Also cover:
- `rejected` and `rework` task states.
- unsupported verdict rejects before mutation/persistence.
- replay after an accepted verdict restores task state, run verdict, reviewer ID, reason, and verdict timestamp.

Event requirements:
- A maker-checker violation appends one audit event but does not mutate Run verdict or task success state. Use payload `{ type: 'verdict.denied', runId, attemptedVerdict, reviewerId, reason: 'maker-checker violation' }` and top-level `runId`, `taskId`, `agentId: reviewerId`.
- An accepted verdict appends exactly one event with payload `{ type: 'verdict.<verdict>', runId, verdict, reviewerId, reason, verdictAt }` and matching top-level metadata.
- Replay folds only accepted `verdict.passed`, `verdict.rejected`, and `verdict.rework`; it ignores `verdict.denied` for state mutation.
- The task must already be `awaiting-review` before an accepted verdict; otherwise return `{ok:false, reason:'run is not awaiting review'}` without persistence.

Keep other Orchestrator behavior unchanged. Do not implement apply/rollback or reviewer Agent execution.

Run:

```text
node --test test/verdict.test.mjs
node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs test/replay.test.mjs test/verdict.test.mjs
node --check core/orchestrator.mjs
```

Write report to `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-5-report.md` with RED/GREEN evidence, changed files, exact results, concerns. Do not spawn subagents or commit.
