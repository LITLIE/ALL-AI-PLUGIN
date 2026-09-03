# Task 2: Make Core Utilities and Registry ESM-Safe

Read this file first — it is your complete requirements.

Modify only:
- `workbench/core/registry.mjs`
- `workbench/core/utils.mjs`
- `workbench/core/spawn-helper.mjs`
- `workbench/test/registry.test.mjs`

Keep these interfaces stable:
- `AgentRegistry.load()` is synchronous and accepts a filesystem string path.
- `AgentRegistry.probeAll()` returns a map keyed by Agent ID and stores probe results.
- `spawnPlan`, `findInPath`, `killProcessTree`, and `makeSnapshot` remain exported under those names.

Follow TDD. First add this failing test to `workbench/test/registry.test.mjs` and run it:

```js
test('echo probe is available and type is resolved', async () => {
  const registry = new AgentRegistry(fileURLToPath(new URL('../agents', import.meta.url)));
  registry.load();
  const results = await registry.probeAll();
  assert.equal(results['echo-test'].ok, true);
});
```

Then fix the production loading errors with minimal changes:
- Replace every CommonJS `require` in the three core files with ESM-compatible imports.
- In `spawn-helper.mjs`, avoid the imported `spawnSync` colliding with the exported wrapper named `spawnSync`; alias one of them.
- Preserve behavior and exported function names; do not refactor unrelated logic.
- Do not modify adapter loading or Orchestrator behavior yet; those belong to Task 3.

Run and report:

```text
node --test test/registry.test.mjs
node --check core/registry.mjs
node --check core/utils.mjs
node --check core/spawn-helper.mjs
```

Expected final result for this task: all focused tests and syntax checks pass. Do not run or modify Git state, do not spawn subagents, and do not commit because the workspace has no `.git`.

Write the report to `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-2-report.md` with status, changed files, exact test outcomes, and concerns.
