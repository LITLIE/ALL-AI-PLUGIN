import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './helpers.mjs';

test('failed attempts retry as immutable linked Runs and finish on success', async () => {
  const { bus, orchestrator } = await createRuntime();
  const adapter = { id: 'retry-fixture' };
  let calls = 0;
  adapter.run = async function* ({ taskId, runId }) {
    const attempt = calls++;
    yield { type: 'run.started', taskId, runId, ts: Date.now() };
    if (attempt < 2) {
      yield { type: 'run.failed', taskId, runId, error: `fixture failure ${attempt}`, ts: Date.now() };
      return;
    }
    yield { type: 'run.completed', taskId, runId, text: 'success', cost: 1, ts: Date.now() };
  };

  try {
    orchestrator.registry.agents.get('echo-test').adapterInstance = adapter;
    const task = await orchestrator.createTask({
      taskId: 'task-retry', description: 'retry me', requiredTags: ['read'],
      maxRetries: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 2,
    });
    const first = await orchestrator.dispatch(task.taskId, 'echo-test', 'retry me');
    const finalRun = await orchestrator.waitForRun(first.runId);

    assert.equal(calls, 3);
    assert.equal(orchestrator.runs.size, 3);
    assert.equal(task.assignedRuns.length, 3);
    assert.equal(finalRun.state, 'completed');
    assert.equal(task.state, 'awaiting-review');
    const runs = task.assignedRuns.map(runId => orchestrator.runs.get(runId));
    assert.deepEqual(runs.map(run => run.retryOf), [null, runs[0].runId, runs[1].runId]);
    assert.deepEqual(runs.map(run => run.retryCount), [0, 1, 2]);

    const events = await bus.readAll();
    const retries = events.filter(event => event.taskId === task.taskId && event.payload?.type === 'run.retry.scheduled');
    assert.equal(retries.length, 2);
    assert.deepEqual(retries.map(event => event.payload.retryCount), [1, 2]);
  } finally {
    delete orchestrator.registry.agents.get('echo-test').adapterInstance;
    await bus.close();
  }
});

test('interrupted runs do not retry and retry exhaustion leaves task failed', async () => {
  const { bus, orchestrator } = await createRuntime();
  const adapter = { id: 'retry-exhausted-fixture' };
  let calls = 0;
  adapter.run = async function* ({ taskId, runId }) {
    calls += 1;
    yield { type: 'run.started', taskId, runId, ts: Date.now() };
    yield { type: 'run.failed', taskId, runId, error: 'always fails', ts: Date.now() };
  };
  try {
    orchestrator.registry.agents.get('echo-test').adapterInstance = adapter;
    const task = await orchestrator.createTask({
      taskId: 'task-retry-exhausted', description: 'fail', requiredTags: ['read'],
      maxRetries: 1, retryBaseDelayMs: 1,
    });
    const first = await orchestrator.dispatch(task.taskId, 'echo-test', 'fail');
    const finalRun = await orchestrator.waitForRun(first.runId);
    assert.equal(calls, 2);
    assert.equal(finalRun.state, 'failed');
    assert.equal(task.state, 'failed');
  } finally {
    delete orchestrator.registry.agents.get('echo-test').adapterInstance;
    await bus.close();
  }
});
