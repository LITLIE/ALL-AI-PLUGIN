# Task 1: Establish the Test Harness and Reproduce Current Failures

Read this file first; it is the complete requirements for this task.

Files:
- Create `workbench/test/helpers.mjs`.
- Create `workbench/test/registry.test.mjs`.
- Create `workbench/test/bus.test.mjs`.
- Modify `workbench/package.json`.

Implement only the test harness and baseline tests. Do not fix production code in this task.

Required helper exports:
- `tempWorkspace()` creates a unique directory under `node:os.tmpdir()` and returns its filesystem path.
- `createRuntime()` and `completedEchoRuntime()` may be stubs only if needed for later tests; define their intended export surface without adding production behavior.

Add the npm script `test: "node --test"` and no dependencies.

Tests must include:

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

Run `npm test` after adding the tests. The expected result is failure at the known `require is not defined` registry boundary; do not hide or alter that failure. Run `git status --short` only to record that this workspace has no Git repository; do not initialize Git, delete files, or commit.

Write a report to `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-1-report.md` containing:
- status DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED;
- changed files;
- exact test command and outcome;
- concerns, if any.

Do not spawn subagents or reviewers. Do not commit because the repository has no `.git`.
