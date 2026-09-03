import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import adapter from '../adapters/claude-stream-json.mjs';

const fixture = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));

test('Claude adapter bridges stream-json into one ordered terminal run', async () => {
  const events = [];
  const stream = adapter.run({
    taskId: 'task-claude', runId: 'run-claude', prompt: 'hello', cwd: dirname(fixture), timeoutMs: 5000,
    agentConfig: { id: 'fixture-claude', type: 'claude-stream-json', command: process.execPath, args: [fixture], inputProtocol: 'stdin' },
  });
  for await (const event of stream) events.push(event);
  const types = events.map(event => event.type);
  assert.equal(types.filter(type => type === 'run.started').length, 1);
  assert.equal(types.filter(type => type === 'run.completed').length, 1);
  assert.ok(types.includes('run.init'));
  assert.ok(types.includes('run.stdout'));
  assert.equal(types.filter(type => ['run.completed', 'run.failed', 'run.timeout', 'run.interrupted'].includes(type)).length, 1);
  assert.equal(events.at(-1).text, 'echo:hello');
});
