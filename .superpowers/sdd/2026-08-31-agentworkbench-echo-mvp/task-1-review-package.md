# Review package: Task 1

Git base/head: unavailable because `D:\Agentplugin` is not a Git repository.

## Changed files

### `workbench/package.json`

```json
{
  "name": "agent-workbench",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Local AI Agent orchestration workbench — event-sourced, maker-checker gated, auditable.",
  "bin": { "awb": "./awb.mjs" },
  "scripts": {
    "test": "node --test",
    "start": "node awb.mjs serve",
    "serve": "node awb.mjs serve",
    "agents:list": "node awb.mjs agents:list",
    "task:create": "node awb.mjs task:create",
    "task:dispatch": "node awb.mjs task:dispatch",
    "task:verdict": "node awb.mjs task:verdict"
  },
  "engines": { "node": ">=22.0.0" },
  "dependencies": {},
  "devDependencies": {}
}
```

### `workbench/test/helpers.mjs`

```js
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempWorkspace() {
  return mkdtemp(join(tmpdir(), 'agent-workbench-'));
}

export async function createRuntime() {
  throw new Error('createRuntime test fixture is not implemented yet');
}

export async function completedEchoRuntime() {
  throw new Error('completedEchoRuntime test fixture is not implemented yet');
}
```

### `workbench/test/registry.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../core/registry.mjs';
import { fileURLToPath } from 'node:url';

test('registry loads echo config in ESM runtime', () => {
  const registry = new AgentRegistry(fileURLToPath(new URL('../agents', import.meta.url)));
  registry.load();
  assert.equal(registry.agents.has('echo-test'), true);
});
```

### `workbench/test/bus.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/bus.mjs';
import { tempWorkspace } from './helpers.mjs';

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

## Implementer report

See `task-1-report.md`.

