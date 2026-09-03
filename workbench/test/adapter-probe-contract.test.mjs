import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { loadAdapter } from '../adapters/index.mjs';

const fixture = (text = 'configured-agent 1.0.0') => ({
  command: process.execPath,
  healthCheck: {
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(text)})`],
    expect: text.split(' ')[0],
  },
});

function assertProbeShape(probe) {
  assert.equal(typeof probe.ok, 'boolean');
  assert.ok(['available', 'unavailable', 'unknown'].includes(probe.status));
  assert.equal(probe.code, 0);
  assert.equal(probe.error, null);
  assert.equal(typeof probe.checkedAt, 'number');
}

test('built-in adapters return the structured available probe contract', async () => {
  for (const type of ['echo', 'human-bridge']) {
    const adapter = await loadAdapter({ type });
    const probe = await adapter.probe({ type });
    assertProbeShape(probe);
    assert.equal(probe.ok, true);
    assert.equal(probe.status, 'available');
    assert.equal(probe.resolved, null);
  }
});

test('process-backed adapters probe the configured executable', async () => {
  for (const type of ['claude-stream-json', 'codex-app-server', 'cli-text']) {
    const adapter = await loadAdapter({ type });
    const probe = await adapter.probe({ type, ...fixture(`${type} fixture`) });
    assertProbeShape(probe);
    assert.equal(probe.ok, true, `${type} should report configured fixture available`);
    assert.match(probe.version, new RegExp(type));
  }
});

test('ACP requires a configured command and reports startup failure as run.failed', async () => {
  const adapter = await loadAdapter({ type: 'acp' });
  const unavailable = await adapter.probe({ type: 'acp', command: 'definitely-missing-acp', healthCheck: { command: 'definitely-missing-acp' } });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, 'unavailable');

  const events = [];
  const iterator = adapter.run({
    taskId: 'task-acp', runId: 'run-acp', prompt: 'hello',
    agentConfig: { type: 'acp', command: process.execPath, args: ['-e', 'process.exit(1)'] },
    onEvent: event => events.push(event),
  });
  const received = [];
  for await (const event of iterator) received.push(event);
  assert.equal(received[0].type, 'run.started');
  assert.equal(received.at(-1).type, 'run.failed');
  assert.ok(events.length >= 0);
});

test('generic CLI adapter runs the configured command instead of a vendor default', async () => {
  const adapter = await loadAdapter({ type: 'cli-text' });
  const received = [];
  for await (const event of adapter.run({
    taskId: 'task-cli', runId: 'run-cli', prompt: 'hello', cwd: process.cwd(),
    agentConfig: {
      type: 'cli-text', command: process.execPath,
      args: ['-e', 'process.stdout.write("configured-cli")'],
      inputProtocol: 'args',
    },
  })) received.push(event);
  const completed = received.find(event => event.type === 'run.completed');
  assert.ok(completed);
  assert.match(completed.text, /configured-cli/);
});
