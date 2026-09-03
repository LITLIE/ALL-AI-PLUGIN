import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, tempWorkspace } from './helpers.mjs';

test('orchestrator watchdog times out a stuck adapter and invokes terminate once', async () => {
  const { bus, orchestrator } = await createRuntime();
  const adapter = { id: 'watchdog-fixture' };
  let interruptCalls = 0;
  let terminateCalls = 0;
  adapter.run = async function* ({ taskId, runId }) {
    yield { type: 'run.started', taskId, runId, ts: Date.now() };
    await new Promise(resolve => setTimeout(resolve, 500));
  };
  adapter.interrupt = async () => { interruptCalls += 1; return { ok: true }; };
  adapter.terminate = async () => { terminateCalls += 1; return { ok: true, termination: 'fixture' }; };

  try {
    orchestrator.registry.agents.get('echo-test').adapterInstance = adapter;
    const task = await orchestrator.createTask({
      taskId: 'task-watchdog', description: 'hang', requiredTags: ['read'],
      cwd: await tempWorkspace(),
      timeoutMs: 20, interruptGraceMs: 5, maxRetries: 0,
    });
    const startedAt = Date.now();
    const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'hang');
    const terminal = await orchestrator.waitForRun(run.runId);
    const elapsed = Date.now() - startedAt;
    const events = (await bus.readAll()).filter(event => event.runId === run.runId);
    const terminalEvents = events.filter(event => ['run.completed', 'run.failed', 'run.timeout', 'run.interrupted'].includes(event.payload?.type));

    assert.equal(terminal.state, 'timeout');
    assert.ok(elapsed < 1000, `watchdog took ${elapsed}ms`);
    assert.equal(interruptCalls, 1);
    assert.equal(terminateCalls, 1);
    assert.equal(events.filter(event => event.payload?.type === 'run.timeout.requested').length, 1);
    assert.equal(events.filter(event => event.payload?.type === 'run.terminated').length, 1);
    assert.equal(terminalEvents.length, 1);
    assert.equal(terminalEvents[0].payload.type, 'run.timeout');
  } finally {
    delete orchestrator.registry.agents.get('echo-test').adapterInstance;
    await bus.close();
  }
});
