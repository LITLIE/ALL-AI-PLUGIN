import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './helpers.mjs';
import { loadAdapter } from '../adapters/index.mjs';
import { EventBus } from '../core/bus.mjs';
import { AgentRegistry } from '../core/registry.mjs';
import { Orchestrator } from '../core/orchestrator.mjs';

test('echo dispatch reaches awaiting-review and writes ordered run events', async () => {
  const { bus, orchestrator } = await createRuntime();
  const task = await orchestrator.createTask({ taskId: 'task-echo', description: 'ping', requiredTags: ['read'] });
  const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'ping');
  await orchestrator.waitForRun(run.runId);
  const events = await bus.readAll();
  assert.deepEqual(events.filter(e => e.kind === 'run' && e.runId === run.runId).map(e => e.payload?.type), [
    'run.created', 'run.snapshot.created', 'run.started', 'run.thinking', 'run.stdout', 'run.completed', 'run.snapshot.created', 'run.diff.created'
  ]);
  assert.equal(orchestrator.tasks.get(task.taskId).state, 'awaiting-review');
  await bus.close();
});

test('configured non-Echo agents remain visible and can be selected', async () => {
  const { bus, registry, orchestrator } = await createRuntime();
  const bridge = registry.listAll().find(agent => agent.id === 'trae-solo-bridge');
  assert.equal(bridge?.probe?.ok, true);

  const task = await orchestrator.createTask({
    taskId: 'task-non-echo',
    description: 'must stay inside Echo MVP',
    requiredTags: ['design'],
  });
  const automatic = orchestrator.selectAgent(task);

  assert.equal(automatic.ok, true);
  assert.notEqual(automatic.agent.id, 'echo-test');
  assert.ok((automatic.agent.capabilityTags || []).includes('design'));
  await bus.close();
});

test('Claude and Codex fixtures run through the same orchestrator lifecycle', async () => {
  const agentsDir = await mkdtemp(join(tmpdir(), 'awb-integration-agents-'));
  const claudeFixture = new URL('../fixtures/fake-claude.mjs', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\');
  const codexFixture = new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\');
  const config = (id, type, fixture, inputProtocol) => ({ id, displayName: id, type, outputProtocol: type === 'codex-app-server' ? 'native-jsonrpc' : 'stream-json', riskLevel: 'read-only', command: process.execPath, args: [fixture], inputProtocol, capabilityTags: ['read'], healthCheck: { command: process.execPath, args: ['-e', 'process.stdout.write("ok")'] } });
  await writeFile(join(agentsDir, 'claude.json'), JSON.stringify(config('fixture-claude', 'claude-stream-json', claudeFixture, 'stdin')));
  await writeFile(join(agentsDir, 'codex.json'), JSON.stringify(config('fixture-codex', 'codex-app-server', codexFixture)));
  const storeDir = await mkdtemp(join(tmpdir(), 'awb-integration-store-'));
  const bus = new EventBus(join(storeDir, 'eventbus')); await bus.init();
  const registry = new AgentRegistry(agentsDir); registry.load(); await registry.probeAll();
  const orchestrator = new Orchestrator(bus, registry);
  for (const [taskId, agentId] of [['task-claude-fixture', 'fixture-claude'], ['task-codex-fixture', 'fixture-codex']]) {
    const task = await orchestrator.createTask({ taskId, description: 'fixture', requiredTags: ['read'] });
    const run = await orchestrator.dispatch(task.taskId, agentId, 'hello');
    await orchestrator.waitForRun(run.runId);
    assert.equal(run.state, 'completed');
    assert.equal(task.state, 'awaiting-review');
    const terminal = (await bus.readAll()).filter(event => event.runId === run.runId && ['run.completed', 'run.failed', 'run.timeout', 'run.interrupted'].includes(event.payload?.type));
    assert.equal(terminal.length, 1);
  }
  await bus.close();
});

test('unavailable Echo is rejected before a Run is created', async () => {
  const { bus, registry, orchestrator } = await createRuntime();
  registry._probed.set('echo-test', { ok: false, error: 'forced unavailable' });
  const task = await orchestrator.createTask({ taskId: 'task-unavailable-echo', description: 'must not run' });
  const before = await bus.readAll();

  await assert.rejects(
    () => orchestrator.dispatch(task.taskId, 'echo-test', 'ping'),
    /unavailable|not executable/i,
  );

  assert.equal(orchestrator.runs.size, 0);
  assert.deepEqual(await bus.readAll(), before);
  await bus.close();
});

test('stream ending without terminal event is persisted as one failed event', async () => {
  const { bus, registry, orchestrator } = await createRuntime();
  const adapter = await loadAdapter(registry.agents.get('echo-test'));
  const originalRun = adapter.run;
  adapter.run = async function* () {};

  try {
    const task = await orchestrator.createTask({ taskId: 'task-empty-stream', description: 'empty stream' });
    const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'ping');
    const terminalRun = await orchestrator.waitForRun(run.runId);
    const events = await bus.readAll();
    const failures = events.filter(e => e.runId === run.runId && e.payload?.type === 'run.failed');

    assert.equal(terminalRun.state, 'failed');
    assert.equal(orchestrator.tasks.get(task.taskId).state, 'failed');
    assert.equal(failures.length, 1);
    assert.match(failures[0].payload.error, /terminal event/);
  } finally {
    adapter.run = originalRun;
    await bus.close();
  }
});

test('interrupt aborts the active adapter and prevents a later completion', async () => {
  const { bus, registry, orchestrator } = await createRuntime();
  const adapter = await loadAdapter(registry.agents.get('echo-test'));
  const originalRun = adapter.run;
  const originalInterrupt = adapter.interrupt;
  let runSignal;
  let interruptContext;

  adapter.run = async function* ({ taskId, runId, signal }) {
    runSignal = signal;
    yield { type: 'run.started', taskId, runId, ts: 100 };
    yield { type: 'run.thinking', taskId, runId, text: 'waiting for interrupt' };
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'run.completed', taskId, runId, text: 'must not persist', ts: 200 };
  };
  adapter.interrupt = async context => {
    interruptContext = context;
    return { ok: true };
  };

  try {
    const task = await orchestrator.createTask({ taskId: 'task-interrupt', description: 'stop me', requiredTags: ['read'] });
    const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'stop me');

    for (let attempt = 0; attempt < 2000; attempt++) {
      const thinking = (await bus.readAll()).some(event => event.runId === run.runId && event.payload?.type === 'run.thinking');
      if (thinking) break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }

    assert.deepEqual(await orchestrator.interrupt(run.runId), { ok: true });
    const terminal = await orchestrator.waitForRun(run.runId);
    const eventTypes = (await bus.readAll())
      .filter(event => event.kind === 'run' && event.runId === run.runId)
      .map(event => event.payload?.type);

    assert.equal(runSignal?.aborted, true);
    assert.deepEqual(interruptContext, {
      runId: run.runId,
      taskId: run.taskId,
      agentId: run.agentId,
      signal: runSignal,
    });
    assert.equal(terminal.state, 'interrupted');
    assert.equal(orchestrator.tasks.get(task.taskId).state, 'interrupted');
    assert.deepEqual(eventTypes, ['run.created', 'run.snapshot.created', 'run.started', 'run.thinking', 'run.interrupted', 'run.snapshot.created', 'run.diff.created']);
  } finally {
    adapter.run = originalRun;
    adapter.interrupt = originalInterrupt;
    await bus.close();
  }
});

test('apply and rollback require the new M4 lifecycle prerequisites', async () => {
  const { bus, orchestrator } = await createRuntime();
  const task = await orchestrator.createTask({ taskId: 'task-deferred', description: 'no mutations', requiredTags: ['read'] });
  const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'no mutations');
  await orchestrator.waitForRun(run.runId);
  const before = await bus.readAll();

  assert.deepEqual(await orchestrator.apply(run.runId), { ok: false, status: 409, error: 'verdict_required' });
  assert.deepEqual(await orchestrator.rollback(run.runId), { ok: false, status: 409, error: 'not_applied' });
  assert.deepEqual((await bus.readAll()).filter(event => event.seq <= before.at(-1).seq), before);
  await bus.close();
});

test('run executes in an isolated sandbox and applies only after passed verdict', async () => {
  const target = await mkdtemp(join(tmpdir(), 'awb-target-'));
  await writeFile(join(target, 'note.txt'), 'before');
  const { bus, registry, orchestrator, storeDir } = await createRuntime();
  const adapter = await loadAdapter({ type: 'echo' });
  const originalRun = adapter.run;
  adapter.run = async function* (options) {
    yield { type: 'run.started', taskId: options.taskId, runId: options.runId, ts: Date.now() };
    await writeFile(join(options.cwd, 'note.txt'), 'after');
    yield { type: 'run.completed', taskId: options.taskId, runId: options.runId, text: 'changed', ts: Date.now() };
  };
  try {
    const task = await orchestrator.createTask({ taskId: 'task-sandbox', description: 'sandbox', requiredTags: ['read'], cwd: target });
    const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'change');
    await orchestrator.waitForRun(run.runId);
    assert.equal(await readFile(join(target, 'note.txt'), 'utf8'), 'before');
    assert.equal(run.diff.modified[0].relPath, 'note.txt');
    assert.equal(run.executionCwd.includes(storeDir), true);
    assert.deepEqual(await orchestrator.apply(run.runId), { ok: false, status: 409, error: 'verdict_required' });
    assert.deepEqual(await orchestrator.submitVerdict(run.runId, 'passed', 'human'), { ok: true });
    const applied = await orchestrator.apply(run.runId);
    assert.equal(applied.ok, true);
    assert.equal(await readFile(join(target, 'note.txt'), 'utf8'), 'after');
    const rolledBack = await orchestrator.rollback(run.runId);
    assert.equal(rolledBack.ok, true);
    assert.equal(await readFile(join(target, 'note.txt'), 'utf8'), 'before');
  } finally {
    adapter.run = originalRun;
    await bus.close();
  }
});

test('apply detects target changes after the run and writes no partial files', async () => {
  const target = await mkdtemp(join(tmpdir(), 'awb-target-conflict-'));
  await writeFile(join(target, 'note.txt'), 'before');
  const { bus, orchestrator } = await createRuntime();
  const adapter = await loadAdapter({ type: 'echo' });
  const originalRun = adapter.run;
  adapter.run = async function* (options) {
    yield { type: 'run.started', taskId: options.taskId, runId: options.runId, ts: Date.now() };
    await writeFile(join(options.cwd, 'note.txt'), 'after');
    yield { type: 'run.completed', taskId: options.taskId, runId: options.runId, text: 'changed', ts: Date.now() };
  };
  try {
    const task = await orchestrator.createTask({ taskId: 'task-conflict', description: 'conflict', requiredTags: ['read'], cwd: target });
    const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'change');
    await orchestrator.waitForRun(run.runId);
    await orchestrator.submitVerdict(run.runId, 'passed', 'human');
    await writeFile(join(target, 'note.txt'), 'external');
    assert.deepEqual(await orchestrator.apply(run.runId), { ok: false, status: 409, error: 'target_conflict' });
    assert.equal(await readFile(join(target, 'note.txt'), 'utf8'), 'external');
  } finally {
    adapter.run = originalRun;
    await bus.close();
  }
});
